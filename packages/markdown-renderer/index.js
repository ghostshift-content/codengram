// @codengram/markdown-renderer — M4: generate the portable `phase1-maps/` tree FROM the sealed SQLite graph.
//
// SQLite is canonical; this is a pure projection of it. The Markdown↔graph count check (BLUEPRINT §14.9) is what
// proves the projection is faithful before a snapshot seals. Everything here reads the graph — no re-analysis.
import fs from 'node:fs'
import path from 'node:path'
import { counts, nodesByType, neighbourhood, getNode } from '../graph/index.js'
import { EXPORTER_VERSION } from '../schemas/index.js'

const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body) }
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')

// Render everything into <outDir>/phase1-maps. Returns { files:[...], crosscheck:{ ok, graph, markdown } }.
export function renderPhase1Maps(db, outDir, { project, snapshot, coverage, gate, inventories, provenance } = {}) {
  const root = path.join(outDir, 'phase1-maps')
  const features = nodesByType(db, 'FEATURE')
  const domains = nodesByType(db, 'DOMAIN')
  const clusters = nodesByType(db, 'ARCH_CLUSTER')
  const blocked = gate?.status === 'SEMANTIC_PLANNING_BLOCKED'
  const files = []
  const emit = (rel, body) => { write(path.join(root, rel), body); files.push(rel) }
  const emitQueryJsonl = (rel, sql, map) => {
    const file = path.join(root, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '')
    files.push(rel)
    const stmt = db.prepare(`${sql} LIMIT ? OFFSET ?`)
    let offset = 0, total = 0
    while (true) {
      const rows = stmt.all(1000, offset)
      if (!rows.length) break
      fs.appendFileSync(file, rows.map((row) => JSON.stringify(map(row))).join('\n') + '\n')
      total += rows.length
      offset += rows.length
    }
    return total
  }

  // graph/*.jsonl — the machine-readable projection (ALL canonical node types, so nothing in the graph is dropped)
  const projectedNodes = emitQueryJsonl('graph/nodes.jsonl', 'SELECT id,type,name,data FROM nodes ORDER BY id',
    (n) => ({ id: n.id, type: n.type, name: n.name, data: JSON.parse(n.data || '{}') }))
  const projectedEdges = emitQueryJsonl('graph/edges.jsonl', 'SELECT id,type,src,dst,data FROM edges ORDER BY id',
    (e) => ({ id: e.id, type: e.type, from: e.src, to: e.dst, data: JSON.parse(e.data || '{}') }))
  emit('graph/aliases.json', JSON.stringify({ version: EXPORTER_VERSION }, null, 2))

  // inventories/*.txt — regenerated from the extracted lists (source of truth kept alongside the graph)
  if (inventories) {
    const keys = Object.keys(inventories)
    keys.forEach((k, i) => emit(`inventories/${String(i + 1).padStart(2, '0')}_${k}.txt`,
      (inventories[k] || []).map((r) => `${r.file}:${r.line} · ${r.entry}${r.detail ? ` · ${r.detail}` : ''}`).join('\n') + (inventories[k]?.length ? '\n' : '')))
    emit('inventories/00_MANIFEST.md', renderInventoryManifest(inventories, db))
  }

  // features/<slug>.md — the 13-section contract, projected from the graph (§13c)
  for (const f of features) {
    const featureSlug = f.data.slug || f.id.replace(/^feature:/, '')
    emit(`features/${featureSlug}.md`, renderFeatureMarkdown(db, f))
    emit(`ledgers/${featureSlug}.jsonl`, renderFeatureLedger(db, f))
  }

  // consolidated/* — the architecture view lists technical clusters (always present when blocked; supplementary
  // when semantic). Under a blocked run these clusters are the ONLY structural output — never dressed up as features.
  // roles/ — the subject axis (actors + role ladder + role→ability matrix), built from the evidence-validated
  // ontology. These contract files are always emitted; an unproved identity model is an explicit gap, not a missing
  // directory that a downstream reviewer could mistake for "no roles exist".
  const roleNodes = nodesByType(db, 'ROLE'), actorNodes = nodesByType(db, 'ACTOR')
  const roleArtifacts = renderRoles(db, roleNodes, actorNodes)
  emit('roles/role-structure.md', roleArtifacts.structure)
  emit('roles/role-ability-matrix.md', roleArtifacts.matrix)
  emit('roles/role_authz_source_files.txt', roleArtifacts.sourceFiles)
  emit('roles/role_structure_hints.txt', roleArtifacts.hints)
  if (clusters.length) emit('consolidated/architecture.md', renderArchitecture(db, clusters, coverage, gate, blocked))
  emit('consolidated/00_INDEX.md', renderIndex(features, domains, blocked, clusters, db))
  emit('consolidated/feature_coverage_matrix.md', renderCoverage(features, coverage, blocked))
  emit('consolidated/source_inventory_coverage_matrix.md', renderSourceCoverage(db, inventories))
  emit('consolidated/same_functionality_cross_feature_map.md', renderSameFunctionality(db, features, clusters))
  emit('consolidated/phase2_review_queue.md', renderPhase2Queue(db, features, blocked))
  emit('consolidated/phase1_completion_gate.md', renderGate(gate, coverage, provenance))

  // top-level
  const c = counts(db)
  emit('README.md', renderReadme(project, snapshot, c, features, { blocked, coverage, clusters, provenance }))
  emit('AI_CONTEXT.md', renderAiContext(project, snapshot, features, c, { blocked, coverage, clusters }))

  // §14.9 cross-check each family independently; equal sums must not hide one missing node plus one extra edge.
  const md = projectedNodes + projectedEdges, graph = c.nodes + c.edges
  const crosscheck = { ok: projectedNodes === c.nodes && projectedEdges === c.edges, graph, markdown: md,
    nodes: { graph: c.nodes, projected: projectedNodes }, edges: { graph: c.edges, projected: projectedEdges } }
  emit('consolidated/phase1_crosscheck_verification.md',
    `# Cross-check\n\n- graph nodes: ${c.nodes}; projected nodes: ${projectedNodes}\n- graph edges: ${c.edges}; projected edges: ${projectedEdges}\n- graph nodes+edges: ${graph}\n- projected nodes+edges: ${md}\n- **match: ${crosscheck.ok ? 'YES' : 'NO'}**\n`)
  // Write the manifest last so its inventory includes the cross-check and the manifest itself.
  const manifestFiles = [...files, 'manifest.json']
  // The publication fingerprint the spec requires: planner/session/model evidence + all component versions + the
  // gate outcome, so a stale plan or a version bump is detectable and another AI session can trust the provenance.
  emit('manifest.json', JSON.stringify({ exporter_version: EXPORTER_VERSION, project: project?.id,
    snapshot: snapshot?.id, counts: c, gate: gate?.status || null,
    semantic: provenance?.semantic ?? null, requested_planner: provenance?.requested_planner ?? null,
    executed_planner: provenance?.executed_planner ?? null, lead_session_id: provenance?.lead_session_id ?? null,
    model: provenance?.model ?? null, failure_reason: provenance?.failure_reason ?? null,
    recon_skill: provenance?.recon_skill ?? null,
    validation_result: provenance?.validation_result ?? null, versions: provenance?.versions ?? null,
    semantic_coverage: coverage?.semantic_coverage ?? null, technical_coverage: coverage?.technical_coverage ?? null,
    feature_count: features.length, technical_clusters: clusters.length, files: manifestFiles }, null, 2))
  return { root, files, crosscheck }
}

