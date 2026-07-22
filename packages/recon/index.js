// @codengram/recon — M5–M7 (deterministic core): cluster features, build the graph from inventories with
// provenance, reconcile every inventory item, run the completion gate, and orchestrate a full scan.
//
// Deterministic-before-AI (BLUEPRINT §13a): this produces a COMPLETE brain with NO model calls — clustering and
// graph construction are pure heuristics (§14.2/§14.6/§14.7). An optional AI pass (packages/claude-runtime) enriches
// feature purpose/review-context when the Claude Agent SDK is available; offline, structure-derived text is used.
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { profileRepo } from '../profiler/index.js'
import { extractInventories, inventoryMeta, INVENTORY_EXTRACTOR_VERSION } from '../inventories/index.js'
import { INVENTORY_KEYS } from '../plugins/index.js'
import { openGraph, upsertNode, upsertEdge, addClaim, addReconItem, reconCounts, reconTotal, mergeStaging, counts, nodesByType } from '../graph/index.js'
import { ID, slug } from '../schemas/index.js'
import { createSnapshot, getProject, sourceRootDir, snapshotDir, listSnapshots } from '../ingestion/index.js'
import { deterministicSemanticPlan, validateLeadPlan, semanticFeatureForRow } from './semantic-planner.js'
import { planRecon } from '../claude-runtime/index.js'

// Which inventories describe user-facing capabilities (→ features) vs shared infrastructure.
const FEATURE_KINDS = new Set(['routes_endpoints', 'rest_api', 'graphql', 'workers_jobs', 'services_finders_policies', 'response_shaping', 'tokens_actors', 'downloads_uploads_exports', 'search_aggregation'])
const INFRA_KINDS = new Set(['processes_ipc', 'datastores_integrations'])
const sing = (s) => (s.length > 3 && s.endsWith('s') && !s.endsWith('ss') ? s.slice(0, -1) : s)
const titleize = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
const STRIP_SUFFIX = /_(controller|service|finder|policy|worker|job|type|serializer|presenter|resolver|mutation|ability)$/
const STRIP_VERB = /^(create|update|delete|destroy|list|show|new|edit|fetch|get|build|generate|bulk)_/

