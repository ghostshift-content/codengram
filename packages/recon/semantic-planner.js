// Semantic feature planning turns low-level inventory rows into coherent business capabilities.
// The deterministic taxonomy is the safe fallback; an Agent-SDK Lead may provide a validated plan.

import { INVENTORY_KEYS } from '../plugins/index.js'
import { slug } from '../schemas/index.js'

const FEATURE_KINDS = new Set(['routes_endpoints', 'rest_api', 'graphql', 'workers_jobs', 'services_finders_policies',
  'response_shaping', 'tokens_actors', 'downloads_uploads_exports', 'search_aggregation'])

const RULES = [
  ['identity', 'authentication-sso', 'Authentication & SSO', /authentic|oauth|saml|ldap|openid|session|sign.?in|two.factor|2fa|password|identity/i],
  ['identity', 'members-access', 'Members & Access', /member|membership|access.level|access_level|role.assignment|role_assignment/i],
  ['identity', 'users-profile', 'Users & Profiles', /user|profile|account|avatar/i],
  ['planning', 'issues-work-items', 'Issues & Work Items', /issue|work.item|work_item|todo/i],
  ['planning', 'epics-portfolio', 'Epics & Portfolio', /epic|portfolio|roadmap/i],
  ['planning', 'boards-milestones-labels', 'Boards, Milestones & Labels', /board|milestone|label/i],
  ['collaboration', 'merge-requests', 'Merge Requests', /merge.request|merge_request|reviewer|approval/i],
  ['collaboration', 'notes-discussions', 'Notes & Discussions', /note|discussion|comment/i],
  ['collaboration', 'design-management', 'Design Management', /design.management|design_management/i],
  ['source-code', 'repositories-git', 'Repositories & Git', /repository|repositories|commit|branch|tag|git\b/i],
  ['source-code', 'protected-branch-rules', 'Protected Branch Rules', /protected.branch|branch.rule/i],
  ['source-code', 'snippets', 'Snippets', /snippet/i],
  ['source-code', 'wikis', 'Wikis', /wiki/i],
  ['delivery', 'ci-cd-pipelines', 'CI/CD Pipelines', /pipeline|ci\/|ci_|continuous.integration/i],
  ['delivery', 'runners', 'Runners', /runner/i],
  ['delivery', 'releases-environments', 'Releases & Environments', /release|environment|deployment/i],
  ['delivery', 'feature-flags', 'Feature Flags', /feature.flag/i],
  ['delivery', 'pages', 'Pages', /pages/i],
  ['operations', 'clusters-infra', 'Clusters & Infrastructure', /cluster|kubernetes|infrastructure/i],
  ['operations', 'monitor-incidents', 'Monitoring & Incidents', /monitor|incident|alert|oncall/i],
  ['operations', 'analytics-observability', 'Analytics & Observability', /analytics|metric|observability|tracking/i],
  ['security', 'vulnerabilities', 'Vulnerabilities', /vulnerabilit|security.finding|security_finding/i],
  ['security', 'security-policies', 'Security Policies', /security.policy|security_policy|scan.execution|approval.policy/i],
  ['security', 'compliance-audit', 'Compliance & Audit', /compliance|audit.event|audit_event/i],
  ['security', 'dependency-sbom', 'Dependencies & SBOM', /dependenc|sbom|license.scan/i],
  ['security', 'anti-abuse', 'Anti-Abuse', /abuse|spam|rate.limit|throttl/i],
  ['packages', 'packages', 'Packages', /package(?!.*registry)|npm|maven|nuget|composer/i],
  ['packages', 'container-registry', 'Container Registry', /container.registry|container_registry|registry/i],
  ['integrations', 'integrations-webhooks', 'Integrations & Webhooks', /integration|webhook|callback/i],
  ['integrations', 'import-export', 'Import & Export', /import|export|migration/i],
  ['integrations', 'uploads-files', 'Uploads & Files', /upload|attachment|file.storage|object.storage/i],
  ['organization', 'projects', 'Projects', /project/i],
  ['organization', 'groups-namespaces', 'Groups & Namespaces', /group|namespace/i],
  ['organization', 'admin-settings', 'Administration & Settings', /admin|application.setting|settings/i],
  ['commerce', 'subscriptions-billing', 'Subscriptions & Billing', /subscription|billing|invoice|payment|purchase/i],
  ['commerce', 'crm-contacts', 'CRM & Contacts', /crm|contact|customer.relation/i],
  ['support', 'service-desk', 'Service Desk', /service.desk|service_desk/i],
  ['search', 'search', 'Search', /search|elasticsearch|zoekt/i],
  ['ai', 'ai-duo', 'AI & Assistants', /duo|ai.gateway|ai_gateway|llm|model.gateway/i],
  ['ai', 'ml', 'Machine Learning', /machine.learning|machine_learning|ml.model|model.registry/i],
  ['development', 'workspaces-remote-dev', 'Workspaces & Remote Development', /workspace|remote.development/i],
  ['platform', 'geo', 'Geo', /(^|\W)geo(\W|$)|replicat/i],
  ['platform', 'cells', 'Cells', /(^|\W)cell(s)?(\W|$)|organization.cluster/i],
]