export function renderFeatureMarkdown(db, f) {
  const nb = neighbourhood(db, f.id, 2, 3000)
  const claimMap = directClaimsByNode(db, f.id)
  // Query each direct family independently. A high-cardinality family (for example thousands of Rails routes)
  // must never consume a generic BFS cap and hide REST, GraphQL, jobs, identity, models, or services.
  const directByType = (type) => db.prepare(`SELECT n.* FROM nodes n JOIN edges e ON e.dst=n.id
    WHERE e.src=? AND n.type=? ORDER BY n.id`).all(f.id, type)
    .map((n) => ({ id: n.id, type: n.type, name: n.name, data: JSON.parse(n.data || '{}') }))
  const byType = (t, direct = true) => direct ? directByType(t) : nb.nodes.filter((n) => n.type === t)
  const cite = (n) => { const c = claimMap.get(n.id)?.[0]; return c?.file ? ` \`${c.file}:${c.line_start}\`` : (n.data?.file ? ` \`${n.data.file}:${n.data.line || 1}\`` : '') }
  const list = (nodes, max = 60) => nodes.length
    ? [...nodes.slice(0, max).map((n) => `- ${n.name || n.id}${cite(n)}`), ...(nodes.length > max ? [`- _… ${nodes.length - max} more in \`../ledgers/${f.data.slug}.jsonl\`_`] : [])].join('\n')
    : '- _none found_'
  const files = f.data.files || []
  const entries = [...byType('ENDPOINT'), ...byType('ROUTE'), ...byType('GRAPHQL_OPERATION'), ...byType('JOB')]
  const auth = byType('AUTH_CHECK'), roles = byType('ROLE', false), permissions = byType('PERMISSION')
  const models = byType('MODEL'), services = byType('SERVICE'), flows = byType('DATA_FLOW', false)
  const shares = nb.edges.filter((e) => e.type === 'SHARES_IMPLEMENTATION_WITH' && (e.from === f.id || e.to === f.id))
    .map((e) => getNode(db, e.from === f.id ? e.to : e.from)).filter(Boolean)
  const roleText = roles.length ? roles.slice(0, 12).map((r) => `\`${r.name}\``).join(', ') : '_not established_'
  const objectText = models.length ? `${models.slice(0, 24).map((m) => `\`${m.name}\``).join(', ')}${models.length > 24 ? `, _… ${models.length - 24} more_` : ''}` : '_not established_'
  return [
    `# ${f.name}`, '',
    `## 1. Feature Identity`, `- Slug: \`${f.data.slug}\``, `- Domain: \`${f.data.domain}\``,
    `- Main business objects: ${objectText}`, `- Observed roles: ${roleText}`, `- Planning: \`${f.data.planning_method || 'deterministic'}\` · confidence \`${f.data.confidence || 'medium'}\``, '',
    `## 2. Feature Purpose`, f.data.purpose || '_n/a_', '',
    `## 3. Entry Points`, renderEntryPoints(entries, auth, f.data.slug), '',
    `## 4. Endpoint / Action Ledger`, renderLedger(db, nb, f, claimMap), '',
    `## 5. Full Code Paths`, renderCodePaths(db, nb, entries, services, models), '',
    `## 6. Authorization Map`, renderAuthorization(auth.filter((n) => n.data?.kind === 'policy'), permissions, roles, cite), '',
    `## 7. Authentication / Actor Context Map`, renderAuthorization(auth.filter((n) => n.data?.kind !== 'policy'), permissions, roles, cite), '',
    `## 8. Data Exposure Map`, list([...services.filter((n) => n.data?.kind === 'serializer'), ...flows, ...models]), '',
    `## 9. Background Job Map`, list(byType('JOB')), '',
    `## 10. Same-Functionality Map`, shares.length ? shares.map((s) => `- [${s.name}](./${s.data.slug}.md) — shares implementation`).join('\n') : '- _no shared implementation detected_', '',
    `## 11. Review Context (structural leads — NOT findings)`, renderReviewContext(entries, auth, models, flows), '',
    `## 12. Files Reviewed`, files.length ? [...files.slice(0, 140).map((x) => `- \`${x}\``), ...(files.length > 140 ? [`- _… ${files.length - 140} more; exhaustive rows are in \`../ledgers/${f.data.slug}.jsonl\`_`] : [])].join('\n') : '- _none_', '',
    `## 13. Coverage Notes`, `- Inventory rows mapped: ${f.data.row_count || 0}`, `- Files connected: ${files.length}`,
    `- Entry points: ${entries.length}; auth checks: ${auth.length}; models: ${models.length}; services: ${services.length}; jobs: ${byType('JOB').length}`,
    `- Depth: ${f.data.planning_method === 'agent-lead' ? 'Lead-planned and source-grounded' : 'structure-mapped; semantic interpretation remains estimated'}.`, '',
  ].join('\n')
}
const cell = (v) => String(v == null || v === '' ? '—' : v).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
const sourceRef = (n) => n.data?.file ? `${n.data.file}:${n.data.line || 1}` : '—'
const methodOf = (n) => n.data?.method || n.name?.match(/^(GET|POST|PUT|PATCH|DELETE)\b/i)?.[1]?.toUpperCase() || '—'
const purposeOf = (n, fallback) => n.data?.purpose || fallback
const authFor = (n, auth) => {
  if (n.data?.auth_notes) return n.data.auth_notes
  const sameFile = auth.filter((a) => a.data?.file && a.data.file === n.data?.file).map((a) => a.name).slice(0, 4)
  return sameFile.length ? sameFile.join('; ') : 'Shared control / not mapped to this entry'
}
const controllerOf = (n) => {
  if (n.data?.handler) return n.data.handler
  const file = String(n.data?.file || '')
  const match = file.match(/app\/controllers\/(.+)_controller\.rb$/)
  const klass = match ? match[1].split('/').map((part) => part.replace(/(^|_)(\w)/g, (_, __, c) => c.toUpperCase())).join('::') + 'Controller' : file
  const action = n.name?.match(/^action\s+(\w+)/)?.[1]
  return action ? `${klass}#${action}` : klass || '—'
}
// Empty-state tokens (spec): "not extracted" is NEVER "none exist". A channel our extractors COVER but this feature
// has none of → COVERAGE_GAP. A channel no extractor covers for this stack (RPC/WS/CLI/Events today) → EXTRACTOR_UNSUPPORTED.
const emptyLine = (title, state) => state === 'EXTRACTOR_UNSUPPORTED'
  ? `**EXTRACTOR_UNSUPPORTED** — _no extractor covers ${title.toLowerCase()} for this stack; absence here is not evidence that none exist._`
  : `**COVERAGE_GAP** — _no ${title.toLowerCase()} entries were mapped to this feature; an explicit gap, not proof that none exist._`