// The clustering noun: the capability a row belongs to (§14.2 — controller/namespace cohesion + naming affinity).
function nounOf(row, kind) {
  if (kind === 'routes_endpoints' || kind === 'rest_api') {
    const r = row.entry.match(/resources?\s+:(\w+)/) || row.entry.match(/['"]\/?([a-z0-9_-]+)/i)
    if (r && r[1]) return sing(slug(r[1])) || 'misc'
  }
  let base = String(row.file.split('/').pop() || '').replace(/\.\w+$/, '').toLowerCase()
  base = base.replace(STRIP_SUFFIX, '').replace(STRIP_VERB, '')
  return sing(slug(base)) || 'misc'
}
// Domain = the controller NAMESPACE only (app/controllers/<domain>/x_controller.rb); else 'core'. Keeping non-
// controller rows (services/policies/workers/routes) in 'core' is what lets them cluster with their controller.
function domainOf(row) {
  const m = row.file.match(/app\/controllers\/([^/]+)\/[^/]+_controller\.rb$/)
  return (m && m[1] && slug(m[1])) || 'core'
}

// Group feature-bearing inventory rows into features; keep infra rows aside.
export function clusterFeatures(inventories) {
  return deterministicSemanticPlan(inventories)
}

const identityWords = /\b(anonymous|guest|member|reporter|developer|maintainer|owner|admin|staff|system)\b/gi
const permissionWords = /(?:can\?|allowed\?|authorize!?|permission)[^\n:]{0,30}:([a-z][a-z0-9_]*)/gi

function addIdentityContext(g, snapshot_id, featureId, authNodeId, row) {
  const text = `${row.entry || ''} ${row.file || ''}`
  const roles = [...new Set([...text.matchAll(identityWords)].map((m) => m[1].toLowerCase()))]
  const permissions = [...new Set([...text.matchAll(permissionWords)].map((m) => m[1].toLowerCase()))]
  for (const role of roles) {
    const roleId = ID.role(role)
    upsertNode(g, { type: 'ROLE', id: roleId, name: titleize(role), snapshot_id, data: { source: row.file, line: row.line } })
    upsertEdge(g, { type: 'REQUIRES_ROLE', from: authNodeId || featureId, to: roleId, snapshot_id })
    addClaim(g, { id: `c:${roleId}:observed:${row.file}:${row.line}`, node_id: roleId, field: 'observed', snapshot_id,
      file: row.file, line_start: row.line, confidence: 'medium', method: 'grep' })
  }
  for (const permission of permissions) {
    const permissionId = `permission:${slug(permission)}`
    upsertNode(g, { type: 'PERMISSION', id: permissionId, name: permission.replace(/_/g, ' '), snapshot_id,
      data: { source: row.file, line: row.line } })
    upsertEdge(g, { type: 'AUTHORIZED_BY', from: featureId, to: permissionId, snapshot_id })
    addClaim(g, { id: `c:${permissionId}:observed:${row.file}:${row.line}`, node_id: permissionId, field: 'observed',
      snapshot_id, file: row.file, line_start: row.line, confidence: 'medium', method: 'grep' })
  }
}

// Build a typed node (+ FILE + provenance claim) for one inventory row; return { nodeId, edge } for feature wiring.
function nodeForRow(g, snapshot_id, featureId, kind, row) {
  const fileId = ID.file(row.file)
  upsertNode(g, { type: 'FILE', id: fileId, name: row.file.split('/').pop(), snapshot_id })
  const claim = (node_id, field) => addClaim(g, { id: `c:${node_id}:${field}:${row.file}:${row.line}`, node_id, field, snapshot_id, file: row.file, line_start: row.line, confidence: 'medium', method: 'grep' })

  const structured = Object.fromEntries(['method', 'path', 'api_class', 'handler', 'purpose', 'auth_notes', 'inputs', 'enqueued_from']
    .filter((key) => row[key] != null && row[key] !== '').map((key) => [key, row[key]]))
  const mk = (node, edgeType, extra = {}) => {
    upsertNode(g, { ...node, snapshot_id, data: { ...(node.data || {}), file: row.file, line: row.line, ...structured, ...extra } })
    upsertEdge(g, { type: edgeType, from: featureId, to: node.id, snapshot_id })
    if (node.id !== fileId) upsertEdge(g, { type: 'HANDLED_BY', from: node.id, to: fileId, snapshot_id })
    claim(node.id, 'defined')
    return node.id
  }
  switch (kind) {
    case 'routes_endpoints': case 'rest_api': {
      if (row.detail === 'controller-helper') return mk({ type: 'SYMBOL', id: ID.symbol(row.file, row.entry.replace(/^helper\s+/, '')),
        name: row.entry.replace(/^helper\s+/, ''), data: { kind: 'controller-helper' } }, 'DEFINES')
      const mm = row.entry.match(/\b(get|post|put|patch|delete)\b/i), pm = row.entry.match(/['"]([^'"]+)['"]/) 
      const nodeId = mm && pm
        ? mk({ type: 'ENDPOINT', id: ID.endpoint(mm[1], pm[1]), name: `${mm[1].toUpperCase()} ${pm[1]}` }, 'EXPOSES',
          { interface_kind: kind === 'rest_api' ? 'rest' : 'web' })
        : mk({ type: 'ROUTE', id: ID.scoped('route', row.file, row.line, row.entry), name: row.entry.slice(0, 60) }, 'EXPOSES',
          { interface_kind: kind === 'rest_api' ? 'rest' : 'web' })
      const boundaryId = 'trust_boundary:untrusted-client-to-application'
      upsertNode(g, { type: 'TRUST_BOUNDARY', id: boundaryId, name: 'Untrusted client → application', snapshot_id,
        data: { kind: 'network', confidence: 'high' } })
      upsertEdge(g, { type: 'CROSSES_BOUNDARY', from: nodeId, to: boundaryId, snapshot_id })
      return nodeId
    }
    case 'graphql': return mk({ type: 'GRAPHQL_OPERATION', id: ID.scoped('graphql', row.file, row.line, row.entry), name: row.entry.slice(0, 60) }, 'EXPOSES')
    case 'workers_jobs': return mk({ type: 'JOB', id: ID.scoped('job', row.file, row.line, row.entry), name: row.entry.slice(0, 60) }, 'EXPOSES')
    case 'services_finders_policies': {
      if (row.detail === 'source-module') return mk({ type: 'SYMBOL', id: ID.symbol(row.file, row.entry),
        name: row.entry, data: { kind: 'source-module' } }, 'DEFINES')
      if (row.detail === 'policy') return mk({ type: 'AUTH_CHECK', id: ID.scoped('authcheck', row.file), name: row.entry, data: { kind: 'policy' } }, 'AUTHORIZED_BY')
      if (row.detail === 'model') return mk({ type: 'MODEL', id: ID.scoped('model', row.file), name: row.entry.replace(/\.rb$/, ''), data: { kind: 'model' } }, 'READS')
      return mk({ type: 'SERVICE', id: ID.scoped('service', row.file), name: row.entry, data: { kind: row.detail === 'finder' ? 'finder' : 'service' } }, 'USES_SERVICE')
    }
    case 'response_shaping': {
      const serializer = mk({ type: 'SERVICE', id: ID.scoped('service', row.file, row.line, 'serializer'), name: row.entry.slice(0, 60), data: { kind: 'serializer' } }, 'USES_SERVICE')
      const flowId = ID.scoped('data_flow', featureId, row.file, row.line)
      upsertNode(g, { type: 'DATA_FLOW', id: flowId, name: `Response from ${row.file.split('/').pop()}`, snapshot_id,
        data: { source: row.file, line: row.line, direction: 'application-to-client' } })
      upsertEdge(g, { type: 'RETURNS_DATA', from: serializer, to: flowId, snapshot_id })
      return serializer
    }
    case 'tokens_actors': return row.detail === 'token'
      ? mk({ type: 'TOKEN', id: ID.scoped('token', row.file, row.line), name: row.entry.slice(0, 60), data: { kind: 'token' } }, 'AUTHENTICATED_BY')
      : mk({ type: 'AUTH_CHECK', id: ID.scoped('authcheck', row.file, 'actor'), name: row.entry.slice(0, 60), data: { kind: row.detail === 'permission' ? 'ability' : 'before_action' } }, 'AUTHENTICATED_BY')
    case 'downloads_uploads_exports': case 'search_aggregation':
      return mk({ type: 'SERVICE', id: ID.scoped('service', row.file, row.line, kind), name: row.entry.slice(0, 50), data: { kind: 'service' } }, 'USES_SERVICE')
    default: return null
  }
}

// Build the full graph (into `g`) from clusters + infra; return reconciliation + gate results.
// onProgress(ev) receives granular live events (per-feature, shares, infra) for the recon UI.
export function buildGraph(g, { project, snapshot, profile, inventories, featurePlan = null, onProgress = () => {} }) {
  const sid = snapshot.id
  const before = () => counts(g).nodes
  upsertNode(g, { type: 'PROJECT', id: project.id, name: project.name, snapshot_id: sid, data: { languages: profile.languages, frameworks: profile.frameworks } })
  upsertNode(g, { type: 'SNAPSHOT', id: sid, name: sid.slice(0, 20), snapshot_id: sid, data: { file_count: snapshot.file_count, content_hash: snapshot.content_hash } })
  upsertEdge(g, { type: 'CONTAINS', from: project.id, to: sid, snapshot_id: sid })

  const features = featurePlan || clusterFeatures(inventories)
  const slugCounts = features.reduce((m, f) => m.set(f.slug, (m.get(f.slug) || 0) + 1), new Map())
  const domains = new Set()
  const serviceUsers = new Map()   // serviceNodeId -> Set(featureId)  → SHARES_IMPLEMENTATION_WITH (§14.6)
  const interfaceNodes = []        // cross-cutting interfaces may expose both a technical surface and a business feature
  let mapped = 0
  onProgress({ kind: 'features_planned', count: features.length, domains: [...new Set(features.map((f) => f.domain))], label: `Discovered ${features.length} features across ${new Set(features.map((f) => f.domain)).size} domains` })

  for (const f of features) {
    const domId = ID.domain(f.domain), featId = ID.feature(f.domain, f.slug)
    const publicSlug = slugCounts.get(f.slug) > 1 ? `${f.domain}-${f.slug}` : f.slug
    if (!domains.has(f.domain)) { domains.add(f.domain); upsertNode(g, { type: 'DOMAIN', id: domId, name: titleize(f.domain), snapshot_id: sid }); upsertEdge(g, { type: 'CONTAINS', from: project.id, to: domId, snapshot_id: sid }) }
    const files = new Set(f.rows.map((r) => r.row.file))
    const n0 = before()
    upsertNode(g, { type: 'FEATURE', id: featId, name: f.name, snapshot_id: sid, data: { domain: f.domain, slug: publicSlug, canonical_slug: f.slug,
      files: [...files], row_count: f.rows.length, purpose: featurePurpose(f), planning_method: f.planning_method || 'deterministic',
      confidence: f.confidence || 'medium' } })
    upsertEdge(g, { type: 'CONTAINS', from: domId, to: featId, snapshot_id: sid })
    for (const { kind, row } of f.rows) {
      const nid = nodeForRow(g, sid, featId, kind, row)
      if (nid && ['routes_endpoints', 'rest_api', 'graphql', 'workers_jobs'].includes(kind)) interfaceNodes.push({ nid, kind, row, primary: featId })
      if (nid && /^service:|^authcheck:/.test(nid)) { if (!serviceUsers.has(nid)) serviceUsers.set(nid, new Set()); serviceUsers.get(nid).add(featId) }
      if (kind === 'tokens_actors' || (kind === 'services_finders_policies' && row.detail === 'policy')) addIdentityContext(g, sid, featId, nid, row)
      // #6: record THIS row's terminal reconciliation status in the ledger (per-item, not summary math).
      addReconItem(g, { id: ID.scoped('recon', kind, row.file, row.line, row.entry), kind, file: row.file, line: row.line, entry: row.entry, status: 'MAPPED_TO_FEATURE', feature_id: featId, snapshot_id: sid })
    }
    mapped++
    onProgress({ kind: 'feature_mapped', feature: f.name, slug: publicSlug, domain: f.domain, rows: f.rows.length, added: before() - n0, label: `Mapped ${f.name} (${f.domain}) — +${before() - n0} nodes` })
  }

  // Lead plans often create technical features such as "REST API Surface". Preserve that ownership, but add a
  // second EXPOSES edge to the deterministic business capability so Issues pages contain Issues REST endpoints,
  // GraphQL operations, and workers rather than losing them to a technology-only bucket.
  const plannedFeatureIds = new Set(features.map((f) => ID.feature(f.domain, f.slug)))
  for (const item of interfaceNodes) {
    const semantic = semanticFeatureForRow(item.row)
    if (!semantic) continue
    const target = ID.feature(semantic.domain, semantic.slug)
    if (target !== item.primary && plannedFeatureIds.has(target)) upsertEdge(g, { type: 'EXPOSES', from: target, to: item.nid, snapshot_id: sid,
      data: { relationship: 'business-capability-correlation', inventory_kind: item.kind } })
  }

  // §14.6 — a service/auth-check used by ≥2 features links those features as sharing implementation.
  let shares = 0
  for (const [, users] of serviceUsers) {
    const list = [...users]
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { upsertEdge(g, { type: 'SHARES_IMPLEMENTATION_WITH', from: list[i], to: list[j], snapshot_id: sid }); shares++ }
  }
  if (shares) onProgress({ kind: 'shares', count: shares, label: `Linked ${shares} shared-implementation edge(s)` })

  // Infra rows → project-level nodes (SHARED_INFRASTRUCTURE), never features. Each gets a provenance claim (#6) and
  // a reconciliation ledger row — infra is reconciled with evidence, not silently counted.
  let infra = 0
  for (const kind of INFRA_KINDS) for (const row of inventories[kind] || []) {
    const type = kind === 'datastores_integrations' ? (row.detail === 'datastore' ? 'DATA_STORE' : 'INTEGRATION') : 'PROCESS'
    const id = ID.scoped(type.toLowerCase(), row.file, row.line, row.entry)
    upsertNode(g, { type, id, name: row.entry.slice(0, 60), snapshot_id: sid, data: { file: row.file, line: row.line } })
    upsertEdge(g, { type: type === 'INTEGRATION' ? 'USES_INTEGRATION' : 'CONTAINS', from: project.id, to: id, snapshot_id: sid })
    addClaim(g, { id: `c:${id}:defined:${row.file}:${row.line}`, node_id: id, field: 'defined', snapshot_id: sid, file: row.file, line_start: row.line, confidence: 'medium', method: 'grep' })
    addReconItem(g, { id: ID.scoped('recon', kind, row.file, row.line, row.entry), kind, file: row.file, line: row.line, entry: row.entry, status: 'SHARED_INFRASTRUCTURE', snapshot_id: sid })
    infra++
  }

  return reconcileAndGate(g, { inventories, features, files: profile.files })
}

// A one-line structure-derived purpose (offline). AI enrichment can overwrite FEATURE.data.purpose later.
function featurePurpose(f) {
  const byKind = {}; for (const { kind } of f.rows) byKind[kind] = (byKind[kind] || 0) + 1
  const parts = Object.entries(byKind).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`)
  return `The ${f.name} capability — ${parts.join(', ')}. (structure-derived; unverified)`
}

// §14.7 reconciliation + §14.9 completion gate — computed from the PERSISTED per-item ledger, not summary arithmetic.
function reconcileAndGate(g, { inventories, features, files = null }) {
  const terminal = reconCounts(g)                       // { MAPPED_TO_FEATURE: n, SHARED_INFRASTRUCTURE: m, ... }
  const reconciled = reconTotal(g)
  // Every inventory item must have reached a terminal status. Any not in the ledger → an UNRECONCILED gap.
  const totalRows = INVENTORY_KEYS.reduce((s, k) => s + (inventories[k] || []).length, 0)
  const unreconciled = Math.max(0, totalRows - reconciled)
  const feature_rows = terminal.MAPPED_TO_FEATURE || 0
  const infra_rows = terminal.SHARED_INFRASTRUCTURE || 0
  const gaps = []
  const extraction = inventoryMeta(inventories)
  if (features.length === 0) gaps.push(
    files === 0 ? 'no source files found at this path — the directory is empty or points at the wrong place'
      : feature_rows > 0 ? `${feature_rows} inventory rows found but no features clustered (clustering gap)`
        : 'no features mapped — no language plugin matched this stack (unsupported or non-code repository)')
  if (unreconciled) gaps.push(`${unreconciled} inventory item(s) never reached a terminal reconciliation status`)
  if (extraction.unrepresented_source_files > 0) gaps.push(`${extraction.unrepresented_source_files} source file(s) were not represented by any inventory row`)
  if (extraction.universal_used) gaps.push(`generic structural extraction was required${extraction.matched_plugins.length ? ' for uncovered languages/modules' : ''}; feature semantics remain estimated until a stack-specific plugin or Lead verifies them`)
  const catchall = features.filter((f) => f.planning_method === 'coverage-catchall')
  if (catchall.length) {
    const rows = catchall.reduce((n, f) => n + f.rows.length, 0)
    gaps.push(`${rows} inventory item(s) are structurally covered by ${catchall.length} supporting-capability catch-all feature(s) but still need semantic consolidation`)
  }
  const status = gaps.length === 0 ? 'COMPLETE' : 'COMPLETE_WITH_GAPS'
  return {
    coverage: { feature_count: features.length, mapped: features.length, infra: infra_rows, feature_rows, infra_rows,
      reconciled, total_rows: totalRows, plugin_matched: extraction.matched_plugins.length > 0, extraction, terminal },
    gate: { status, gaps },
  }
}

// A unique, trackable mission id per scan (displayed in the UI/CLI and recorded in publication.json).
export const newMissionId = () => `mission:${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`

// ── orchestration ──────────────────────────────────────────────────────────────────────────────
// Full deterministic scan with ATOMIC PUBLICATION (§4f):
//   freeze → profile → inventories → build graph in an ATTEMPT dir → render + integrity-validate the artifacts →
//   only on a clean cross-check do we atomically seal (replace the published index + phase1-maps + publication.json).
// A failure at any point leaves the previously-published snapshot untouched. `render` is injected so recon stays
// decoupled from the markdown-renderer; it must return { crosscheck: { ok } }.
export async function scanSnapshot(dataRoot, projectId, { snapshotId, onPhase = () => {}, onProgress = () => {}, render = null, missionId = newMissionId(), agentic = true } = {}) {
  const project = getProject(dataRoot, projectId)
  if (!project) throw new Error(`unknown project: ${projectId}`)
  onPhase({ phase: 'freeze', label: 'Freezing source snapshot', mission: missionId })
  const snapshot = snapshotId ? { id: snapshotId } : createSnapshot(dataRoot, projectId)
  const sid = snapshot.id
  const snapDir = snapshotDir(dataRoot, projectId, sid)
  const src = sourceRootDir(dataRoot, projectId, sid)
  onPhase({ phase: 'profile', label: 'Profiling scale & shape' })
  const profile = profileRepo(src)
  onProgress({ kind: 'profile', label: `${profile.files} source files · ${profile.languages.join(', ') || '—'} · ${profile.frameworks.join(', ') || 'no framework detected'}`, files: profile.files, languages: profile.languages, frameworks: profile.frameworks })
  onPhase({ phase: 'inventories', label: 'Extracting deterministic inventories' })
  const inventories = extractInventories({ sourceRoot: src, profile })
  const invCounts = Object.fromEntries(INVENTORY_KEYS.map((k) => [k, (inventories[k] || []).length]))
  const invTotal = Object.values(invCounts).reduce((a, b) => a + b, 0)
  const inventoryFingerprint = crypto.createHash('sha256').update(`${INVENTORY_EXTRACTOR_VERSION}\n${JSON.stringify(inventories)}`).digest('hex')
  onProgress({ kind: 'inventories', label: `Extracted ${invTotal} inventory items across 11 lists`, counts: invCounts, total: invTotal })
  onPhase({ phase: 'planning', label: 'Lead consolidating semantic features' })
  const previousPublication = latestPublished(dataRoot, projectId)?.publication || null
  const existingPublication = readPublication(dataRoot, projectId, sid)
  const reused = !!existingPublication
  let lead = null, featurePlan = null, planningMethod = 'deterministic-semantic'
  if (reused) try {
    const sealedPlan = JSON.parse(fs.readFileSync(path.join(snapDir, 'publications', existingPublication.pub, 'feature-plan.json'), 'utf8'))
    if (sealedPlan.inventory_fingerprint === inventoryFingerprint && Array.isArray(sealedPlan.features)) {
      featurePlan = sealedPlan.features
      planningMethod = 'sealed-plan-reuse'
    }
  } catch {}
  if (!featurePlan && agentic) {
    lead = await planRecon({ sourceRoot: src, profile, inventoryCounts: invCounts,
      resume: existingPublication?.lead_session_id || previousPublication?.lead_session_id || null, onEvent: onProgress })
    featurePlan = validateLeadPlan(lead?.plan, inventories)
    if (featurePlan) planningMethod = 'agent-lead'
  }
  if (!featurePlan) featurePlan = deterministicSemanticPlan(inventories)
  const plannerName = planningMethod === 'agent-lead' ? 'claude-agent-sdk' : planningMethod
  onProgress({ kind: 'semantic_plan', count: featurePlan.length, session_id: lead?.sessionId || null,
    method: planningMethod, label: `Planned ${featurePlan.length} coherent business features` })
  // Content-addressed: if this exact snapshot id was already published, the source is UNCHANGED (a re-verify, not new work).
  if (reused) onProgress({ kind: 'reused', label: 'Source unchanged since the last scan — re-verifying the same snapshot' })

  // Build EVERYTHING into a fresh attempt dir (never the live snapshot) — this is what makes a rerun clean (#6) and
  // publication atomic (#3): stale nodes/claims/markdown can't survive because we replace, not update-in-place.
  const attempt = path.join(snapDir, `.attempt-${crypto.createHash('sha1').update(missionId).digest('hex').slice(0, 10)}`)
  fs.rmSync(attempt, { recursive: true, force: true }); fs.mkdirSync(attempt, { recursive: true })
  try {
    const missionPath = path.join(attempt, 'mission.json')
    const mission = { mission_id: missionId,
      lead_session_id: lead?.sessionId || existingPublication?.lead_session_id || previousPublication?.lead_session_id || null,
      planner: plannerName, created_at: new Date().toISOString(),
      workstreams: featurePlan.map((f) => ({ id: `${f.domain}/${f.slug}`, name: f.name, domain: f.domain,
        inventory_rows: f.rows.length, status: 'PLANNED', planning_method: f.planning_method })) }
    fs.writeFileSync(missionPath, JSON.stringify(mission, null, 2))
    fs.writeFileSync(path.join(attempt, 'feature-plan.json'), JSON.stringify({ inventory_fingerprint: inventoryFingerprint,
      planning_method: planningMethod, features: featurePlan }, null, 2))
    onPhase({ phase: 'graph', label: 'Clustering features + building the graph' })
    let staging = null, index = null, result, merged, crosscheck
    try {
      staging = openGraph(path.join(attempt, 'staging.sqlite'))
      staging.exec('BEGIN')
      try {
        result = buildGraph(staging, { project, snapshot: snapshot.file_count != null ? snapshot : { id: sid, file_count: profile.files, content_hash: '' }, profile, inventories, featurePlan, onProgress })
        staging.exec('COMMIT')
        mission.workstreams = mission.workstreams.map((w) => ({ ...w, status: 'COMPLETED', completed_at: new Date().toISOString() }))
        mission.completed_at = new Date().toISOString()
        mission.gate = result.gate
        fs.writeFileSync(missionPath, JSON.stringify(mission, null, 2))
      } catch (error) {
        try { staging.exec('ROLLBACK') } catch {}
        throw error
      }
      index = openGraph(path.join(attempt, 'index.sqlite'))
      merged = mergeStaging(index, staging)
      onProgress({ kind: 'sealed', label: `Built ${merged.nodes} nodes · ${merged.edges} edges · ${merged.claims} claims`, graph: merged })

      // #1: rendering is MANDATORY for publication — a graph without validated phase1-maps must never publish.
      if (typeof render !== 'function') throw new Error('scanSnapshot requires a render function to publish (graph-only publication is not allowed)')
      // Render + integrity-validate ON THE ATTEMPT before sealing. A render/crosscheck failure aborts the publish.
      onPhase({ phase: 'render', label: 'Generating + validating phase1-maps' })
      crosscheck = (render(index, attempt, { project, snapshot: { id: sid }, coverage: result.coverage, gate: result.gate, inventories, missionId }) || {}).crosscheck || { ok: false, note: 'render returned no crosscheck' }
    } finally {
      try { index?.close() } catch {}
      try { staging?.close() } catch {}
    }
    if (!crosscheck.ok) throw new Error(`integrity check failed (Markdown↔graph mismatch: graph=${crosscheck.graph}, md=${crosscheck.markdown}) — snapshot NOT published`)

    // #2/#4: atomic seal via a versioned publication dir + a single CURRENT pointer. The whole attempt (index.sqlite
    //   + phase1-maps) is renamed into publications/<pubId>/ (atomic), then CURRENT is written temp→rename (the one
    //   commit point). A crash before the pointer write leaves the PREVIOUS publication fully intact. `state` uses the
    //   canonical PUBLICATION_STATES (the gate outcome), never a non-schema 'PUBLISHED'.
    onPhase({ phase: 'seal', label: 'Sealing + publishing the snapshot' })
    const pubId = crypto.createHash('sha256').update(`${missionId}:${crypto.randomUUID()}`).digest('hex').slice(0, 16)
    const publication = { state: result.gate.status, published: true, mission_id: missionId,
      lead_session_id: lead?.sessionId || existingPublication?.lead_session_id || previousPublication?.lead_session_id || null,
      planner: plannerName, workstreams: featurePlan.length,
      gate: result.gate.status, gaps: result.gate.gaps, crosscheck, graph: merged, features: result.coverage.feature_count, reconciled: result.coverage.reconciled, reused, sealed_at: new Date().toISOString() }
    sealPublish(snapDir, attempt, pubId, publication)

    onPhase({ phase: 'done', label: 'Brain ready', mission: missionId })
    return { missionId, snapshotId: sid, profile, inventories, ...result, publication, pubId,
      domains: [...new Set(featurePlan.map((f) => f.domain))], graph: merged, dataRoot, projectId }
  } catch (e) {
    fs.rmSync(attempt, { recursive: true, force: true })   // failed attempt leaves the published snapshot untouched
    throw e
  }
}

const publicationsDir = (snapDir) => path.join(snapDir, 'publications')
const currentPath = (snapDir) => path.join(snapDir, 'CURRENT')
// Atomic publish: move the validated attempt into publications/<pubId>/, then flip CURRENT with a temp→rename.
function sealPublish(snapDir, attempt, pubId, publication) {
  fs.rmSync(path.join(attempt, 'staging.sqlite'), { force: true })   // never publish the staging db
  fs.mkdirSync(publicationsDir(snapDir), { recursive: true })
  const target = path.join(publicationsDir(snapDir), pubId)
  if (fs.existsSync(target)) throw new Error(`publication id collision refused: ${pubId}`)
  fs.renameSync(attempt, target)                                     // whole dir move (atomic on one filesystem)
  const cur = currentPath(snapDir), tmp = `${cur}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify({ pub: pubId, ...publication }, null, 2))
  fs.renameSync(tmp, cur)                                            // THE commit point — one atomic pointer swap
  for (const d of fs.readdirSync(publicationsDir(snapDir))) if (d !== pubId) fs.rmSync(path.join(publicationsDir(snapDir), d), { recursive: true, force: true })  // GC old publications
}
// The CURRENT publication for a snapshot (the pointer), or null if none is published.
export function readPublication(dataRoot, projectId, snapshotId) {
  try { return JSON.parse(fs.readFileSync(currentPath(snapshotDir(dataRoot, projectId, snapshotId)), 'utf8')) } catch { return null }
}
// The canonical index.sqlite path for a snapshot's CURRENT publication (or null).
export function publishedIndexPath(dataRoot, projectId, snapshotId) {
  const c = readPublication(dataRoot, projectId, snapshotId)
  return c ? path.join(publicationsDir(snapshotDir(dataRoot, projectId, snapshotId)), c.pub, 'index.sqlite') : null
}
// #3: the project's latest publication is the one with the most recent SEALED_AT — not the newest snapshot. So a
//   re-scan of an older (content-addressed) snapshot correctly becomes current again.
export function latestPublished(dataRoot, projectId) {
  const pubs = listSnapshots(dataRoot, projectId)
    .map((s) => ({ snapshot: s, publication: readPublication(dataRoot, projectId, s.id) }))
    .filter((x) => x.publication && x.publication.published)
  if (!pubs.length) return null
  pubs.sort((a, b) => String(b.publication.sealed_at).localeCompare(a.publication.sealed_at))
  const top = pubs[0]
  return { ...top, indexPath: path.join(publicationsDir(snapshotDir(dataRoot, projectId, top.snapshot.id)), top.publication.pub, 'index.sqlite') }
}

export { INVENTORY_KEYS, counts, nodesByType }
