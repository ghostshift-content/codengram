// codengram local server — the portal (BLUEPRINT §7). Zero-dependency node:http. Binds loopback only.
// Serves the API (projects, brain, features, coverage, ask) + SSE recon progress + the single-file UI.
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fork, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { listProjects, getProject, listSnapshots, createProject } from '../../packages/ingestion/index.js'
import { latestPublished, newMissionId } from '../../packages/recon/index.js'
import { openGraph, nodesByType, neighbourhood, counts, claimsForNode } from '../../packages/graph/index.js'
import { getContextBundle, answer, AI_PREAMBLE } from '../../packages/retrieval/index.js'
import { isAvailable, askClaude, isReconQuestion } from '../../packages/claude-runtime/index.js'
import { runDoctor, printDoctor } from '../../packages/doctor/index.js'
import { renderFeatureMarkdown } from '../../packages/markdown-renderer/index.js'
import { hostOk, originOk } from '../../packages/http-guards/index.js'

const __dir = path.dirname(fileURLToPath(import.meta.url))
const UI = path.join(__dir, 'ui.html')
const sse = new Map()       // projectId -> Set(res)
const missions = new Map()  // projectId -> { events:[{t,label,...}], phase, summary, running }
const dashboardCache = new Map() // immutable publication path + limit -> bounded portal projection
const MAX_ACTIVE_RECONS = Math.max(1, Number(process.env.CODENGRAM_MAX_ACTIVE_RECONS) || 2)
const MAX_SSE_TOTAL = Math.max(1, Number(process.env.CODENGRAM_MAX_SSE_CONNECTIONS) || 32)
const MAX_SSE_PER_PROJECT = Math.max(1, Number(process.env.CODENGRAM_MAX_SSE_PER_PROJECT) || 4)
const SSE_MAX_AGE_MS = Math.max(60_000, Number(process.env.CODENGRAM_SSE_MAX_AGE_MS) || 2 * 60 * 60 * 1000)

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
// #11: bound the request body (reject > 4MB) and surface malformed JSON as an error instead of silently → {}.
const MAX_BODY = 4 * 1024 * 1024
const readBody = (req) => new Promise((resolve, reject) => {
  let b = '', n = 0
  req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('request body too large')); req.destroy(); return } b += c })
  req.on('end', () => { if (!b) return resolve({}); try { resolve(JSON.parse(b)) } catch { reject(new Error('malformed JSON body')) } })
})
const sseCount = () => [...sse.values()].reduce((n, set) => n + set.size, 0)
const activeReconCount = () => [...missions.values()].filter((m) => m.running).length
function emit(pid, ev) {
  const m0 = missions.get(pid)
  const m = m0 || { events: [], running: true }
  if (ev.phase) m.phase = ev.phase
  const progress = missionProgress(m, ev)
  const stamp = { ...ev, t: clock(), mission: ev.mission || m0?.mission, progress,
    mapped_features: m.mapped_features || 0, planned_features: m.planned_features || 0 }
  // Heartbeats can arrive many times per minute. Coalesce identical adjacent activity so they cannot evict the
  // phase changes, worker roster and planning events a reconnecting dashboard needs to rebuild mission state.
  if (ev.kind === 'lead_activity' && m.events[0]?.kind === ev.kind && m.events[0]?.label === ev.label) {
    stamp.repeats = (m.events[0].repeats || 1) + 1
    m.events[0] = stamp
  } else m.events.unshift(stamp)
  if (m.events.length > 60) m.events.pop()
  if (ev.summary) m.summary = ev.summary
  if (ev.phase === 'ready' || ev.phase === 'error') m.running = false
  missions.set(pid, m)
  for (const res of sse.get(pid) || []) res.write(`data: ${JSON.stringify(stamp)}\n\n`)
}
const clock = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}` }

// Progress is pipeline completion, not an elapsed-time guess. Early deterministic phases move the bar before the
// feature count exists; once graph construction starts, mapped/planned features drive the 50–80% interval.
const PHASE_PROGRESS = { start: 1, freeze: 5, profile: 15, inventories: 25, planning: 40, graph: 50, render: 85, seal: 95, done: 99, ready: 100 }
export function missionProgress(state = {}, ev = {}) {
  if (ev.kind === 'features_planned' || ev.kind === 'semantic_plan') state.planned_features = Math.max(0, Number(ev.count) || 0)
  if (ev.kind === 'feature_mapped') state.mapped_features = Math.min(state.planned_features || Infinity, (state.mapped_features || 0) + 1)
  const phase = ev.phase || state.phase || 'start'
  let progress = PHASE_PROGRESS[phase] ?? state.progress ?? 0
  if ((phase === 'graph' || ev.kind === 'feature_mapped') && state.planned_features > 0) {
    progress = 50 + Math.round(Math.min(1, (state.mapped_features || 0) / state.planned_features) * 30)
  }
  state.progress = Math.max(state.progress || 0, Math.min(100, progress))
  return state.progress
}

export async function startServer({ dataRoot, port = 4173 } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const p = url.pathname
    try {
      if (!hostOk(req.headers.host, port)) return json(res, 421, { error: 'invalid Host header' })
      if (req.method !== 'GET' && req.method !== 'HEAD' && !originOk(req.headers.origin, port)) return json(res, 403, { error: 'cross-origin request refused' })
      // ── UI ──
      if (p === '/' || p === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(UI)) }

      // ── meta ──
      if (p === '/api/health') return json(res, 200, { ok: true, ai: await isAvailable() })
      // Diagnostics for the UI. No port check (the server is obviously already listening on it). ?probe=1 also
      // verifies the Claude login (a real round-trip; costs a little quota).
      if (p === '/api/doctor') return json(res, 200, await runDoctor({ dataRoot, probeAi: url.searchParams.get('probe') === '1' }))
      if (p === '/api/projects' && req.method === 'GET') return json(res, 200, { projects: listProjects(dataRoot).map((x) => projectSummary(dataRoot, x)) })
      if (p === '/api/projects' && req.method === 'POST') {
        const { sourceRoot, name } = await readBody(req)
        if (!sourceRoot || !fs.existsSync(path.resolve(sourceRoot))) return json(res, 400, { error: 'sourceRoot does not exist' })
        const project = createProject(dataRoot, path.resolve(sourceRoot), { name })
        return json(res, 200, { project: projectSummary(dataRoot, project) })
      }

      const m = p.match(/^\/api\/projects\/([^/]+)(\/.*)?$/)
      if (m) {
        const project = resolveProject(dataRoot, decodeURIComponent(m[1]))
        if (!project) return json(res, 404, { error: 'unknown project' })
        const sub = m[2] || ''

        // recon (SSE-backed) — runs the deterministic pipeline, streaming real phases
        if (sub === '/recon' && req.method === 'POST') {
          const started = runRecon(dataRoot, project)
          return started.ok ? json(res, 202, { started: true, mission: started.mission })
            : json(res, started.code, { started: false, error: started.error })
        }
        if (sub === '/recon/abort' && req.method === 'POST') {
          const m = missions.get(project.id); if (m) { m.aborted = true; m.running = false; m.child?.kill('SIGTERM') }   // kill the worker
          return json(res, 200, { aborted: true })
        }
        if (sub === '/events') {
          const projectStreams = sse.get(project.id)?.size || 0
          if (sseCount() >= MAX_SSE_TOTAL || projectStreams >= MAX_SSE_PER_PROJECT)
            return json(res, 429, { error: 'event-stream connection limit reached' })
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
          res.write(': connected\n\n')
          // replay the current mission so a late subscriber still sees what already happened
          for (const ev of [...(missions.get(project.id)?.events || [])].reverse()) res.write(`data: ${JSON.stringify(ev)}\n\n`)
          if (!sse.has(project.id)) sse.set(project.id, new Set())
          sse.get(project.id).add(res)
          const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n') }, 15_000)
          const maxAge = setTimeout(() => { if (!res.destroyed) res.end() }, SSE_MAX_AGE_MS)
          const cleanup = () => {
            clearInterval(heartbeat); clearTimeout(maxAge)
            const set = sse.get(project.id); set?.delete(res); if (set?.size === 0) sse.delete(project.id)
          }
          req.on('close', cleanup); res.on('close', cleanup)
          return
        }
        if (sub === '/activity') {
          const live = missions.get(project.id)
          return json(res, 200, { events: live?.events || [], running: !!live?.running, mission: live?.mission || null,
            phase: live?.phase || null, started_at: live?.started_at || null,
            progress: live?.progress || 0, mapped_features: live?.mapped_features || 0, planned_features: live?.planned_features || 0,
            elapsed_seconds: live?.started_at ? Math.floor((Date.now() - live.started_at) / 1000) : null })
        }

        const pubd = latestPublished(dataRoot, project.id)   // only PUBLISHED snapshots are ever served
        if (!pubd && sub !== '/snapshots') return json(res, 200, { empty: true, project: projectSummary(dataRoot, project) })
        if (sub === '/snapshots') return json(res, 200, { snapshots: listSnapshots(dataRoot, project.id) })
        const snap = pubd.snapshot
        const pubRoot = path.dirname(pubd.indexPath)

        if ((sub === '/export/portable' || sub === '/export/full') && req.method === 'GET') {
          const full = sub.endsWith('/full')
          const snapshotRoot = path.dirname(path.dirname(pubRoot))
          const filename = `${project.name}-${full ? 'full-brain' : 'portable-brain'}.tar.gz`.replace(/[^a-zA-Z0-9._-]+/g, '-')
          res.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${filename}"` })
          // Portable is the complete AI-readable projection. Full additionally carries the canonical database and
          // the exact immutable source snapshot its file:line claims resolve against. Do not package project.json:
          // it contains the operator's host path and is not needed to restore or reason over the brain.
          const args = full
            ? ['-czf', '-', '-C', pubRoot, 'phase1-maps', 'index.sqlite', 'mission.json', 'feature-plan.json',
                '-C', snapshotRoot, 'snapshot.json', 'source-manifest.jsonl', 'CURRENT', 'source']
            : ['-czf', '-', '-C', pubRoot, 'phase1-maps']
          const tar = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] })
          tar.stdout.pipe(res)
          tar.stderr.on('data', () => {})
          tar.on('error', () => { if (!res.headersSent) json(res, 500, { error: 'could not package export' }); else res.destroy() })
          tar.on('close', (code) => { if (code !== 0 && !res.destroyed) res.destroy() })
          return
        }

        const db = openGraph(pubd.indexPath)   // the CURRENT publication's index.sqlite (never a half-swapped file)
        try {
          if (sub === '/brain') return json(res, 200, { ...brainOverview(db, { limit: Number(url.searchParams.get('limit') || 400) }), publication: pubd.publication })
          if (sub === '/brain/neighbourhood') return json(res, 200, neighbourhood(db, url.searchParams.get('node'), Number(url.searchParams.get('hops') || 1), 400))
          if (sub === '/features') return json(res, 200, featurePage(db, { q: url.searchParams.get('q') || '', domain: url.searchParams.get('domain') || '',
            limit: Number(url.searchParams.get('limit') || 250), offset: Number(url.searchParams.get('offset') || 0) }))
          const featureExport = sub.match(/^\/features\/([^/]+)\/export$/)
          if (featureExport && req.method === 'GET') {
            const slug = decodeURIComponent(featureExport[1])
            const f = nodesByType(db, 'FEATURE').find((x) => x.data.slug === slug)
            if (!f) return json(res, 404, { error: 'no feature' })
            const source = { dataRoot, projectId: project.id, snapshotId: snap.id }
            const bundle = getContextBundle(db, f.id, { hops: 2, cap: 1000, source })
            const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codengram-feature-'))
            const ledger = path.join(pubRoot, 'phase1-maps', 'ledgers', `${slug}.jsonl`)
            fs.writeFileSync(path.join(tmp, 'AI_CONTEXT.md'), `${AI_PREAMBLE}\n\nOpen README.md first, then feature.md and context.json. Use feature-ledger.jsonl for the exhaustive mapped rows.\n`)
            fs.writeFileSync(path.join(tmp, 'README.md'), `# ${f.name} feature context\n\nThis is a focused, source-grounded Codengram export for **${f.name}**.\n\n- \`feature.md\`: canonical human-readable 13-section map.\n- \`feature-ledger.jsonl\`: exhaustive mapped rows for this feature.\n- \`context.json\`: bounded two-hop graph neighbourhood and frozen-source excerpts.\n- \`AI_CONTEXT.md\`: rules for an AI session consuming this bundle.\n\nThe Markdown and graph context are convenient projections; the JSONL ledger is authoritative for row-level completeness.\n`)
            fs.writeFileSync(path.join(tmp, 'feature.md'), renderFeatureMarkdown(db, f))
            fs.writeFileSync(path.join(tmp, 'context.json'), JSON.stringify(bundle, null, 2))
            if (fs.existsSync(ledger)) fs.copyFileSync(ledger, path.join(tmp, 'feature-ledger.jsonl'))
            else fs.writeFileSync(path.join(tmp, 'feature-ledger.jsonl'), '')
            const filename = `${project.name}-${slug}-feature-context.tar.gz`.replace(/[^a-zA-Z0-9._-]+/g, '-')
            res.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${filename}"` })
            const tar = spawn('tar', ['-czf', '-', '-C', tmp, '.'], { stdio: ['ignore', 'pipe', 'pipe'] })
            let cleaned = false
            const cleanup = () => { if (!cleaned) { cleaned = true; fs.rmSync(tmp, { recursive: true, force: true }) } }
            tar.stdout.pipe(res)
            tar.stderr.on('data', () => {})
            tar.on('error', () => { cleanup(); if (!res.headersSent) json(res, 500, { error: 'could not package feature context' }); else res.destroy() })
            tar.on('close', (code) => { cleanup(); if (code !== 0 && !res.destroyed) res.destroy() })
            return
          }
          if (sub.startsWith('/features/')) { const slug = decodeURIComponent(sub.split('/')[2] || ''); const f = nodesByType(db, 'FEATURE').find((x) => x.data.slug === slug); return f ? json(res, 200, { feature: f, bundle: featureBundle(db, f), markdown: renderFeatureMarkdown(db, f) }) : json(res, 404, { error: 'no feature' }) }
          if (sub === '/coverage') return json(res, 200, coverageView(db))
          if (sub === '/inventory') return json(res, 200, inventoryView(db, { limit: Number(url.searchParams.get('limit') || 300) }))
          if (sub === '/dashboard') {
            const limit = Number(url.searchParams.get('limit') || 500), key = `${pubd.indexPath}:${limit}`
            if (!dashboardCache.has(key)) {
              dashboardCache.set(key, dashboardView(db, { limit }))
              while (dashboardCache.size > 16) dashboardCache.delete(dashboardCache.keys().next().value)
            }
            return json(res, 200, dashboardCache.get(key))
          }
          if (sub === '/ask' && req.method === 'POST') {
            const { question, node } = await readBody(req)
            if (!isReconQuestion(question)) return json(res, 400, { error: 'Codengram is recon-only; security testing and vulnerability questions are outside scope' })
            const source = { dataRoot, projectId: project.id, snapshotId: snap.id }
            // #11: always hand Claude a real bundle. If no node was selected, resolve the best-matching node from the
            // deterministic answer and pack ITS neighbourhood (purpose + facts + citations) — never an empty context.
            const det = answer(db, question, { source })
            let bundle = node ? getContextBundle(db, node, { hops: 1, source }) : null
            if ((!bundle || !bundle.ok) && det.node) bundle = getContextBundle(db, det.node, { hops: 1, source })
            const ai = await askClaude({ preamble: AI_PREAMBLE, question, bundle: (bundle && bundle.ok) ? bundle : { facts: [], citations: det.citations || [] } })
            const selectedNode = bundle?.ok ? bundle.node.id : det.node || node || null
            const citations = bundle?.ok ? bundle.citations.slice(0, 8) : det.citations || []
            return json(res, 200, { answer: ai || det.text, citations, via: ai ? 'claude' : 'deterministic', node: selectedNode })
          }
        } finally { db.close() }
      }
      json(res, 404, { error: 'not found' })
    } catch (e) { json(res, 500, { error: String(e && e.message || e) }) }
  })
  // Preflight BEFORE listening — show any problem up front. Hard failures (Node/SQLite/data/port) block the server.
  const report = await runDoctor({ dataRoot, port })
  printDoctor(report)
  if (!report.ok) { process.exitCode = 1; return null }
  sweepStale(dataRoot)   // remove temp dirs left by a killed/aborted scan
  server.listen(port, '127.0.0.1', () => {
    console.log(`  \x1b[1mcodengram\x1b[0m  →  \x1b[36mhttp://127.0.0.1:${port}\x1b[0m   \x1b[2m(data: ${dataRoot})\x1b[0m\n`)
  })
  return server
}