function renderEntryPoints(entries, auth, featureSlug) {
  const blocks = []
  const max = 80
  const add = (title, header, rows, values, emptyState = 'COVERAGE_GAP') => {
    blocks.push(`### ${title}`)
    if (!rows.length) { blocks.push(emptyLine(title, emptyState), ''); return }
    blocks.push(`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`,
      ...rows.slice(0, max).map((n) => `| ${values(n).map(cell).join(' | ')} |`))
    if (rows.length > max) blocks.push(`_… ${rows.length - max} more ${title.toLowerCase()} entries in \`../ledgers/${featureSlug}.jsonl\`._`)
    blocks.push('')
  }
  const web = entries.filter((n) => (n.type === 'ROUTE' || n.type === 'ENDPOINT') && n.data?.interface_kind !== 'rest' && n.data?.interface_kind !== 'rpc' && n.data?.interface_kind !== 'websocket' && n.data?.interface_kind !== 'cli')
  const rest = entries.filter((n) => (n.type === 'ROUTE' || n.type === 'ENDPOINT') && n.data?.interface_kind === 'rest')
  const graphql = entries.filter((n) => n.type === 'GRAPHQL_OPERATION')
  const jobs = entries.filter((n) => n.type === 'JOB' && n.data?.interface_kind !== 'event')
  const rpc = entries.filter((n) => n.data?.interface_kind === 'rpc')
  const ws = entries.filter((n) => n.data?.interface_kind === 'websocket')
  const cli = entries.filter((n) => n.data?.interface_kind === 'cli')
  const events = entries.filter((n) => n.data?.interface_kind === 'event')
  // The 8 channels the spec requires — Web / REST / GraphQL / RPC / WebSocket / CLI / Workers / Events. Each renders
  // its table when populated, else the honest empty-state token. RPC/WS/CLI/Events fall back to EXTRACTOR_UNSUPPORTED.
  add('Web Routes / Controllers', ['Route/Action', 'Controller', 'Method', 'Purpose', 'Auth/Authz Notes'], web,
    (n) => [n.name || n.id, controllerOf(n), methodOf(n), purposeOf(n, 'Web controller action'), authFor(n, auth)])
  add('REST API', ['Endpoint', 'API Class', 'Method', 'Purpose', 'Auth/Authz Notes'], rest,
    (n) => [n.data?.path || n.name || n.id, n.data?.api_class || n.data?.file || 'API', methodOf(n), purposeOf(n, 'REST API operation'), authFor(n, auth)])
  add('GraphQL', ['Query/Mutation/Resolver', 'File', 'Purpose', 'Auth/Authz Notes'], graphql,
    (n) => [n.name || n.id, sourceRef(n), purposeOf(n, 'GraphQL field, mutation, or resolver'), authFor(n, auth)])
  add('RPC', ['Method', 'Service/File', 'Purpose', 'Auth/Authz Notes'], rpc,
    (n) => [n.name || n.id, sourceRef(n), purposeOf(n, 'RPC method'), authFor(n, auth)], rpc.length ? 'COVERAGE_GAP' : 'EXTRACTOR_UNSUPPORTED')
  add('WebSocket', ['Channel/Event', 'File', 'Purpose', 'Auth/Authz Notes'], ws,
    (n) => [n.name || n.id, sourceRef(n), purposeOf(n, 'WebSocket channel'), authFor(n, auth)], ws.length ? 'COVERAGE_GAP' : 'EXTRACTOR_UNSUPPORTED')
  add('CLI', ['Command', 'File', 'Purpose', 'Auth/Authz Notes'], cli,
    (n) => [n.name || n.id, sourceRef(n), purposeOf(n, 'CLI command'), authFor(n, auth)], cli.length ? 'COVERAGE_GAP' : 'EXTRACTOR_UNSUPPORTED')
  add('Workers / Async', ['Worker', 'Enqueued From', 'Inputs', 'Purpose', 'Auth/Authz Notes'], jobs,
    (n) => [n.name || n.id, n.data?.enqueued_from || sourceRef(n), n.data?.inputs || 'Not mapped', purposeOf(n, 'Background job or enqueue'), authFor(n, auth)])
  add('Events', ['Event', 'Emitted From', 'Purpose', 'Auth/Authz Notes'], events,
    (n) => [n.name || n.id, sourceRef(n), purposeOf(n, 'Domain/event emission'), authFor(n, auth)], events.length ? 'COVERAGE_GAP' : 'EXTRACTOR_UNSUPPORTED')
  return blocks.join('\n')
}
function renderLedger(db, nb, f, claimMap) {
  const direct = new Set(nb.edges.filter((e) => e.from === f.id).map((e) => e.to))
  const eps = nb.nodes.filter((n) => direct.has(n.id) && ['ENDPOINT', 'ROUTE', 'GRAPHQL_OPERATION', 'JOB'].includes(n.type))
  if (!eps.length) return '_no entry points_'
  const auth = nb.nodes.filter((n) => direct.has(n.id) && n.type === 'AUTH_CHECK')
  const services = nb.nodes.filter((n) => direct.has(n.id) && n.type === 'SERVICE')
  const models = nb.nodes.filter((n) => direct.has(n.id) && n.type === 'MODEL')
  const roles = nb.nodes.filter((n) => n.type === 'ROLE')
  const shared = { auth: auth.map((n) => n.name).slice(0, 3).join(', '), services: services.map((n) => n.name).slice(0, 4).join(', '),
    models: models.map((n) => n.name).slice(0, 4).join(', '), roles: roles.map((n) => n.name).slice(0, 4).join(', ') }
  const head = ['Interface','Entry / action','Handler','Authentication','Authorization','Actors / roles','Models','Services','Response','Jobs','Source','Evidence','Status']
  const rows = eps.slice(0, 60).map((n) => {
    const handler = nb.edges.find((e) => e.from === n.id && e.type === 'HANDLED_BY')?.to || n.data?.file
    return `| ${[n.type, n.name || n.id, handler, shared.auth, shared.auth, shared.roles, shared.models, shared.services,
      n.type === 'JOB' ? 'async result' : 'application response', n.type === 'JOB' ? n.name : '—', `${n.data?.file || ''}:${n.data?.line || ''}`,
      claimMap.has(n.id) || n.data?.file ? 'source cited' : 'coverage gap', 'mapped'].map(cell).join(' | ')} |`
  })
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows,
    ...(eps.length > 60 ? [`\n_… ${eps.length - 60} more ledger rows in \`../ledgers/${f.data.slug}.jsonl\`._`] : [])].join('\n')
}
function renderCodePaths(db, nb, entries, services, models) {
  if (!entries.length) return '_no executable entry path mapped_'
  const serviceText = services.slice(0, 6).map((n) => n.name).join(' → '), modelText = models.slice(0, 6).map((n) => n.name).join(' / ')
  const rows = entries.slice(0, 50).map((entry) => {
    const fileId = nb.edges.find((e) => e.from === entry.id && e.type === 'HANDLED_BY')?.to
    const file = fileId ? getNode(db, fileId)?.data?.path || fileId.replace(/^file:/, '') : entry.data?.file
    return `- **${entry.name || entry.id}** → \`${file || 'handler coverage gap'}\`${serviceText ? ` → ${serviceText}` : ''}${modelText ? ` → data: ${modelText}` : ''}`
  })
  if (entries.length > 50) rows.push(`- _… ${entries.length - 50} more paths in the exhaustive feature ledger._`)
  return rows.join('\n')
}
function renderAuthorization(checks, permissions, roles, cite) {
  if (!checks.length && !permissions.length && !roles.length) return '_no grounded authorization context mapped_'
  const rows = checks.slice(0, 60).map((n) => `| ${cell(n.name)} | ${cell(n.data?.kind)} | ${cell(permissions.map((p) => p.name).slice(0, 6).join(', '))} | ${cell(roles.map((r) => r.name).slice(0, 6).join(', '))} | ${cite(n) || '—'} |`)
  if (!rows.length) rows.push(`| _implicit / shared_ | — | ${cell(permissions.map((p) => p.name).join(', '))} | ${cell(roles.map((r) => r.name).join(', '))} | — |`)
  return ['| Check | Kind | Permissions | Roles | Evidence |', '|---|---|---|---|---|', ...rows].join('\n')
}
function renderFeatureLedger(db, f) {
  const directNodes = db.prepare('SELECT n.* FROM nodes n JOIN edges e ON e.dst=n.id WHERE e.src=? ORDER BY n.type,n.id').all(f.id)
    .map((n) => ({ id: n.id, type: n.type, name: n.name, data: JSON.parse(n.data || '{}') }))
  const inventoryRows = db.prepare(`SELECT id,kind,file,line,entry,status FROM reconciliation
    WHERE feature_id=? ORDER BY kind,file,line,id`).all(f.id)
  const auth = directNodes.filter((n) => n.type === 'AUTH_CHECK').map((n) => n.name)
  const roleIds = db.prepare("SELECT DISTINCT e2.dst id FROM edges e1 JOIN edges e2 ON e2.src=e1.dst WHERE e1.src=? AND e2.type='REQUIRES_ROLE'").all(f.id).map((r) => r.id)
  const roles = roleIds.map((id) => getNode(db, id)?.name).filter(Boolean)
  const claimMap = directClaimsByNode(db, f.id)
  // Normalized JSONL: feature-wide context appears once, followed by one source-grounded node per line. Repeating a
  // large auth array on every node made large-feature ledgers quadratic in practice and unusable by downstream AI.
  const rows = [{ record_type: 'feature_summary', feature_id: f.id, feature: f.name, domain: f.data.domain,
    mapped_inventory_rows: inventoryRows.length, unique_graph_nodes: directNodes.length,
    auth_check_count: auth.length, auth_checks_sample: auth.slice(0, 100), roles }]
  rows.push(...inventoryRows.map((r) => ({ record_type: 'inventory_row', feature_id: f.id, inventory_id: r.id,
    kind: r.kind, file: r.file, line: r.line, entry: r.entry, status: r.status })))
  rows.push(...directNodes.map((n) => {
    const claims = claimMap.get(n.id) || []
    return { record_type: 'mapped_node', feature_id: f.id, node_id: n.id, type: n.type, name: n.name, data: n.data,
      evidence: claims.map((c) => ({ file: c.file, line_start: c.line_start,
        line_end: c.line_end, method: c.method, confidence: c.confidence })) }
  }))
  return jsonl(rows)
}
function directClaimsByNode(db, featureId) {
  const rows = db.prepare(`SELECT c.* FROM claims c JOIN edges e ON e.dst=c.node_id
    WHERE e.src=? ORDER BY c.node_id,c.id`).all(featureId)
  const map = new Map()
  for (const row of rows) {
    if (!map.has(row.node_id)) map.set(row.node_id, [])
    map.get(row.node_id).push(row)
  }
  return map
}
function renderReviewContext(entries, auth, models, flows) {
  const leads = []
  if (entries.length && !auth.length) leads.push('Confirm where shared authentication and authorization are applied to these entry points.')
  if (models.length) leads.push(`Trace ownership and lifecycle rules for: ${models.slice(0, 8).map((m) => m.name).join(', ')}.`)
  if (flows.length) leads.push('Confirm the fields crossing each recorded data-flow and trust boundary.')
  if (!leads.length) leads.push('No additional structural lead generated; inspect cited paths when deeper context is required.')
  return leads.map((x, i) => `${i + 1}. ${x}`).join('\n')
}

