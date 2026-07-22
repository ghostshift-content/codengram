// @codengram/schemas — the ONE canonical contract every package, the SQL store, the JSONL export, and the API
// derive from. Pure constants + strict validators + deterministic id builders + state machines. No storage, no I/O.

export const SCHEMA_VERSION = '0.3.0'
export const EXPORTER_VERSION = '0.3.0'

// ── Knowledge-graph vocabulary — the ONLY types allowed. Prompts/plugins may NOT invent new ones; language kinds
// (concern/finder/policy) are expressed as SERVICE/AUTH_CHECK with a `data.kind`, never as new node types. ───────
export const NODE_TYPES = Object.freeze([
  'PROJECT', 'SNAPSHOT', 'DOMAIN', 'FILE', 'SYMBOL', 'PROCESS', 'FEATURE', 'ROUTE', 'ENDPOINT',
  'GRAPHQL_OPERATION', 'JOB', 'SERVICE', 'MODEL', 'ROLE', 'PERMISSION', 'AUTH_CHECK',
  'TOKEN', 'DATA_STORE', 'INTEGRATION', 'TRUST_BOUNDARY', 'DATA_FLOW', 'COVERAGE_GAP',
])
export const EDGE_TYPES = Object.freeze([
  'CONTAINS', 'DEFINES', 'EXPOSES', 'HANDLED_BY', 'CALLS', 'READS', 'WRITES',
  'ENQUEUES', 'AUTHENTICATED_BY', 'AUTHORIZED_BY', 'REQUIRES_ROLE', 'CROSSES_BOUNDARY',
  'RETURNS_DATA', 'USES_SERVICE', 'USES_INTEGRATION', 'SHARES_IMPLEMENTATION_WITH',
])
// The `kind` discriminator for SERVICE / AUTH_CHECK nodes so language-specific roles stay in ONE canonical type.
export const SERVICE_KINDS = Object.freeze(['service', 'finder', 'concern', 'helper', 'presenter', 'serializer'])
export const AUTH_CHECK_KINDS = Object.freeze(['policy', 'before_action', 'ability', 'guard', 'route_setting'])

// CANONICAL edge direction is { from, to } everywhere. SQL columns are `src`/`dst` (SQLite reserves `from`); the
// graph package maps from→src, to→dst. Confidence is 'high' | 'medium' | 'low' (never 'med').
export const CONFIDENCE = Object.freeze(['high', 'medium', 'low'])
export const EDGE_SQL_MAP = Object.freeze({ from: 'src', to: 'dst' })

export const PROVENANCE_METHODS = Object.freeze(['grep', 'ast', 'symbol-index', 'manifest', 'config', 'repo-level', 'generated', 'llm-map'])
export const NO_LINE_METHODS = new Set(['manifest', 'config', 'repo-level', 'generated'])

export const INVENTORY_STATUS = Object.freeze([
  'MAPPED_TO_FEATURE', 'SHARED_INFRASTRUCTURE', 'NOT_RELEVANT_WITH_REASON',
  'UNCLEAR_COVERAGE_GAP', 'DEAD_OR_UNREACHABLE_WITH_EVIDENCE',
])
export const INVENTORY_FILES = Object.freeze([
  '01_routes_endpoints', '02_rest_api', '03_graphql', '04_workers_jobs',
  '05_services_finders_policies', '06_response_shaping', '07_downloads_uploads_exports',
  '08_search_aggregation', '09_tokens_actors', '10_processes_ipc', '11_datastores_integrations',
])
export const RECON_PHASES = Object.freeze([
  { n: 1, key: 'scale_and_shape', title: 'Scale & shape' },
  { n: 2, key: 'architecture', title: 'Architecture, processes, IPC, stores, external services' },
  { n: 3, key: 'domain_map', title: 'Domains, features, integrations, importers, subsystems' },
  { n: 4, key: 'auth_and_roles', title: 'AuthN, actors, roles, permissions, policies, tokens, OAuth, admin, 2FA' },
  { n: 5, key: 'communication', title: 'REST, GraphQL, gRPC, WebSocket, queues, webhooks, uploads, downloads, CLI' },
  { n: 6, key: 'synthesis', title: 'Feature synthesis, data flows, trust boundaries, shared infra, gaps' },
])

