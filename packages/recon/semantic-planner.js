// Semantic feature planning turns low-level inventory rows into coherent business capabilities.
// The deterministic taxonomy is the safe fallback; an Agent-SDK Lead may provide a validated plan.

import { INVENTORY_KEYS } from '../plugins/index.js'
import { slug } from '../schemas/index.js'

const FEATURE_KINDS = new Set(['routes_endpoints', 'rest_api', 'graphql', 'workers_jobs', 'services_finders_policies',
  'response_shaping', 'tokens_actors', 'downloads_uploads_exports', 'search_aggregation'])


const titleize = (s) => String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
const singular = (s) => {
  const value = String(s || '')
  if (/(?:status|news|analysis|basis|series|species)$/i.test(value)) return value
  if (value.length > 4 && /ies$/i.test(value)) return value.slice(0, -3) + 'y'
  if (value.length > 4 && /(?:ches|shes|xes|zes)$/i.test(value)) return value.slice(0, -2)
  return value.length > 3 && /s$/i.test(value) && !/(?:ss|us|is)$/i.test(value) ? value.slice(0, -1) : value
}
const strip = /_(controller|service|finder|policy|worker|job|type|serializer|presenter|resolver|mutation|ability|spec|test)$/
const stripVerb = /^(create|update|delete|destroy|list|show|new|edit|fetch|get|build|generate|bulk)_/