function renderInventoryManifest(inventories, db) {
  const terminal = new Map(db.prepare('SELECT kind,status,COUNT(*) n FROM reconciliation GROUP BY kind,status ORDER BY kind,status')
    .all().map((r) => [`${r.kind}:${r.status}`, r.n]))
  const rows = Object.entries(inventories || {}).map(([kind, items], i) => {
    const statuses = [...terminal.entries()].filter(([key]) => key.startsWith(`${kind}:`))
      .map(([key, n]) => `${key.slice(kind.length + 1)}=${n}`).join(', ') || 'not reconciled'
    return `| ${String(i + 1).padStart(2, '0')} | \`${kind}\` | ${(items || []).length} | ${cell(statuses)} |`
  })
  return `# Source Inventory Manifest

> Deterministic, stack-neutral source facts. These inventories do not define product features, roles, or permissions;
> Claude derives those semantics and every row is reconciled separately.

| # | Inventory | Rows | Terminal reconciliation |
|---|---|---:|---|
${rows.join('\n')}

## Reconciliation rule

Every row must terminate as \`MAPPED_TO_FEATURE\`, \`SHARED_INFRASTRUCTURE\`,
\`UNCLEAR_COVERAGE_GAP\`, \`DEAD_OR_UNREACHABLE\`, or \`EXTRACTOR_UNSUPPORTED\`. An absent row is never treated as
proof that a surface does not exist.
`
}