// Sweep orphaned build/attempt temp dirs (an aborted worker killed mid-freeze can't run its own cleanup).
function sweepStale(dataRoot) {
  try {
    for (const proj of fs.readdirSync(path.join(dataRoot, 'projects'), { withFileTypes: true })) {
      if (!proj.isDirectory()) continue
      const snaps = path.join(dataRoot, 'projects', proj.name, 'snapshots')
      let entries; try { entries = fs.readdirSync(snaps) } catch { continue }
      for (const e of entries) if (e.startsWith('.building-') || e.startsWith('.attempt-')) fs.rmSync(path.join(snaps, e), { recursive: true, force: true })
    }
  } catch {}
}

const WORKER = path.join(__dir, 'recon-worker.js')
// #9: run the scan in a CHILD PROCESS so a large/slow repo (e.g. 100k-file GitLab) never blocks the server's event
// loop — the portal stays responsive and progress is genuinely live (streamed as it happens, not replayed).
function runRecon(dataRoot, project) {
  // #10: one active mission per project — refuse a concurrent recon so two scans can't corrupt the same paths.
  if (missions.get(project.id)?.running) return { ok: false, code: 409, error: 'recon already running for this project' }
  if (activeReconCount() >= MAX_ACTIVE_RECONS) return { ok: false, code: 429, error: 'global recon concurrency limit reached' }
  const mission = newMissionId()
  const child = fork(WORKER, { execArgv: ['--disable-warning=ExperimentalWarning'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  missions.set(project.id, { events: [], running: true, mission, child, started_at: Date.now(), phase: 'start' })
  emit(project.id, { phase: 'start', label: `Recon started · ${project.name}`, mission })
  child.on('message', (m) => {
    if (!m) return
    if (m.type === 'event') emit(project.id, m.ev)
    else if (m.type === 'done') emit(project.id, { phase: 'ready', label: m.summary.reused ? 'Brain ready — source unchanged' : 'Brain ready', mission, summary: m.summary })
    else if (m.type === 'error') emit(project.id, { phase: 'error', label: m.message, mission })
  })
  child.on('exit', (code, sig) => {
    const mm = missions.get(project.id); if (!mm) return
    if (mm.running && !mm.aborted && code !== 0) emit(project.id, { phase: 'error', label: `recon worker exited unexpectedly (${sig || code})`, mission })
    mm.running = false; mm.child = null
  })
  child.on('error', (e) => emit(project.id, { phase: 'error', label: `failed to start recon worker: ${e.message}`, mission }))
  child.send({ type: 'start', dataRoot, projectId: project.id, missionId: mission })
  return { ok: true, mission }
}

const resolveProject = (dataRoot, key) => getProject(dataRoot, key) || listProjects(dataRoot).find((x) => x.id === key || x.name === key || x.id.includes(key))
// A card-ready summary: latest PUBLISHED snapshot's feature count + languages + gate (opens the index briefly).
function projectSummary(dataRoot, p) {
  const pubd = latestPublished(dataRoot, p.id)
  const base = { ...p, source: p.source_root, status: pubd ? 'ready' : 'new', features: pubd?.publication?.features || 0, languages: [], snapshot: pubd?.snapshot?.id || null, gate: pubd?.publication?.gate || null, mission: pubd?.publication?.mission_id || null, updated: p.created_at }
  let db = null
  if (pubd) try {
    db = openGraph(pubd.indexPath)
    const proj = nodesByType(db, 'PROJECT')[0]
    base.languages = proj?.data?.languages || []
    base.cov = base.features > 0 ? 100 : 0
  } catch { /* index unreadable → status stays as-is */ }
  finally { try { db?.close() } catch {} }
  const live = missions.get(p.id)
  if (live?.running) {
    base.status = 'scanning'
    base.cov = live.progress || 0
    base.active_mission = live.mission
    base.runtime = { phase: live.phase || 'start', latest: live.events[0]?.label || 'Starting recon',
      progress: live.progress || 0, mapped_features: live.mapped_features || 0, planned_features: live.planned_features || 0,
      started_at: live.started_at || null, elapsed_seconds: live.started_at ? Math.floor((Date.now() - live.started_at) / 1000) : null }
  }
  return base
}
function brainOverview(db, { limit = 400 } = {}) {
  // default view = domains + features + SHARES edges (L2 connectivity)
  const allFeatures = nodesByType(db, 'FEATURE').sort((a, b) => (b.data.row_count || 0) - (a.data.row_count || 0))
  const safeLimit = Math.max(20, Math.min(Number(limit) || 400, 1000))
  const selectedFeatures = allFeatures.slice(0, safeLimit)
  const selectedDomains = new Set(selectedFeatures.map((f) => f.data.domain))
  const nodes = [...nodesByType(db, 'PROJECT'), ...nodesByType(db, 'DOMAIN').filter((d) => selectedDomains.has(d.id.replace(/^domain:/, ''))), ...selectedFeatures]
  const ids = new Set(nodes.map((n) => n.id))
  const edges = db.prepare("SELECT id,type,src,dst FROM edges WHERE type IN ('CONTAINS','SHARES_IMPLEMENTATION_WITH')").all()
    .map((e) => ({ id: e.id, type: e.type, from: e.src, to: e.dst })).filter((e) => ids.has(e.from) && ids.has(e.to))
  return { counts: counts(db), projection: { level: 'semantic-overview', returned_features: selectedFeatures.length,
    total_features: allFeatures.length, truncated: selectedFeatures.length < allFeatures.length },
    nodes: nodes.map((n) => ({ id: n.id, type: n.type, name: n.name, data: n.data })), edges }
}
function featurePage(db, { q = '', domain = '', limit = 250, offset = 0 } = {}) {
  const all = nodesByType(db, 'FEATURE').map((f) => ({ id: f.id, name: f.name, ...f.data }))
    .filter((f) => (!q || `${f.name} ${f.slug}`.toLowerCase().includes(q.toLowerCase())) && (!domain || f.domain === domain))
    .sort((a, b) => String(a.domain).localeCompare(String(b.domain)) || String(a.name).localeCompare(String(b.name)))
  const safeLimit = Math.max(1, Math.min(Number(limit) || 250, 1000)), safeOffset = Math.max(0, Number(offset) || 0)
  return { features: all.slice(safeOffset, safeOffset + safeLimit), total: all.length, limit: safeLimit, offset: safeOffset,
    has_more: safeOffset + safeLimit < all.length }
}

// Sample every semantic family independently so a large route or GraphQL set cannot crowd authorization,
// models, services and flows out of the interactive feature view. The exported JSONL ledger remains exhaustive.
export function featureBundle(db, feature, { perType = 80 } = {}) {
  const types = ['ENDPOINT', 'ROUTE', 'GRAPHQL_OPERATION', 'JOB', 'SERVICE', 'MODEL', 'AUTH_CHECK', 'TOKEN',
    'ROLE', 'PERMISSION', 'DATA_FLOW', 'TRUST_BOUNDARY']
  const cap = Math.max(5, Math.min(Number(perType) || 80, 200))
  const directSql = `SELECT n.id,n.type,n.name,n.data FROM nodes n
    JOIN edges e ON e.dst=n.id WHERE e.src=? AND n.type=? ORDER BY n.id LIMIT ?`
  const countSql = `SELECT n.type,COUNT(DISTINCT n.id) n FROM nodes n
    JOIN edges e ON e.dst=n.id WHERE e.src=? GROUP BY n.type`
  const totals = Object.fromEntries(db.prepare(countSql).all(feature.id).map((r) => [r.type, r.n]))
  const neighbours = []
  for (const type of types) {
    for (const n of db.prepare(directSql).all(feature.id, type, cap)) {
      neighbours.push({ id: n.id, type: n.type, name: n.name, data: JSON.parse(n.data || '{}') })
    }
  }
  const roleRows = db.prepare(`SELECT DISTINCT n.id,n.type,n.name,n.data FROM edges owned
    JOIN edges role_edge ON role_edge.src=owned.dst AND role_edge.type='REQUIRES_ROLE'
    JOIN nodes n ON n.id=role_edge.dst WHERE owned.src=? ORDER BY n.id LIMIT ?`).all(feature.id, cap)
  const seen = new Set(neighbours.map((n) => n.id))
  for (const n of roleRows) if (!seen.has(n.id)) neighbours.push({ id: n.id, type: n.type, name: n.name, data: JSON.parse(n.data || '{}') })
  const citations = []
  for (const n of neighbours) {
    const c = claimsForNode(db, n.id)[0]
    if (c?.file) citations.push({ node: n.id, file: c.file, line: c.line_start, confidence: c.confidence, method: c.method })
    else if (n.data?.file) citations.push({ node: n.id, file: n.data.file, line: n.data.line || 1, confidence: 'medium', method: 'inventory' })
  }
  const returned = Object.fromEntries(types.map((t) => [t, neighbours.filter((n) => n.type === t).length]))
  return { ok: true, node: feature, neighbours, facts: [], citations,
    projection: { strategy: 'balanced-by-type', per_type_limit: cap, totals, returned,
      truncated: Object.entries(totals).some(([t, n]) => n > (returned[t] || 0)), exhaustive_ledger: `ledgers/${feature.data.slug}.jsonl` } }
}
function coverageView(db) {
  const feats = nodesByType(db, 'FEATURE')
  return { counts: counts(db), features: feats.map((f) => ({ name: f.name, domain: f.data.domain, slug: f.data.slug, rows: f.data.row_count || 0 })),
    infra: { data_stores: nodesByType(db, 'DATA_STORE').length, integrations: nodesByType(db, 'INTEGRATION').length, processes: nodesByType(db, 'PROCESS').length } }
}
// Typed node buckets that feed the Interfaces / Identity / Architecture / Data-Flows views.
function inventoryView(db, { limit = 300 } = {}) {
  const safeLimit = Math.max(20, Math.min(Number(limit) || 300, 1000))
  const totals = Object.fromEntries(db.prepare('SELECT type, COUNT(*) n FROM nodes GROUP BY type').all().map((r) => [r.type, r.n]))
  const map = (t) => db.prepare('SELECT id,name,data FROM nodes WHERE type=? ORDER BY id LIMIT ?').all(t, safeLimit)
    .map((n) => ({ id: n.id, name: n.name, ...JSON.parse(n.data || '{}') }))
  const flows = db.prepare("SELECT type,src,dst FROM edges WHERE type IN ('USES_SERVICE','USES_INTEGRATION','AUTHORIZED_BY','AUTHENTICATED_BY','REQUIRES_ROLE','EXPOSES','READS','WRITES','RETURNS_DATA','CROSSES_BOUNDARY') LIMIT ?").all(safeLimit)
    .map((e) => ({ type: e.type, from: e.src, to: e.dst }))
  return {
    endpoints: [...map('ENDPOINT').map((n) => ({ ...n, kind: 'REST' })), ...map('ROUTE').map((n) => ({ ...n, kind: 'Route' })),
      ...map('GRAPHQL_OPERATION').map((n) => ({ ...n, kind: 'GraphQL' })), ...map('JOB').map((n) => ({ ...n, kind: 'Job' }))],
    auth_checks: map('AUTH_CHECK'), roles: map('ROLE'), permissions: map('PERMISSION'), tokens: map('TOKEN'),
    services: map('SERVICE'), data_stores: map('DATA_STORE'), integrations: map('INTEGRATION'), processes: map('PROCESS'),
    features: nodesByType(db, 'FEATURE').map((f) => ({ id: f.id, name: f.name, domain: f.data.domain, slug: f.data.slug })),
    flows, counts: counts(db), totals, projection: { limit: safeLimit, truncated: Object.values(totals).some((n) => n > safeLimit) },
  }
}

// Purpose-built, bounded projections for the portal. The UI must never infer security semantics from labels or
// download the full graph: every row below is derived from canonical nodes/edges/reconciliation in SQLite.
export function dashboardView(db, { limit = 500 } = {}) {
  const cap = Math.max(50, Math.min(Number(limit) || 500, 1000))
  const parse = (row) => row ? { ...row, data: JSON.parse(row.data || '{}') } : row
  const featureNodes = db.prepare("SELECT id,name,data FROM nodes WHERE type='FEATURE' ORDER BY name").all().map(parse)
  const featureStat = db.prepare(`SELECT
      COUNT(DISTINCT CASE WHEN n.type IN ('ENDPOINT','ROUTE','GRAPHQL_OPERATION','JOB') THEN n.id END) entry_points,
      COUNT(DISTINCT CASE WHEN n.type='AUTH_CHECK' THEN n.id END) auth_checks
    FROM edges e JOIN nodes n ON n.id=e.dst WHERE e.src=?`)
  const featureRole = db.prepare(`SELECT DISTINCT r.name role FROM edges owned
    JOIN edges rr ON rr.src=owned.dst AND rr.type='REQUIRES_ROLE'
    JOIN nodes r ON r.id=rr.dst AND r.type='ROLE' WHERE owned.src=? ORDER BY r.name LIMIT 20`)
  const primaryClaim = db.prepare(`SELECT c.file,c.line_start FROM edges e JOIN claims c ON c.node_id=e.dst
    WHERE e.src=? AND c.file IS NOT NULL ORDER BY c.confidence='high' DESC,c.line_start LIMIT 1`)
  const features = featureNodes.map((f) => {
    const s = featureStat.get(f.id) || {}
    const roles = featureRole.all(f.id).map((r) => r.role).slice(0, 8)
    const claim = primaryClaim.get(f.id)
    return { id: f.id, name: f.name, slug: f.data.slug, domain: f.data.domain || 'core', purpose: f.data.purpose || '',
      rows: f.data.row_count || 0, entry_points: s.entry_points || 0, auth_checks: s.auth_checks || 0, roles,
      coverage: (f.data.row_count || 0) > 0 ? 'mapped' : 'coverage_gap', confidence: f.data.confidence || 'medium',
      primary_source: claim?.file || f.data.files?.[0] || '', primary_line: claim?.line_start || null }
  })

  const nodeList = (type, max = cap) => db.prepare('SELECT id,name,data FROM nodes WHERE type=? ORDER BY name LIMIT ?').all(type, max).map(parse)
  const roles = nodeList('ROLE', 200).map((r) => ({ id: r.id, name: r.name, source: r.data.source || r.data.file || '', line: r.data.line || null }))
  const permissions = nodeList('PERMISSION', 300).map((r) => ({ id: r.id, name: r.name, source: r.data.source || r.data.file || '', line: r.data.line || null }))
  const authChecks = nodeList('AUTH_CHECK', cap)
  const authKinds = Object.entries(authChecks.reduce((a, x) => { const k = x.data.kind || 'check'; a[k] = (a[k] || 0) + 1; return a }, {}))
    .map(([kind, count]) => ({ kind, count }))
  // A matrix cell means the sealed graph observed that role on an auth check belonging to that feature. It is an
  // association map, not a claim that every action in the feature grants that role.
  const capabilityCandidates = features.filter((f) => f.roles.length).sort((a, b) => b.auth_checks - a.auth_checks).slice(0, 12)
  const roleMatrix = roles.slice(0, 40).map((role) => ({ role: role.name,
    capabilities: Object.fromEntries(capabilityCandidates.map((f) => [f.slug, f.roles.includes(role.name)])) }))

  const interfaceRows = db.prepare(`SELECT n.id,n.type,n.name,n.data,f.name feature_name,f.id feature_id
    FROM nodes n LEFT JOIN edges e ON e.dst=n.id AND e.src LIKE 'feature:%'
    LEFT JOIN nodes f ON f.id=e.src WHERE n.type IN ('ENDPOINT','ROUTE','GRAPHQL_OPERATION','JOB')
    ORDER BY n.type,n.name LIMIT ?`).all(cap).map((r) => ({ ...parse(r), feature_name: r.feature_name, feature_id: r.feature_id }))
  const interfaces = interfaceRows.map((r) => {
    const d = r.data
    const kind = r.type === 'GRAPHQL_OPERATION' ? 'GraphQL' : r.type === 'JOB' ? 'Job' : r.data.interface_kind === 'rest' ? 'REST' : 'Route'
    const methodMatch = String(r.name).match(/\b(GET|POST|PUT|PATCH|DELETE|QUERY|MUTATION|SUB)\b/i)
    return { id: r.id, kind, method: d.method || methodMatch?.[1]?.toUpperCase() || (kind === 'Job' ? '—' : kind === 'GraphQL' ? 'OP' : 'ACTION'),
      operation: d.path || r.name, handler: d.handler || d.api_class || d.file || '', line: d.line || null, feature: r.feature_name || '', auth: d.auth_notes || '' }
  })

  const processes = nodeList('PROCESS', 100), dataStores = nodeList('DATA_STORE', 100), integrations = nodeList('INTEGRATION', 100)
  const domains = [...new Set(features.map((f) => f.domain))].sort().map((domain) => ({ domain,
    features: features.filter((f) => f.domain === domain).length,
    rows: features.filter((f) => f.domain === domain).reduce((n, f) => n + f.rows, 0) }))
  const boundaries = nodeList('TRUST_BOUNDARY', 100).map((b) => ({ id: b.id, name: b.name, kind: b.data.kind || 'boundary', confidence: b.data.confidence || 'medium' }))
  const flowRows = db.prepare("SELECT id,name,data FROM nodes WHERE type='DATA_FLOW' ORDER BY id LIMIT ?").all(cap)
  const flowSource = db.prepare("SELECT src FROM edges WHERE dst=? AND type='RETURNS_DATA' LIMIT 1")
  const flowOwner = db.prepare("SELECT n.name FROM edges e JOIN nodes n ON n.id=e.src AND n.type='FEATURE' WHERE e.dst=? LIMIT 1")
  const flows = flowRows.map((r) => { const d = JSON.parse(r.data || '{}'), sourceId = flowSource.get(r.id)?.src, feature = sourceId ? flowOwner.get(sourceId)?.name : null; return { feature: feature || 'Unassigned flow', name: r.name,
    source: d.source || feature || 'Application', sink: d.direction === 'application-to-client' ? 'Client response' : (d.sink || 'Application'),
    boundary: d.direction === 'application-to-client' ? 'Application → client' : 'Internal', confidence: d.confidence || 'medium', line: d.line || null } })

  const kinds = db.prepare('SELECT DISTINCT kind FROM reconciliation ORDER BY kind').all().map((r) => r.kind)
  const coverageRows = db.prepare(`SELECT feature_id,kind,COUNT(*) n FROM reconciliation
    WHERE feature_id IS NOT NULL GROUP BY feature_id,kind`).all()
  const coverageByFeature = new Map()
  for (const r of coverageRows) { if (!coverageByFeature.has(r.feature_id)) coverageByFeature.set(r.feature_id, {}); coverageByFeature.get(r.feature_id)[r.kind] = r.n }
  const coverage = features.map((f) => ({ id: f.id, name: f.name, slug: f.slug, domain: f.domain, total: f.rows, kinds: coverageByFeature.get(f.id) || {} }))
  const recon = Object.fromEntries(db.prepare('SELECT status,COUNT(*) n FROM reconciliation GROUP BY status').all().map((r) => [r.status, r.n]))
  return {
    features, identity: { roles, permissions, auth_kinds: authKinds, policy_count: authChecks.filter((a) => a.data.kind === 'policy').length,
      auth_check_count: authChecks.length, capabilities: capabilityCandidates.map((f) => ({ slug: f.slug, name: f.name })), matrix: roleMatrix },
    interfaces, architecture: { domains, processes, data_stores: dataStores, integrations },
    data_flows: { flows, boundaries }, coverage: { kinds, rows: coverage, reconciliation: recon },
    projection: { limit: cap, interfaces_truncated: interfaces.length === cap, flows_truncated: flows.length === cap }
  }
}

// allow `node apps/server/index.js` directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const dataArg = process.argv.indexOf('--data')
  startServer({ dataRoot: path.resolve(dataArg > -1 ? process.argv[dataArg + 1] : 'data'), port: Number(process.env.PORT || 4173) })
}