// ── Three separate state machines (mission ≠ task ≠ publication). ────────────────────────────────────────────
export const MISSION_STATES = Object.freeze(['QUEUED', 'PROFILING', 'PLANNING', 'RUNNING', 'RECONCILING', 'PAUSED_QUOTA', 'CANCELLING', 'CANCELLED', 'FAILED', 'COMPLETED'])
export const TASK_STATES = Object.freeze(['QUEUED', 'CLAIMED', 'RUNNING', 'RETRY_WAIT', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'])
export const PUBLICATION_STATES = Object.freeze(['UNPUBLISHED', 'COMPLETE', 'COMPLETE_WITH_GAPS'])
const MISSION_TERMINAL = new Set(['CANCELLED', 'FAILED', 'COMPLETED'])
const TASK_TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'])
const MISSION_TX = {
  QUEUED: ['PROFILING', 'CANCELLING', 'FAILED'], PROFILING: ['PLANNING', 'PAUSED_QUOTA', 'CANCELLING', 'FAILED'],
  PLANNING: ['RUNNING', 'PAUSED_QUOTA', 'CANCELLING', 'FAILED'], RUNNING: ['RECONCILING', 'PAUSED_QUOTA', 'CANCELLING', 'FAILED'],
  RECONCILING: ['COMPLETED', 'PAUSED_QUOTA', 'CANCELLING', 'FAILED'], PAUSED_QUOTA: ['PROFILING', 'PLANNING', 'RUNNING', 'RECONCILING', 'CANCELLING', 'FAILED'],
  CANCELLING: ['CANCELLED', 'FAILED'], CANCELLED: [], FAILED: [], COMPLETED: [],
}
const TASK_TX = {
  QUEUED: ['CLAIMED', 'CANCELLED', 'BLOCKED'], CLAIMED: ['RUNNING', 'QUEUED', 'CANCELLED', 'FAILED'],
  RUNNING: ['COMPLETED', 'RETRY_WAIT', 'PAUSED', 'FAILED', 'CANCELLED', 'BLOCKED'],
  RETRY_WAIT: ['QUEUED', 'CANCELLED', 'FAILED'], PAUSED: ['QUEUED', 'RUNNING', 'CANCELLED'],
  COMPLETED: [], FAILED: [], CANCELLED: [], BLOCKED: [],
}
export const isMissionTerminal = (s) => MISSION_TERMINAL.has(s)
export const isTaskTerminal = (s) => TASK_TERMINAL.has(s)
export const canMissionTransition = (a, b) => !!(MISSION_TX[a] && MISSION_TX[a].includes(b))
export const canTaskTransition = (a, b) => !!(TASK_TX[a] && TASK_TX[a].includes(b))

// ── Deterministic ids — traversal-safe, non-empty, collision-resistant. Same input ⇒ same id (refresh + diff). ─
const _hash6 = (s) => { let h = 5381; s = String(s); for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36).padStart(6, '0').slice(0, 6) }
export const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
// #7 canonical relative path: forward slashes, no leading `/`, and NO `..` segment (rejects `../../etc/passwd`).
export function safeRelPath(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '')
  if (!s || s.split('/').some((seg) => seg === '..' || seg === '')) throw new Error(`unsafe/invalid path: ${p}`)
  return s
}
export const normRoute = (r) => String(r || '').replace(/:\w+/g, ':param').replace(/\{[^}]+\}/g, ':param').replace(/\/+$/, '') || '/'
const _reqSlug = (s, what) => { const v = slug(s); if (!v) throw new Error(`empty ${what || 'slug'} from: ${JSON.stringify(s)}`); return v }
export const ID = Object.freeze({
  // #7 project id is derived from a STABLE KEY (absolute repo path / git remote), independent of the display name,
  // with a hash suffix for collision resistance.
  project: (stableKey) => { const k = String(stableKey || ''); if (!k) throw new Error('project id needs a stable key (repo path)'); return `project:${slug(k.split('/').pop() || 'repo') || 'repo'}-${_hash6(k)}` },
  snapshot: (hash) => { const h = String(hash || '').replace(/[^a-z0-9]/gi, ''); if (!h) throw new Error('snapshot id needs a hash'); return `snapshot:${h.slice(0, 40)}` },
  file: (path) => `file:${safeRelPath(path)}`,
  symbol: (path, qname) => `symbol:${safeRelPath(path)}#${_reqSlug(qname, 'symbol name') && String(qname).trim()}`,
  endpoint: (method, route) => `endpoint:${String(method || 'ANY').toUpperCase()}:${normRoute(route)}`,
  feature: (domainOrSlug, name) => `feature:${_reqSlug(name ? `${domainOrSlug}-${name}` : domainOrSlug, 'feature slug')}`,
  role: (name) => `role:${_reqSlug(name, 'role')}`,
  domain: (name) => `domain:${_reqSlug(name, 'domain')}`,
  // Row-derived ids keep a readable prefix AND a hash of the full logical key. Using slug() alone truncates at
  // 80 characters and silently collides on large monorepos with long common path prefixes.
  scoped: (prefix, ...parts) => {
    const p = _reqSlug(prefix, 'id prefix'), raw = parts.map(String).join('\u001f'), readable = slug(raw).slice(0, 58) || 'item'
    return `${p}:${readable}-${_hash6(raw)}`
  },
})
// #7 id↔type consistency: a node whose type has a canonical builder must carry that id prefix.
const TYPE_PREFIX = { PROJECT: 'project:', SNAPSHOT: 'snapshot:', DOMAIN: 'domain:', FILE: 'file:', SYMBOL: 'symbol:', FEATURE: 'feature:', ENDPOINT: 'endpoint:', ROLE: 'role:' }