function renderSourceCoverage(db, inventories) {
  const grouped = db.prepare('SELECT kind,status,COUNT(*) n FROM reconciliation GROUP BY kind,status ORDER BY kind,status').all()
  const byKind = new Map()
  for (const row of grouped) {
    if (!byKind.has(row.kind)) byKind.set(row.kind, { total: 0, statuses: [] })
    const item = byKind.get(row.kind)
    item.total += row.n
    item.statuses.push(`${row.status}=${row.n}`)
  }
  for (const [kind, rows] of Object.entries(inventories || {})) if (!byKind.has(kind)) {
    byKind.set(kind, { total: (rows || []).length, statuses: ['not reconciled'] })
  }
  return `# Source Inventory Coverage Matrix

| Inventory | Extracted rows | Reconciliation |
|---|---:|---|
${[...byKind.entries()].map(([kind, item]) => `| \`${kind}\` | ${item.total} | ${cell(item.statuses.join(', '))} |`).join('\n')}

Rows mapped to technical architecture during a blocked scan remain coverage gaps; they are not semantic feature coverage.
`
}

function renderSameFunctionality(db, features, clusters) {
  const names = new Map(features.map((f) => [f.id, f.name]))
  const shares = db.prepare("SELECT src,dst,data FROM edges WHERE type='SHARES_IMPLEMENTATION_WITH' ORDER BY src,dst").all()
    .filter((e) => names.has(e.src) && names.has(e.dst))
  const sharedNodes = db.prepare(`SELECT n.type,n.name,n.data,COUNT(DISTINCT e.src) users
    FROM nodes n JOIN edges e ON e.dst=n.id
    WHERE n.type IN ('SERVICE','AUTH_CHECK','MODEL') GROUP BY n.id HAVING users > 1 ORDER BY users DESC,n.name`).all()
  return `# Same-Functionality & Shared-Implementation Map

## Feature siblings

${shares.length ? `| Feature A | Feature B | Evidence relationship |\n|---|---|---|\n${shares.map((e) => `| ${cell(names.get(e.src))} | ${cell(names.get(e.dst))} | shared implementation |`).join('\n')}` : '_No source-grounded sibling relationship was established._'}