// The module/domain a file belongs to — works across ecosystems (Rails app/<domain>, Nextcloud apps/<name>,
// monorepo packages/<pkg>, Go cmd/<x>, Django <app>/, src/<module>, …). Falls back to the top directory, then 'core'.
function moduleOf(file) {
  const generic = /^(controllers?|services?|models?|views?|helpers?|utils?|lib|libs|src|common|core|main|index|tests?|spec|dist|private|shared|internal|handlers?|routes?|api|app)$/i
  const m = file.match(/(?:^|\/)(?:apps|packages|services|modules|features|domains?|bundles|plugins)\/([^/]+)\//i)  // Nextcloud/monorepo/DDD modules
  if (m && m[1] && !generic.test(m[1])) return slug(m[1])
  const rails = file.match(/(?:app|lib)\/(?:controllers|services|finders|policies|workers|graphql)\/([^/]+)\/[^/]+$/)?.[1]  // Rails controller namespace
  if (rails && !generic.test(rails)) return slug(rails)
  return 'core'   // structural roots (app/, config/, src/, lib/…) cluster under one domain, grouped by capability noun
}
// For a LARGE, generic (non-taxonomy) repo, a feature = a module directory. Pick the first meaningful path segment
// (skipping framework-structural roots), so `apps/files/…`, `lib/private/Files/…` etc. all collapse to one "Files"
// feature — tens of real modules, not thousands of one-file features.
const GENERIC_SEG = /^(controllers?|services?|models?|views?|helpers?|utils?|util|lib|libs|src|source|common|core|main|index|tests?|spec|specs|dist|build|private|public|shared|internal|handlers?|routes?|route|api|app|apps|packages|package|bundle|bundles|vendor|includes?|inc|classes?|class|modules?|component|components|pkg|cmd|domain|domains|feature|features|3rdparty|node_modules)$/i
function moduleCluster(row) {
  const segs = String(row.file || '').split('/').filter(Boolean); segs.pop()   // drop the filename
  let mod = segs.find((s) => !GENERIC_SEG.test(s) && !s.includes('.'))
  if (!mod) mod = [...segs].reverse().find((s) => !GENERIC_SEG.test(s) && !s.includes('.')) || 'core'  // all-structural → 'core'
  mod = singular(slug(mod) || 'core')
  const file = String(row.file || '')
  const domain = /^(?:apps|plugins|extensions)\//i.test(file) ? 'applications'
    : /^(?:packages|modules|services|bundles)\//i.test(file) ? 'modules' : 'core'
  return { domain, slug: mod, name: titleize(mod) }
}
function fallbackKey(row) {
  const file = String(row.file || '')
  const entry = String(row.entry || '')
  const resource = entry.match(/resources?\s+:(\w+)/)?.[1]
  const routePath = entry.match(/(?:get|post|put|patch|delete|match)\s+['"]\/?([^/'"]+)/i)?.[1]
  let noun = resource || routePath || file.split('/').pop()?.replace(/\.[^.]+$/, '') || 'misc'
  noun = singular(slug(noun.replace(strip, '').replace(stripVerb, ''))) || 'misc'
  return { domain: moduleOf(file), slug: noun, name: titleize(noun) }
}

// No hardcoded product taxonomy: cross-cutting business-capability correlation is disabled unless a stack plugin or
// the AI Lead supplies grounded groupings. Features are derived purely from the code's own structure.
export function semanticFeatureForRow() { return null }

export function inventoryRows(inventories) {
  const rows = []
  for (const kind of INVENTORY_KEYS) if (FEATURE_KINDS.has(kind)) {
    for (const row of inventories[kind] || []) rows.push({ kind, row, key: `${kind}:${row.file}:${row.line}:${row.entry}` })
  }
  return rows
}

// ONE universal rule for every language — NO hardcoded taxonomy. Features are derived from the code's own structure:
// a large codebase clusters by MODULE directory (its real modules), a small one by capability NOUN. The same logic
// runs for Ruby, PHP, Java, JS/TS, Python, Go, … Precision beyond structure comes from the AI Lead (validateLeadPlan),
// which reads the actual code, or from a stack-specific plugin — never a curated product list.
export function deterministicSemanticPlan(inventories, { moduleThreshold = 80 } = {}) {
  const rows = inventoryRows(inventories)
  const bigRepo = rows.length >= moduleThreshold
  const features = new Map()
  for (const wrapped of rows) {
    const selected = bigRepo ? moduleCluster(wrapped.row) : fallbackKey(wrapped.row)
    // small repo → merge by capability NOUN (across dirs); large repo → by MODULE directory.
    const key = bigRepo ? `${selected.domain}/${selected.slug}` : selected.slug
    if (!features.has(key)) features.set(key, { slug: selected.slug, domain: selected.domain, name: selected.name, rows: [],
      confidence: 'low', planning_method: bigRepo ? 'module-cohesion' : 'local-cohesion' })
    else if (!bigRepo && features.get(key).domain === 'core' && selected.domain !== 'core') features.get(key).domain = selected.domain
    features.get(key).rows.push({ kind: wrapped.kind, row: wrapped.row })
  }
  return [...features.values()].sort((a, b) => a.domain.localeCompare(b.domain) || a.slug.localeCompare(b.slug))
}

export function validateLeadPlan(plan, inventories) {
  if (!plan || !Array.isArray(plan.features) || !plan.features.length) return null
  const sourceRows = inventoryRows(inventories)
  const claimed = new Set(), definitions = []
  for (const raw of plan.features) {
    const featureSlug = slug(raw.slug || raw.name), domain = slug(raw.domain || 'core')
    if (!featureSlug) continue
    definitions.push({ slug: featureSlug, domain, name: String(raw.name || titleize(featureSlug)).slice(0, 100),
      purpose: '', rows: [],
      explicit: new Set(Array.isArray(raw.inventory_keys) ? raw.inventory_keys : []),
      paths: (raw.include_paths || []).map((p) => String(p).toLowerCase()).filter(Boolean),
      terms: (raw.include_terms || []).map((p) => String(p).toLowerCase()).filter((p) => p.length > 2),
      confidence: 'medium', planning_method: 'agent-lead' })
  }
  for (const item of sourceRows) {
    const file = String(item.row.file || '').toLowerCase(), text = `${file} ${item.row.entry || ''} ${item.row.detail || ''}`.toLowerCase()
    let winner = null
    for (const def of definitions) {
      let score = def.explicit.has(item.key) ? 10_000 : 0
      for (const p of def.paths) if (file.includes(p)) score += 100 + p.length
      for (const term of def.terms) if (text.includes(term)) score += 10 + term.length
      if (score > 0 && (!winner || score > winner.score || (score === winner.score && def.slug < winner.def.slug))) winner = { def, score }
    }
    if (winner) { winner.def.rows.push({ kind: item.kind, row: item.row }); claimed.add(item.key) }
  }
  const leadFeatures = definitions.filter((d) => d.rows.length).map(({ explicit, paths, terms, ...d }) => d)
  if (!leadFeatures.length) return null
  // Coalesce duplicate Lead definitions (same domain/slug) so one capability is never rendered twice.
  const merged = new Map()
  for (const feature of leadFeatures) {
    const key = `${feature.domain}/${feature.slug}`
    if (!merged.has(key)) { merged.set(key, { ...feature, rows: [...feature.rows] }); continue }
    const current = merged.get(key)
    const seen = new Set(current.rows.map(({ kind, row }) => `${kind}:${row.file}:${row.line}:${row.entry}`))
    for (const wrapped of feature.rows) { const sig = `${wrapped.kind}:${wrapped.row.file}:${wrapped.row.line}:${wrapped.row.entry}`; if (!seen.has(sig)) { seen.add(sig); current.rows.push(wrapped) } }
  }
  // STRICT RULE: rows the Lead did NOT confirm are NEVER features. They are preserved as technical ARCHITECTURE
  // (directory clusters) and disclosed as a coverage gap — never silently dropped, never dressed up as a capability.
  const missing = sourceRows.filter((r) => !claimed.has(r.key))
  let archClusters = []
  if (missing.length) {
    const fallbackInventories = Object.fromEntries(INVENTORY_KEYS.map((k) => [k, []]))
    for (const m of missing) fallbackInventories[m.kind].push(m.row)
    archClusters = deterministicSemanticPlan(fallbackInventories).map((f) => ({ ...f, planning_method: 'lead-gap-fallback' }))
  }
  return { features: [...merged.values()], archClusters }
}

export const semanticTaxonomy = () => []   // no hardcoded taxonomy — features come from the code's structure