// ── validators (strict) ──────────────────────────────────────────────────────────────────────
export function isValidNode(n) {
  if (!(n && NODE_TYPES.includes(n.type) && typeof n.id === 'string' && n.id)) return false
  const pfx = TYPE_PREFIX[n.type]
  return pfx ? n.id.startsWith(pfx) : true
}
export function isValidEdge(e) { return !!(e && EDGE_TYPES.includes(e.type) && typeof e.from === 'string' && e.from && typeof e.to === 'string' && e.to) }

// provenance — grounded, per-field, with POSITIVE, ORDERED line ranges. Line-anchored methods need a range;
// repo/generated methods may omit it but must declare the method (never a fake line).
export function provenance({ snapshot_id, file, line_start = null, line_end = null, confidence = 'medium', method = 'grep', field = null }) {
  const ls = Number.isFinite(line_start) ? line_start : null
  return {
    snapshot_id: String(snapshot_id || ''), file: String(file || ''),
    line_start: ls, line_end: Number.isFinite(line_end) ? line_end : ls,
    confidence: CONFIDENCE.includes(confidence) ? confidence : 'medium',
    method: PROVENANCE_METHODS.includes(method) ? method : 'grep',
    field: field ? String(field) : null,
  }
}
export function isValidProvenance(p) {
  if (!(p && typeof p === 'object')) return false
  if (!p.snapshot_id || !p.file || !CONFIDENCE.includes(p.confidence) || !PROVENANCE_METHODS.includes(p.method)) return false
  if (NO_LINE_METHODS.has(p.method)) return true                       // repo/generated: no line required
  if (!Number.isFinite(p.line_start) || p.line_start <= 0) return false // line-anchored: needs a positive start
  if (Number.isFinite(p.line_end) && p.line_end < p.line_start) return false // #7 ordered range
  return true
}
// A claim ties ONE provenance to exactly ONE node OR edge, on a named field. #7: strict.
export function claim({ id, node_id = null, edge_id = null, field, prov }) {
  return { claim_id: id, node_id, edge_id, field: field || null, provenance: prov }
}
export function isValidClaim(c) {
  if (!(c && typeof c === 'object' && c.claim_id && c.field)) return false
  if (!!c.node_id === !!c.edge_id) return false                        // exactly one of node_id / edge_id
  return isValidProvenance(c.provenance)
}

// self-check
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = await import('node:assert')
  assert.ok(NODE_TYPES.length === 22 && NODE_TYPES.includes('DOMAIN'))
  // id↔type consistency
  assert.ok(isValidNode({ type: 'FEATURE', id: ID.feature('identity', 'oauth') }) && !isValidNode({ type: 'FEATURE', id: 'x' }))
  // #7 traversal + empty rejection
  assert.throws(() => ID.file('../../etc/passwd')); assert.throws(() => ID.project('')); assert.throws(() => ID.role('!!!'))
  assert.ok(ID.project('/Users/me/code/acme').startsWith('project:acme-'))
  // #7 ordered/positive line ranges
  assert.ok(!isValidProvenance(provenance({ snapshot_id: 's', file: 'a', line_start: 10, line_end: 2, method: 'ast' })))
  assert.ok(isValidProvenance(provenance({ snapshot_id: 's', file: 'a', line_start: 3, line_end: 9, method: 'ast' })))
  // #7 claim strictness
  assert.ok(!isValidClaim({})); assert.ok(!isValidClaim({ claim_id: 'c', node_id: 'n', edge_id: 'e', field: 'x', provenance: provenance({ snapshot_id: 's', file: 'a', method: 'manifest' }) }))
  assert.ok(isValidClaim({ claim_id: 'c', node_id: ID.feature('d', 'f'), field: 'purpose', provenance: provenance({ snapshot_id: 's', file: 'Gemfile', method: 'manifest' }) }))
  console.log('ok — schemas: DOMAIN type, safe ids, ordered provenance, strict claims, id↔type consistency')
}