## Shared infrastructure

${sharedNodes.length ? `| Kind | Component | Feature users |\n|---|---|---:|\n${sharedNodes.map((n) => `| ${n.type} | ${cell(n.name)} | ${n.users} |`).join('\n')}` : '_No component was linked to multiple mapped features._'}

## Technical clusters not accepted as features

${clusters.length ? clusters.map((c) => `- ${c.name} (${c.data?.row_count || 0} rows) — architecture/coverage gap`).join('\n') : '_none_'}
`
}

function renderPhase2Queue(db, features, blocked) {
  if (blocked) return `# Phase 2 Review Queue

> **BLOCKED:** semantic feature planning did not complete. Phase 2 must not start from technical directory clusters.
> Re-run reconnaissance with a working Claude session first.
`
  const rows = features.map((f) => {
    const counts = Object.fromEntries(db.prepare(`SELECT n.type,COUNT(*) n FROM nodes n JOIN edges e ON e.dst=n.id
      WHERE e.src=? GROUP BY n.type`).all(f.id).map((r) => [r.type, r.n]))
    const entryCount = (counts.ENDPOINT || 0) + (counts.ROUTE || 0) + (counts.GRAPHQL_OPERATION || 0) + (counts.JOB || 0)
    const authCount = counts.AUTH_CHECK || 0
    const priority = entryCount > 0 && authCount === 0 ? 'HIGH' : entryCount > 20 ? 'HIGH' : entryCount > 0 ? 'MEDIUM' : 'LOW'
    const lead = entryCount > 0 && authCount === 0
      ? 'Trace shared authentication, authorization, ownership, and object scoping for every entry.'
      : 'Continue from the feature ledger; verify each entry independently and do not inherit shared-control conclusions.'
    return { f, entryCount, authCount, priority, lead }
  }).sort((a, b) => ['HIGH', 'MEDIUM', 'LOW'].indexOf(a.priority) - ['HIGH', 'MEDIUM', 'LOW'].indexOf(b.priority) || b.entryCount - a.entryCount)
  return `# Phase 2 Review Queue

> Structural review leads only. These are not vulnerability findings.

| Priority | Feature | Entry rows | Auth checks | Lead |
|---|---|---:|---:|---|
${rows.map((r) => `| ${r.priority} | [${cell(r.f.name)}](../features/${r.f.data.slug}.md) | ${r.entryCount} | ${r.authCount} | ${cell(r.lead)} |`).join('\n')}
`
}

// roles/ — the identity subject axis. role-structure.md = actor catalog + role ladder (obtained-via, hierarchical,
// source). role-ability-matrix.md = ability (permission) × role grid with ✓ where a role enables that ability, from
// the ontology's AUTHORIZED_BY (role→permission) wiring. Every row/name is source-grounded (Lead ontology, validated).
function renderRoles(db, roles, actors) {
  const perms = nodesByType(db, 'PERMISSION')
  const cite = (n) => n.data?.source ? ` \`${n.data.source}\`` : ''
  const roleName = (r) => r.name
  // role → set(permission id) from the ontology wiring (role AUTHORIZED_BY permission)
  const enables = new Map(roles.map((r) => [r.id, new Set()]))
  for (const e of db.prepare(`SELECT src,dst FROM edges WHERE type='AUTHORIZED_BY' AND src LIKE 'role:%'`).all()) { if (enables.has(e.src)) enables.get(e.src).add(e.dst) }
  const structure = [
    `# Role & Actor Structure`, '',
    `> Source-grounded identity model derived by the Lead and validated against the frozen snapshot. Actor = who acts; role = privilege level; permission = ability. These are distinct axes.`, '',
    `## Actors (${actors.length})`, '',
    actors.length ? `| Actor | Obtained via | Hierarchical | Source |\n|---|---|---|---|\n${actors.map((a) => `| ${cell(a.name)} | ${cell(a.data?.obtained_via || '—')} | ${a.data?.hierarchical ? 'yes' : 'no'} |${cite(a)} |`).join('\n')}` : '_none established_', '',
    `## Role ladder (${roles.length})`, '',
    roles.length ? `| Role | Scope | Obtained via | Hierarchical | Abilities enabled | Source |\n|---|---|---|---|---:|---|\n${roles.map((r) => `| ${cell(roleName(r))} | ${cell(r.data?.scope || 'not mapped')} | ${cell(r.data?.obtained_via || 'not mapped')} | ${r.data?.hierarchical ? 'yes' : 'no'} | ${enables.get(r.id)?.size || 0} |${cite(r)} |`).join('\n')}` : '_COVERAGE GAP — no authoritative role definition was established._', '',
    `## Token / non-human actors`, '',
    actors.filter((a) => a.data?.kind && a.data.kind !== 'human').length
      ? `| Actor | Kind | Obtained via | Scopes | Source |\n|---|---|---|---|---|\n${actors.filter((a) => a.data?.kind && a.data.kind !== 'human').map((a) => `| ${cell(a.name)} | ${cell(a.data.kind)} | ${cell(a.data?.obtained_via || 'not mapped')} | ${cell((a.data?.scopes || []).join(', ') || 'not mapped')} |${cite(a)} |`).join('\n')}`
      : '_COVERAGE GAP — no token or non-human actor was established._', '',
  ].join('\n')
  const cols = roles.slice(0, 24)
  const matrix = [
    `# Role → Ability Matrix`, '',
    `- Roles: ${roles.length} · Abilities: ${perms.length}`, '',
    perms.length && cols.length
      ? `| Ability | ${cols.map((r) => cell(roleName(r))).join(' | ')} | Wiring |\n|---|${cols.map(() => '---').join('|')}|---|\n${perms.slice(0, 400).map((p) => `| ${cell(p.name)} | ${cols.map((r) => enables.get(r.id)?.has(p.id) ? '✓' : '○').join(' | ')} |${cite(p)} |`).join('\n')}`
      : '_no grounded role→ability wiring derived_', '',
  ].join('\n')
  const identity = [...actors, ...roles, ...perms]
  const sourceFiles = [...new Set(identity.map((n) => n.data?.source).filter(Boolean))].sort().join('\n') + (identity.length ? '\n' : '')
  const hints = identity.length
    ? identity.map((n) => `${n.type}\t${n.name}\t${n.data?.source || 'source gap'}`).join('\n') + '\n'
    : 'COVERAGE_GAP\tNo source-grounded actor, role, or permission ontology was established.\n'
  return { structure, matrix, sourceFiles, hints }
}

