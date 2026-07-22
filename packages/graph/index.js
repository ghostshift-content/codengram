// @codengram/graph — M3: the canonical SQLite knowledge graph + staging (BLUEPRINT §4b, §4f, §14.8).
//
// `index.sqlite` is the single source of truth; Markdown/JSONL are generated FROM it (M4). Workers write a
// per-attempt `staging.sqlite`; only a validated TRANSACTIONAL merge reaches index. Upserts are keyed by stable id
// so a re-scan updates in place (no duplicates) — the basis for incremental refresh. Uses the platform's built-in
// SQLite (`node:sqlite`) — zero native deps.
import { DatabaseSync } from 'node:sqlite'
import { EDGE_SQL_MAP, isValidNode, isValidEdge, SCHEMA_VERSION, provenance, claim as makeClaim, isValidClaim, INVENTORY_STATUS } from '../schemas/index.js'
const INVENTORY_TERMINAL = new Set(INVENTORY_STATUS)

const DDL = `
CREATE TABLE IF NOT EXISTS meta   (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS nodes  (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT, data TEXT,
                                   snapshot_id TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS edges  (id TEXT PRIMARY KEY, type TEXT NOT NULL, src TEXT NOT NULL, dst TEXT NOT NULL,
                                   data TEXT, snapshot_id TEXT);
CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, node_id TEXT, edge_id TEXT, field TEXT, snapshot_id TEXT,
                                   file TEXT, line_start INTEGER, line_end INTEGER, confidence TEXT, method TEXT);
CREATE TABLE IF NOT EXISTS reconciliation (id TEXT PRIMARY KEY, kind TEXT, file TEXT, line INTEGER, entry TEXT,
                                   status TEXT NOT NULL, feature_id TEXT, snapshot_id TEXT);
CREATE INDEX IF NOT EXISTS ix_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS ix_recon_status ON reconciliation(status);
CREATE INDEX IF NOT EXISTS ix_edges_src  ON edges(src);
CREATE INDEX IF NOT EXISTS ix_edges_dst  ON edges(dst);
CREATE INDEX IF NOT EXISTS ix_claims_node ON claims(node_id);
`
const edgeId = (e) => `${e.type}:${e.from}->${e.to}`

export function openGraph(dbPath = ':memory:') {
  const db = new DatabaseSync(dbPath)
  try {
    // journal_mode=DELETE keeps the graph a SINGLE file (no -wal sidecar), so an atomic publish is one rename.
    db.exec('PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON;')
    db.exec(DDL)
    const cur = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()
    if (!cur) db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?)").run(SCHEMA_VERSION)
    // #14: no migration path yet — REJECT an existing DB written by an incompatible schema rather than corrupting it.
    else if (cur.value !== SCHEMA_VERSION) throw new Error(`graph schema ${cur.value} != ${SCHEMA_VERSION}; delete/rebuild this snapshot (no migration path yet)`)
    return db
  } catch (error) {
    try { db.close() } catch {}
    throw error
  }
}

