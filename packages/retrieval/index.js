// @codengram/retrieval — M8: bounded, cited context bundles for Ask-time (BLUEPRINT §6, §14.10).
//
// NEVER a repo rescan: retrieval is a bounded graph query. The packer assembles an AI_CONTEXT preamble + the target
// node's facts + its subgraph + cited source excerpts (from the frozen snapshot). The same packer feeds in-app Ask
// and export. A deterministic answer() is provided so Ask works with zero AI; claude-runtime can layer reasoning on top.
import { neighbourhood, getNode, claimsForNode, search } from '../graph/index.js'
import { readSourceLines } from '../ingestion/index.js'

// A bounded bundle: the node, its 1–2 hop subgraph as facts, provenance, and cited source excerpts.
export function getContextBundle(db, nodeId, { hops = 2, cap = 300, source } = {}) {
  const node = getNode(db, nodeId)
  if (!node) return { ok: false, reason: 'coverage gap: node not found', nodeId }
  const nb = neighbourhood(db, nodeId, hops, cap)
  const facts = nb.edges.map((e) => `${short(e.from)} --${e.type}--> ${short(e.to)}`)
  const citations = []
  for (const n of nb.nodes) {
    for (const c of claimsForNode(db, n.id)) {
      if (!c.file) continue
      const cite = { node: n.id, file: c.file, line: c.line_start, method: c.method, confidence: c.confidence }
      if (source) cite.excerpt = readSourceLines(source.dataRoot, source.projectId, source.snapshotId, c.file, c.line_start || 1, (c.line_end || c.line_start || 1) + 2)
      citations.push(cite)
    }
  }
  return { ok: true, node, neighbours: nb.nodes.map((n) => ({ id: n.id, type: n.type, name: n.name, data: n.data })), facts, citations }
}
const short = (id) => id.replace(/^(feature|endpoint|service|authcheck|file|domain|project|snapshot|route|job|graphql|integration|data_store|process):/, '')

// The AI_CONTEXT preamble the export + Ask share.
export const AI_PREAMBLE = 'You are reading a Codengram code-reconnaissance brain (recon only — never asserts ' +
  'vulnerabilities). Every fact is grounded to a file:line in the frozen snapshot. Answer ONLY from the facts and ' +
  'citations below; if something is missing, say "coverage gap" — never guess.'

// Deterministic, cited answer (no model). Finds the best-matching node and packs its bundle into readable text.
const TYPE_WEIGHT = { FEATURE: 5, DOMAIN: 4, ENDPOINT: 3, AUTH_CHECK: 3, SERVICE: 3, GRAPHQL_OPERATION: 2, JOB: 2, INTEGRATION: 2, DATA_STORE: 2, FILE: 1, SYMBOL: 1 }
export function answer(db, question, { source } = {}) {
  const terms = String(question || '').toLowerCase().match(/[a-z0-9]+/g) || []
  const hits = new Map()   // id -> {n, score}
  for (const t of terms) if (t.length > 2) for (const n of search(db, t, 40)) {
    const prev = hits.get(n.id) || { n, score: 0 }
    prev.score += (TYPE_WEIGHT[n.type] || 1)   // term match, weighted by how "answerable" the node type is
    hits.set(n.id, prev)
  }
  const best = [...hits.values()].sort((a, b) => b.score - a.score)[0]
  if (!best) return { ok: false, text: 'Coverage gap: nothing in the brain matches that question.', citations: [] }
  const bundle = getContextBundle(db, best.n.id, { hops: 1, source })
  const lines = [
    `**${bundle.node.name || bundle.node.id}** (${bundle.node.type})`,
    bundle.node.data?.purpose ? `\n${bundle.node.data.purpose}` : '',
    bundle.facts.length ? `\nConnections:\n${bundle.facts.slice(0, 20).map((f) => `- ${f}`).join('\n')}` : '',
    bundle.citations.length ? `\nGrounded in:\n${bundle.citations.slice(0, 8).map((c) => `- \`${c.file}:${c.line}\``).join('\n')}` : '',
  ].filter(Boolean)
  return { ok: true, node: bundle.node.id, text: lines.join('\n'), citations: bundle.citations.slice(0, 8) }
}