// Architecture view — the deterministic technical clusters (directory/namespace groupings). These are FACTS about
// code structure, explicitly NOT confirmed business features. Present under a blocked run; supplementary otherwise.
function renderArchitecture(db, clusters, coverage, gate, blocked) {
  const rowsFor = (c) => db.prepare(`SELECT COUNT(*) n FROM edges WHERE src=?`).get(c.id)?.n || c.data.row_count || 0
  const banner = blocked
    ? `> **SEMANTIC PLANNING BLOCKED.** No Claude Lead was available to derive repository meaning, so NO business\n> features were produced. Below are the deterministic **technical clusters** (directory/namespace groupings) —\n> code structure only, NOT confirmed capabilities. Connect Claude and re-scan to derive real features, actors,\n> roles and permissions.\n`
    : `> Supplementary technical clustering. The authoritative capabilities are the Lead-derived features; these\n> directory groupings are provided for structural navigation only.\n`
  const byDomain = new Map()
  for (const c of clusters) { const d = c.data.domain || 'core'; if (!byDomain.has(d)) byDomain.set(d, []); byDomain.get(d).push(c) }
  const sections = [...byDomain.entries()].sort().map(([d, cs]) =>
    `## ${d}\n\n| Technical cluster | Rows | Method |\n|---|---|---|\n${cs.sort((a, b) => (a.name > b.name ? 1 : -1)).map((c) => `| ${c.name} | ${rowsFor(c)} | ${c.data.planning_method || 'module-cohesion'} |`).join('\n')}`)
  return `# Architecture — Technical Clusters (NOT business features)\n\n${banner}\n- Technical clusters: ${clusters.length}\n- Technical coverage (source files represented): ${coverage?.technical_coverage ?? '?'}%\n- Semantic coverage (mapped to features): ${coverage?.semantic_coverage ?? 0}%\n\n${sections.join('\n\n')}\n`
}
function renderIndex(features, domains, blocked, clusters = [], db) {
  const endpointRows = db.prepare(`SELECT COUNT(*) n FROM nodes WHERE type IN ('ENDPOINT','ROUTE','GRAPHQL_OPERATION','JOB')`).get()?.n || 0
  const required = [
    ['Application architecture overview', '../README.md + per-feature Feature Identity/Purpose'],
    ['Feature coverage matrix', 'feature_coverage_matrix.md'],
    ['File-to-feature map', '../features/*.md — Files Reviewed'],
    ['Entry-point-to-feature map', '../features/*.md — Entry Points'],
    ['Authorization map', '../features/*.md — Authorization Map'],
    ['Authentication/actor map', '../features/*.md — Authentication / Actor Context Map'],
    ['API map', '../inventories/*rest_api* + feature REST tables'],
    ['GraphQL map', '../inventories/*graphql* + feature GraphQL tables'],
    ['Worker/background job map', '../inventories/*workers_jobs* + feature job tables'],
    ['Serializer/entity/presenter map', '../inventories/*response_shaping* + Data Exposure maps'],
    ['Search/export/download map', '../inventories/*search* and *downloads*'],
    ['Token flow map', '../inventories/*tokens_actors* + role structure'],
    ['Same-functionality cross-feature map', 'same_functionality_cross_feature_map.md'],
    ['Shared infrastructure map', 'same_functionality_cross_feature_map.md'],
    ['Unmapped files/directories', 'phase1_completion_gate.md + Architecture'],
    ['Phase 2 review queue', 'phase2_review_queue.md'],
    ['Source inventory coverage matrix', 'source_inventory_coverage_matrix.md'],
    [`Endpoint/action ledger (${endpointRows} graph rows)`, '../features/*.md + ../ledgers/*.jsonl'],
    ['Role / actor catalog + role ladder', '../roles/role-structure.md'],
    ['Role → ability matrix', '../roles/role-ability-matrix.md'],
    ['Token / non-human actor map', '../roles/role-structure.md — token actor table'],
  ]
  const featureList = blocked
    ? `> **No business features** — semantic planning was blocked. ${clusters.length} technical cluster(s) are listed
> in \`architecture.md\`; they are code structure, not capabilities.`
    : domains.map((d) => `## ${d.name}\n${features.filter((f) => f.data.domain === d.id.replace(/^domain:/, ''))
      .map((f) => `- [${f.name}](../features/${f.data.slug}.md)`).join('\n')}`).join('\n\n')
  return `# Phase 1 Artifact Index

## Required outputs (21/21 accounted)

| # | Required output | Artifact / status |
|---:|---|---|
${required.map(([name, where], i) => `| ${i + 1} | ${name} | ${cell(where)} |`).join('\n')}

## Feature queue (${features.length})

${featureList}

## Reading order for Phase 2

1. \`phase1_completion_gate.md\`
2. \`phase2_review_queue.md\`
3. \`same_functionality_cross_feature_map.md\`
4. \`../features/<slug>.md\` and \`../ledgers/<slug>.jsonl\`
`
}
const renderCoverage = (features, coverage, blocked) => `# Coverage Matrix\n\n- Semantic coverage (mapped to features): ${coverage?.semantic_coverage ?? 0}%\n- Technical coverage (source represented): ${coverage?.technical_coverage ?? '?'}%\n- Features: ${features.length}${blocked ? ' (semantic planning BLOCKED — see architecture.md)' : ''}\n- Mapped rows: ${coverage?.feature_rows ?? '?'}\n- Shared infrastructure rows: ${coverage?.infra_rows ?? '?'}\n\n| Feature | Rows |\n|---|---|\n${features.map((f) => `| ${f.name} | ${f.data.row_count || 0} |`).join('\n') || '_none — no business features derived_'}\n`
const renderGate = (gate, coverage, provenance) => `# Completion Gate\n\n- Status: **${gate?.status || 'UNKNOWN'}**\n- Executed planner: \`${provenance?.executed_planner || 'unknown'}\`${provenance?.lead_session_id ? ` · Lead session \`${provenance.lead_session_id}\`` : ''}\n- Semantic coverage: ${coverage?.semantic_coverage ?? 0}% · Technical coverage: ${coverage?.technical_coverage ?? '?'}%\n${provenance?.failure_reason ? `- Failure reason: ${provenance.failure_reason}\n` : ''}- Gaps: ${(gate?.gaps || []).length ? gate.gaps.join('; ') : 'none'}\n- Terminal reconciliation: ${JSON.stringify(coverage?.terminal || {})}\n`
const renderReadme = (project, snapshot, c, features, { blocked, coverage, clusters = [], provenance } = {}) => `# ${project?.name || 'Codengram'} White-Box Security Assessment — Phase 1 Artifacts

