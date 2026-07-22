#!/usr/bin/env node
// codengram CLI — recon a repo into a persistent, cited second brain. Deterministic core; AI is optional.
import path from 'node:path'
import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { createProject, listProjects, listSnapshots, getProject, snapshotDir } from '../../../packages/ingestion/index.js'
import { scanSnapshot, latestPublished } from '../../../packages/recon/index.js'
import { renderPhase1Maps } from '../../../packages/markdown-renderer/index.js'
import { openGraph } from '../../../packages/graph/index.js'
import { answer, AI_PREAMBLE, getContextBundle } from '../../../packages/retrieval/index.js'
import { isAvailable, askClaude, isReconQuestion } from '../../../packages/claude-runtime/index.js'
import { runDoctor, printDoctor } from '../../../packages/doctor/index.js'

const cmd = process.argv[2]
const { values, positionals } = parseArgs({ args: process.argv.slice(3), allowPositionals: true,
  options: { data: { type: 'string', default: 'data' }, port: { type: 'string', default: '4173' }, name: { type: 'string' }, probe: { type: 'boolean', default: false } } })
const dataRoot = path.resolve(values.data)
const bold = (s) => `\x1b[1m${s}\x1b[0m`, dim = (s) => `\x1b[2m${s}\x1b[0m`, green = (s) => `\x1b[32m${s}\x1b[0m`, amber = (s) => `\x1b[33m${s}\x1b[0m`

// Full diagnostics (with a real Claude login probe when --probe is passed).
async function doctor() {
  const report = await runDoctor({ dataRoot, port: Number(values.port), probeAi: values.probe })
  printDoctor(report)
  if (!values.probe) console.log(dim('  tip: `codengram doctor --probe` also verifies your Claude login (uses a little quota).\n'))
  process.exit(report.ok ? 0 : 1)
}
// Fast preflight before real work — blocks only on hard failures; warns (doesn't block) on optional AI.
async function preflight({ port = null } = {}) {
  const report = await runDoctor({ dataRoot, port })
  if (!report.ok) { printDoctor(report); process.exit(1) }
  for (const c of report.checks) if (c.status === 'warn') console.log(dim(`  ⚠ ${c.name}: ${c.detail}`))
}

async function scan(repo) {
  if (!repo) die('usage: codengram scan <repo-path> [--data DIR]')
  const abs = path.resolve(repo)
  if (!fs.existsSync(abs)) die(`no such path: ${abs}`)
  await preflight()
  console.log(dim(`freezing + reconning ${abs} …`))
  const project = createProject(dataRoot, abs, { name: values.name })
  // The renderer is injected so the graph + markdown are validated together, then the snapshot is atomically sealed.
  const res = await scanSnapshot(dataRoot, project.id, { onPhase: (e) => process.stdout.write(dim(`  · ${e.label}\n`)), render: (db, out, meta) => renderPhase1Maps(db, out, meta) })
  const brain = path.join(snapshotDir(dataRoot, project.id, res.snapshotId), 'publications', res.pubId, 'phase1-maps')
  const gate = res.gate.status === 'COMPLETE' ? green(res.gate.status) : amber(res.gate.status)
  console.log(`\n${bold(project.name)}  ${dim(project.id)}`)
  console.log(`  ${bold('mission')}    ${res.missionId}`)
  console.log(`  snapshot   ${res.snapshotId}`)
  console.log(`  languages  ${res.profile.languages.join(', ') || '—'}   frameworks ${res.profile.frameworks.join(', ') || '—'}`)
  console.log(`  graph      ${res.graph.nodes} nodes · ${res.graph.edges} edges · ${res.graph.claims} claims`)
  console.log(`  features   ${res.coverage.feature_count}   gate ${gate}`)
  if (res.gate.gaps.length) res.gate.gaps.forEach((g) => console.log(dim(`             gap: ${g}`)))
  console.log(`  published  ${green('sealed')} ${dim(res.publication.sealed_at)}`)
  console.log(`  brain      ${brain}`)
  console.log(`\n${dim('serve the UI:')}  npm run serve -- --data ${values.data}`)
}

function ls() {
  const projects = listProjects(dataRoot)
  if (!projects.length) return console.log(dim('no projects yet — run: codengram scan <repo>'))
  for (const p of projects) {
    const pub = latestPublished(dataRoot, p.id)
    console.log(`${bold(p.name)}  ${dim(p.id)}\n  ${dim(p.source_root)}`)
    if (pub) console.log(`  ${green('●')} published  ${pub.publication.features} features · gate ${pub.publication.gate} · mission ${dim(pub.publication.mission_id)}`)
    else console.log(`  ${amber('○')} not scanned yet`)
  }
}

async function ask(projectId, question) {
  if (!projectId || !question) die('usage: codengram ask <projectId> "<question>"')
  if (!isReconQuestion(question)) die('Codengram is recon-only; security testing and vulnerability questions are outside scope')
  const p = getProject(dataRoot, projectId) || listProjects(dataRoot).find((x) => x.name === projectId || x.id.includes(projectId))
  if (!p) die(`unknown project: ${projectId}`)
  const pub = latestPublished(dataRoot, p.id)
  if (!pub) die('no published brain — run a scan first')
  const source = { dataRoot, projectId: p.id, snapshotId: pub.snapshot.id }
  const db = openGraph(pub.indexPath)
  const det = answer(db, question, { source })
  // #13: actually try Claude when the SDK is available, packing the best-matching node's bundle; else deterministic.
  let out = det.text, via = 'deterministic'
  if (await isAvailable() && det.node) {
    const bundle = getContextBundle(db, det.node, { hops: 1 })
    const ai = await askClaude({ preamble: AI_PREAMBLE, question, bundle })
    if (ai) { out = ai; via = 'claude' }
  }
  console.log(`\n${dim('via ' + via)}\n${out}\n`)
  db.close()
}

async function serve() {
  const { startServer } = await import('../../server/index.js')
  await startServer({ dataRoot, port: Number(values.port) })   // startServer runs its own preflight before listening
}

function die(msg) { console.error(msg); process.exit(1) }
function help() {
  console.log(`${bold('codengram')} — map any codebase into a cited graph, then export it ${dim('(recon only)')}

  ${bold('scan')} <repo> [--data DIR] [--name N]   map a repo → cited graph + portable bundle
  ${bold('ls')} [--data DIR]                        list projects + published maps
  ${bold('ask')} <projectId> "<question>"           ask the map (cited; AI if available, else deterministic)
  ${bold('serve')} [--port 4173] [--data DIR]       start the local UI + API
  ${bold('doctor')} [--probe]                        check Node, SQLite, data dir, port, and Claude (--probe verifies login)
`)
}

const main = { scan: () => scan(positionals[0]), ls, ask: () => ask(positionals[0], positionals[1]), serve, doctor, help }[cmd] || help
await main()