// Upsert a node by stable id; JSON `data` is shallow-merged so re-scans enrich rather than clobber.
export function upsertNode(db, node) {
  if (!isValidNode(node)) throw new Error(`invalid node: ${JSON.stringify(node)}`)
  const prev = db.prepare('SELECT data FROM nodes WHERE id=?').get(node.id)
  const data = { ...(prev ? JSON.parse(prev.data || '{}') : {}), ...(node.data || {}) }
  db.prepare(`INSERT INTO nodes(id,type,name,data,snapshot_id,created_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=COALESCE(excluded.name,nodes.name), data=excluded.data,
      snapshot_id=COALESCE(excluded.snapshot_id,nodes.snapshot_id)`)
    .run(node.id, node.type, node.name ?? null, JSON.stringify(data), node.snapshot_id ?? null, node.created_at ?? new Date().toISOString())
  return node.id
}
// Canonical direction is {from,to}; columns are src/dst (EDGE_SQL_MAP).
// #7: both endpoints MUST already exist — a dangling edge can never enter the graph (SQLite has no FK on these cols).
export function upsertEdge(db, edge) {
  if (!isValidEdge(edge)) throw new Error(`invalid edge: ${JSON.stringify(edge)}`)
  if (!db.prepare('SELECT 1 FROM nodes WHERE id=?').get(edge.from)) throw new Error(`edge ${edge.type} references missing src node ${edge.from}`)
  if (!db.prepare('SELECT 1 FROM nodes WHERE id=?').get(edge.to)) throw new Error(`edge ${edge.type} references missing dst node ${edge.to}`)
  const id = edgeId(edge)
  db.prepare(`INSERT INTO edges(id,type,${EDGE_SQL_MAP.from},${EDGE_SQL_MAP.to},data,snapshot_id) VALUES(?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data`)
    .run(id, edge.type, edge.from, edge.to, JSON.stringify(edge.data || {}), edge.snapshot_id ?? null)
  return id
}
// #4: a claim is validated STRICTLY before insert — well-formed provenance, exactly one of node/edge, and the
// referenced node/edge must actually EXIST in this graph. No unvalidated rows reach the store.
export function addClaim(db, c) {
  const prov = provenance({ snapshot_id: c.snapshot_id, file: c.file, line_start: c.line_start, line_end: c.line_end, confidence: c.confidence, method: c.method, field: c.field })
  const logical = makeClaim({ id: c.id, node_id: c.node_id ?? null, edge_id: c.edge_id ?? null, field: c.field, prov })
  if (!isValidClaim(logical)) throw new Error(`invalid claim ${JSON.stringify(c.id)} (bad provenance or not exactly one of node/edge)`)
  if (c.node_id && !db.prepare('SELECT 1 FROM nodes WHERE id=?').get(c.node_id)) throw new Error(`claim ${c.id} references missing node ${c.node_id}`)
  if (c.edge_id && !db.prepare('SELECT 1 FROM edges WHERE id=?').get(c.edge_id)) throw new Error(`claim ${c.id} references missing edge ${c.edge_id}`)
  db.prepare(`INSERT INTO claims(id,node_id,edge_id,field,snapshot_id,file,line_start,line_end,confidence,method)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
    .run(c.id, c.node_id ?? null, c.edge_id ?? null, c.field ?? null, prov.snapshot_id, prov.file, prov.line_start, prov.line_end, prov.confidence, prov.method)
}

// #6: per-item reconciliation ledger — every inventory row is recorded with its TERMINAL status (not summary math).
export function addReconItem(db, r) {
  if (!INVENTORY_TERMINAL.has(r.status)) throw new Error(`invalid reconciliation status ${r.status}`)
  db.prepare(`INSERT INTO reconciliation(id,kind,file,line,entry,status,feature_id,snapshot_id) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status, feature_id=excluded.feature_id`)
    .run(r.id, r.kind ?? null, r.file ?? null, r.line ?? null, r.entry ?? null, r.status, r.feature_id ?? null, r.snapshot_id ?? null)
}
export const reconCounts = (db) => Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM reconciliation GROUP BY status').all().map((x) => [x.status, x.n]))
export const reconTotal = (db) => db.prepare('SELECT COUNT(*) n FROM reconciliation').get().n

export const getNode = (db, id) => { const r = db.prepare('SELECT * FROM nodes WHERE id=?').get(id); return r ? rowToNode(r) : null }
const rowToNode = (r) => ({ id: r.id, type: r.type, name: r.name, data: JSON.parse(r.data || '{}'), snapshot_id: r.snapshot_id })
export const counts = (db) => ({
  nodes: db.prepare('SELECT COUNT(*) n FROM nodes').get().n,
  edges: db.prepare('SELECT COUNT(*) n FROM edges').get().n,
  claims: db.prepare('SELECT COUNT(*) n FROM claims').get().n,
})
export const nodesByType = (db, type) => db.prepare('SELECT * FROM nodes WHERE type=? ORDER BY id').all(type).map(rowToNode)
export const claimsForNode = (db, id) => db.prepare('SELECT * FROM claims WHERE node_id=?').all(id)

// Bounded neighbourhood: BFS over edges up to `hops`, capped at `cap` nodes (never render the whole graph).
export function neighbourhood(db, id, hops = 1, cap = 1000) {
  const seen = new Set([id]), edges = []
  let frontier = [id]
  const outE = db.prepare('SELECT * FROM edges WHERE src=?'), inE = db.prepare('SELECT * FROM edges WHERE dst=?')
  for (let h = 0; h < hops && seen.size < cap; h++) {
    const next = []
    for (const cur of frontier) {
      for (const e of [...outE.all(cur), ...inE.all(cur)]) {
        edges.push({ id: e.id, type: e.type, from: e.src, to: e.dst, data: JSON.parse(e.data || '{}') })
        for (const nb of [e.src, e.dst]) if (!seen.has(nb) && seen.size < cap) { seen.add(nb); next.push(nb) }
      }
    }
    frontier = next
  }
  const nodes = [...seen].map((n) => getNode(db, n)).filter(Boolean)
  const uniqE = [...new Map(edges.map((e) => [e.id, e])).values()].filter((e) => seen.has(e.from) && seen.has(e.to))
  return { nodes, edges: uniqE }
}
export const search = (db, q, limit = 50) =>
  db.prepare("SELECT * FROM nodes WHERE name LIKE ? OR id LIKE ? ORDER BY type LIMIT ?").all(`%${q}%`, `%${q}%`, limit).map(rowToNode)

// ── staging → index transactional merge (§4f) ─────────────────────────────────────────────────
// Merge every row of a staging graph into index inside ONE transaction. A throw rolls the whole merge back —
// a partial worker attempt can never half-populate the canonical graph.
export function mergeStaging(indexDb, stagingDb) {
  const nodes = stagingDb.prepare('SELECT * FROM nodes').all()
  const edges = stagingDb.prepare('SELECT * FROM edges').all()
  const claims = stagingDb.prepare('SELECT * FROM claims').all()
  const recon = stagingDb.prepare('SELECT * FROM reconciliation').all()
  indexDb.exec('BEGIN')
  try {
    for (const r of nodes) upsertNode(indexDb, rowToNode(r))   // all nodes first, so edge endpoints exist (#7)
    for (const r of edges) upsertEdge(indexDb, { id: r.id, type: r.type, from: r.src, to: r.dst, data: JSON.parse(r.data || '{}'), snapshot_id: r.snapshot_id })
    for (const c of claims) addClaim(indexDb, c)
    for (const r of recon) addReconItem(indexDb, r)
    indexDb.exec('COMMIT')
  } catch (e) { indexDb.exec('ROLLBACK'); throw e }
  return counts(indexDb)
}