- Target: \`${project?.source_root || project?.id || 'unknown'}\`
- Snapshot: \`${snapshot?.id || ''}\`
- Recon skill: \`${provenance?.recon_skill?.id || 'phase1-feature-map'}\` · \`${provenance?.recon_skill?.sha256 || 'unavailable'}\`
- Graph: ${c.nodes} nodes · ${c.edges} edges · ${c.claims} provenance claims
- Features: ${features.length}${blocked ? ` · Technical clusters: ${clusters.length}` : ''}
- Semantic coverage: ${coverage?.semantic_coverage ?? 0}% · Technical coverage: ${coverage?.technical_coverage ?? '?'}%

This is **mapping, not vulnerability hunting**. No exploit work occurs in Phase 1.
${blocked ? `
> **SEMANTIC PLANNING BLOCKED** (${provenance?.failure_reason || 'Claude Lead unavailable'}).
> No business features were derived. Deterministic source facts remain in \`inventories/\` and technical structure in
> \`consolidated/architecture.md\`; neither is presented as product functionality or identity.
` : ''}
## Directory layout

- \`inventories/\` — deterministic source facts and reconciliation manifest
- \`roles/\` — Claude-derived, source-grounded actors, roles, permissions, and wiring
- \`features/\` — one 13-section feature map per grounded capability
- \`ledgers/\` — exhaustive machine-readable rows per feature
- \`consolidated/\` — coverage matrices, cross-feature links, Phase 2 queue, and completion gate
- \`graph/\` — portable nodes and edges

## Method

1. **Inventories:** read-only, stack-neutral extraction of routes, APIs, GraphQL, jobs, services, policies, response
   shaping, data movement, identity clues, processes, and integrations.
2. **Semantic feature mapping:** a Claude Lead follows the bundled recon-skill, delegates read-only reconnaissance,
   derives the repository-specific feature and identity ontology, and cites source evidence. Codengram validates every
   citation and reconciles every inventory row. Code never supplies product feature names or role vocabularies.
3. **Consolidation:** the sealed graph is projected into the fixed Phase 1 artifact contract and checked before publish.

## Depth-status meaning

| Depth | Meaning | Phase 2 can rely? |
|---|---|---|
| Discovered | Surface found, implementation not connected | No |
| Mapped | Assigned to a grounded feature | Partially |
| Traced | Entry connected through relevant implementation | Yes, with cited gaps |
| AuthZ Verified | Actor/role/permission wiring grounded per entry | Yes |
| Deep Complete | All feature surfaces independently traced and reconciled | Yes |

## Feature queue (${features.length})

${features.length ? features.map((f) => `- \`${f.data.slug}\` — ${f.name}`).join('\n') : '_No semantic features were published._'}

Start with \`consolidated/phase1_completion_gate.md\`, then \`consolidated/00_INDEX.md\`.
`
const renderAiContext = (project, snapshot, features, c, { blocked, coverage, clusters = [] } = {}) => `# AI_CONTEXT — ${project?.name || 'project'}\n\nYou are reading a **code reconnaissance brain** produced by Codengram (recon only; it never asserts vulnerabilities).\nEvery claim is grounded to a file:line in the frozen snapshot. Coverage gaps are labelled, not hidden.\n${blocked ? `\n**SEMANTIC PLANNING BLOCKED** — no Claude Lead derived meaning, so there are NO business features, actors, roles or permissions in this bundle. What IS here: deterministic inventories (\`inventories/\`), ${clusters.length} technical clusters (\`consolidated/architecture.md\`), and the raw graph. Do NOT treat a technical cluster as a business capability. Treat every absent semantic fact as "coverage gap — Claude was not available", never as "none exist".\n` : ''}\n- Snapshot: \`${snapshot?.id || ''}\` — ${c.nodes} nodes, ${c.edges} edges.\n- ${features.length} features across ${new Set(features.map((f) => f.data.domain)).size} domains.\n- Semantic coverage: ${coverage?.semantic_coverage ?? 0}% · Technical coverage: ${coverage?.technical_coverage ?? '?'}%.\n\nTo answer a question: start with \`consolidated/00_INDEX.md\`, read the relevant compact \`features/<slug>.md\`, then use \`ledgers/<slug>.jsonl\` for every mapped row and its source evidence. Follow relationships in \`graph/edges.jsonl\` (canonical direction from→to). The Markdown feature map is intentionally bounded for humans; the JSONL ledger is exhaustive. If a fact isn't present, say "coverage gap" — do not guess.\n`