const titleize = (s) => String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
const singular = (s) => s.length > 3 && s.endsWith('s') && !s.endsWith('ss') ? s.slice(0, -1) : s
const strip = /_(controller|service|finder|policy|worker|job|type|serializer|presenter|resolver|mutation|ability|spec|test)$/
const stripVerb = /^(create|update|delete|destroy|list|show|new|edit|fetch|get|build|generate|bulk)_/

function fallbackKey(row) {
  const file = String(row.file || '')
  const entry = String(row.entry || '')
  const resource = entry.match(/resources?\s+:(\w+)/)?.[1]
  const routePath = entry.match(/(?:get|post|put|patch|delete|match)\s+['"]\/?([^/'"]+)/i)?.[1]
  let noun = resource || routePath || file.split('/').pop()?.replace(/\.[^.]+$/, '') || 'misc'
  noun = singular(slug(noun.replace(strip, '').replace(stripVerb, ''))) || 'misc'
  const root = file.match(/(?:app|lib)\/(?:controllers|services|finders|policies|workers|graphql)\/([^/]+)\/[^/]+$/)?.[1]
  const domain = root ? slug(root) : 'core'
  return { domain, slug: noun, name: titleize(noun) }
}

function matchRule(row) {
  const haystack = `${row.file || ''} ${row.entry || ''} ${row.detail || ''}`.replace(/[-_/]/g, ' ')
  let best = null
  for (const [domain, featureSlug, name, re] of RULES) {
    const hits = haystack.match(re)
    if (!hits) continue
    const score = hits[0].length + (String(row.file).includes(featureSlug.replace(/-/g, '_')) ? 20 : 0)
    if (!best || score > best.score) best = { domain, slug: featureSlug, name, score }
  }
  return best
}

// Public, deterministic business-capability classification for cross-cutting interface rows. A REST endpoint can
// belong to the technical REST surface while also exposing Issues, Projects, Authentication, and so on.
export function semanticFeatureForRow(row) {
  const matched = matchRule(row)
  return matched ? { domain: matched.domain, slug: matched.slug, name: matched.name } : null
}

export function inventoryRows(inventories) {
  const rows = []
  for (const kind of INVENTORY_KEYS) if (FEATURE_KINDS.has(kind)) {
    for (const row of inventories[kind] || []) rows.push({ kind, row, key: `${kind}:${row.file}:${row.line}:${row.entry}` })
  }
  return rows
}

export function deterministicSemanticPlan(inventories, { taxonomyThreshold = 80 } = {}) {
  const rows = inventoryRows(inventories)
  const useTaxonomy = rows.length >= taxonomyThreshold
  const features = new Map()
  for (const wrapped of rows) {
    const matched = useTaxonomy ? matchRule(wrapped.row) : null
    const selected = matched || (useTaxonomy
      ? { domain: 'platform', slug: 'supporting-capabilities', name: 'Supporting Application Capabilities', score: 0 }
      : fallbackKey(wrapped.row))
    const key = useTaxonomy ? `${selected.domain}/${selected.slug}` : selected.slug
    if (!features.has(key)) features.set(key, { slug: selected.slug, domain: selected.domain, name: selected.name, rows: [],
      confidence: matched ? 'medium' : 'low', planning_method: useTaxonomy ? (matched ? 'semantic-taxonomy' : 'coverage-catchall') : 'local-cohesion' })
    else if (!useTaxonomy && features.get(key).domain === 'core' && selected.domain !== 'core') features.get(key).domain = selected.domain
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
  const out = definitions.filter((d) => d.rows.length).map(({ explicit, paths, terms, ...d }) => d)
  // Never drop inventory. Deterministically place anything the Lead missed, then expose that fact in coverage.
  const missing = sourceRows.filter((r) => !claimed.has(r.key))
  if (missing.length) {
    const fallbackInventories = Object.fromEntries(INVENTORY_KEYS.map((k) => [k, []]))
    for (const m of missing) fallbackInventories[m.kind].push(m.row)
    out.push(...deterministicSemanticPlan(fallbackInventories).map((f) => ({ ...f, planning_method: 'lead-gap-fallback' })))
  }
  // A fallback may resolve to the same business capability as a Lead definition. Coalesce those definitions so
  // one feature cannot be rendered twice or have its richer Lead metadata overwritten by fallback bookkeeping.
  const merged = new Map()
  for (const feature of out) {
    const key = `${feature.domain}/${feature.slug}`
    if (!merged.has(key)) { merged.set(key, { ...feature, rows: [...feature.rows] }); continue }
    const current = merged.get(key)
    const seen = new Set(current.rows.map(({ kind, row }) => `${kind}:${row.file}:${row.line}:${row.entry}`))
    for (const wrapped of feature.rows) {
      const sig = `${wrapped.kind}:${wrapped.row.file}:${wrapped.row.line}:${wrapped.row.entry}`
      if (!seen.has(sig)) { seen.add(sig); current.rows.push(wrapped) }
    }
    if (current.planning_method !== 'agent-lead' && feature.planning_method === 'agent-lead') {
      current.name = feature.name; current.purpose = feature.purpose; current.confidence = feature.confidence
      current.planning_method = feature.planning_method
    }
  }
  return merged.size ? [...merged.values()] : null
}

export const semanticTaxonomy = () => RULES.map(([domain, featureSlug, name]) => ({ domain, slug: featureSlug, name }))
