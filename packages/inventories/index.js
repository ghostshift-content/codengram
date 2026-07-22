// @codengram/inventories — M2: deterministic inventory extraction (NO LLM), per BLUEPRINT §14.1.
//
// Runs every matching plugin's inventory() over the frozen source and merges the 11 raw `file:line` lists — the
// source of truth the Lead plans over and reconciliation later resolves against. Ships the first plugin (Rails);
// more stacks are just more plugins (§9). Output is raw lists; SQLite (M3) loads them, the renderer (M4) publishes.
import fs from 'node:fs'
import path from 'node:path'
import { INVENTORY_KEYS, Registry, definePlugin } from '../plugins/index.js'

// ── extraction context over a frozen source tree ───────────────────────────────────────────────
const SKIP_DIR = new Set(['node_modules', '.git', 'vendor', '3rdparty', 'dist', 'build', 'coverage', 'tmp', 'log', 'logs', 'target', 'cypress', '__tests__', '__mocks__'])
function listFiles(root, base = root, out = []) {
  let entries; try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(root, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) listFiles(full, base, out); continue }
    out.push({ path: path.relative(base, full).split(path.sep).join('/'), abs: full, name: e.name, ext: path.extname(e.name).toLowerCase() })
  }
  return out
}
export function buildContext(sourceRoot) {
  const files = listFiles(sourceRoot)
  const cache = new Map()
  const read = (rel) => {
    if (cache.has(rel)) return cache.get(rel)
    let t = ''; try { t = fs.readFileSync(path.join(sourceRoot, rel), 'utf8') } catch {}
    cache.set(rel, t); return t
  }
  // grep(re) → [{file,line,text}]; optional {pathRe}/{nameRe} scope the scan (perf + precision).
  const grep = (re, { pathRe = null, nameRe = null } = {}) => {
    const hits = []
    for (const f of files) {
      if (pathRe && !pathRe.test(f.path)) continue
      if (nameRe && !nameRe.test(f.name)) continue
      const lines = read(f.path).split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) { const m = re.exec(lines[i]); re.lastIndex = 0; if (m) hits.push({ file: f.path, line: i + 1, text: lines[i].trim(), m }) }
    }
    return hits
  }
  return { root: sourceRoot, files, read, grep }
}

const item = (h, entry, detail = '') => ({ file: h.file, line: h.line, entry, detail })

const rubyApiClass = (text) => text.match(/^\s*class\s+([\w:]+)\s*<\s*(?:::)?(?:API::Base|Grape::API)\b/)?.[1] || ''
const rubyScope = (text) => text.match(/^\s*(?:namespace|resource|resources|segment|prefix)\s+(?::|['"])([\w/:.-]+)/)?.[1] || ''
const rubyVerb = (text) => text.match(/^\s*(get|post|put|patch|delete)\b(?:\s+(?:['"]([^'"]*)['"]|(?!do\b)([a-zA-Z_]\w*)))?/i)
const rubyBlockStart = (text) => /\bdo\b\s*(?:\|[^|]*\|)?\s*$/.test(text) ||
  /^\s*(?:class|module|def|if|unless|case|begin|while|until|for)\b/.test(text)
const rubyBlockDelta = (text) => (text.match(/\bdo\b/g) || []).length +
  (/^\s*(?:class|module|def|if|unless|case|begin|while|until|for)\b/.test(text) ? 1 : 0) -
  (text.match(/\bend\b/g) || []).length
function rubyEndpointBody(lines, start) {
  let depth = rubyBlockDelta(lines[start])
  if (depth <= 0) return ''
  const body = []
  for (let i = start + 1; i < lines.length; i++) {
    depth += rubyBlockDelta(lines[i])
    if (depth <= 0) break
    body.push(lines[i])
  }
  return body.join('\n')
}

// GitLab's REST API is Grape-based but inherits from ::API::Base, and many endpoints are pathless verbs inside
// nested resource blocks (`resource :issues do; get do`). A line-only grep misses almost all of that surface.
function railsRestApi(ctx) {
  const rows = []
  for (const file of ctx.files.filter((f) => f.ext === '.rb')) {
    const lines = ctx.read(file.path).split(/\r?\n/)
    if (!lines.some((line) => rubyApiClass(line)) && !/(^|\/)(?:ee\/)?lib\/api\//.test(file.path)) continue
    const blocks = []
    let apiClass = '', pendingPurpose = '', pendingAuth = ''
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i], text = raw.trim()
      if (/^end\b/.test(text)) { blocks.pop(); continue }
      apiClass = rubyApiClass(raw) || apiClass
      const desc = text.match(/^desc\s+['"]([^'"]+)/)?.[1]
      if (desc) pendingPurpose = desc
      if (/^(?:route_setting\s+:authorization|authenticate!|authenticated_as_admin!|authorize!)/.test(text)) pendingAuth = text

      const scope = rubyScope(raw)
      const verb = rubyVerb(raw)
      if (verb) {
        const method = verb[1].toUpperCase()
        const prefix = blocks.map((b) => b.scope).filter(Boolean)
        const variable = verb[3]
        const bound = variable ? [...blocks].reverse().find((b) => b.bindings?.[variable])?.bindings[variable] : null
        // Never collapse an unresolved dynamic route (`get path`) to its parent resource; that invents a different
        // endpoint. Literal array loops are expanded; expressions we cannot resolve remain explicit coverage gaps.
        const ownPaths = verb[2] != null ? [verb[2]] : bound || (variable ? [] : [''])
        const body = rubyEndpointBody(lines, i)
        const authHits = [...body.matchAll(/\b(authenticate!|authenticated_as_admin!|authorize!\s*[^\n;]*|can\?\s*[^\n;]*|allowed\?\s*[^\n;]*)/g)]
          .slice(0, 3).map((m) => m[0].trim())
        for (const ownPath of ownPaths) {
          const own = String(ownPath || '').replace(/^\//, '')
          const endpoint = `/${[...prefix, own].filter(Boolean).join('/')}`.replace(/\/{2,}/g, '/')
          rows.push({ file: file.path, line: i + 1, entry: `${method} '${endpoint || '/'}'`, detail: 'grape',
            method, path: endpoint || '/', api_class: apiClass ? `API::${apiClass.replace(/^API::/, '')}` : 'API',
            purpose: pendingPurpose || 'REST API operation', auth_notes: [...new Set([pendingAuth, ...authHits].filter(Boolean))].join('; ') })
        }
        pendingPurpose = ''; pendingAuth = ''
      }

      if (rubyBlockStart(raw)) {
        const each = raw.match(/\[([^\]]+)\]\.each\s+do\s+\|(\w+)\|/)
        const values = each ? [...each[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]) : []
        blocks.push({ scope: scope || '', bindings: each && values.length ? { [each[2]]: values } : null })
      }
    }
  }
  return rows
}

// Rails controller APIs often use `namespace :api` rather than Grape. Preserve the same route row in the general
// inventory and add a REST row only when the route is grounded inside an API namespace or has an explicit /api path.
function railsRouteInventories(ctx) {
  const routes = [], rest = []
  for (const file of ctx.files.filter((f) => /(^|\/)config\/routes(?:\.\w+)?\.rb$/.test(f.path))) {
    const lines = ctx.read(file.path).split(/\r?\n/), blocks = []
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i], text = raw.trim(), hit = { file: file.path, line: i + 1 }
      if (/^end\b/.test(text)) { blocks.pop(); continue }
      const scope = text.match(/^namespace\s+(?::|['"])([\w-]+)/)?.[1] || rubyScope(raw)
      const prefix = blocks.map((b) => b.scope).filter(Boolean)
      const apiScoped = prefix.includes('api') || prefix.includes('api/v1') || prefix.includes('api/v2')
      const resGroup = text.match(/\bresources?\s+((?::\w+\s*,?\s*)+)/)
      if (resGroup) for (const symbol of resGroup[1].match(/:\w+/g) || []) {
        routes.push(item(hit, `resources ${symbol}`, 'route'))
        if (apiScoped) {
          const resource = symbol.slice(1), routePath = `/${[...prefix, resource].join('/')}`.replace(/\/{2,}/g, '/')
          rest.push({ file: file.path, line: i + 1, entry: `resources ${symbol}`, detail: 'rails-api-route',
            method: 'RESOURCE', path: routePath, api_class: 'Rails API routes', purpose: 'REST API resource', auth_notes: '' })
        }
      }
      const verb = text.match(/\b(get|post|put|patch|delete|match)\s+['"]([^'"]+)['"]/i)
      if (verb) {
        const method = verb[1].toUpperCase(), literal = verb[2], routePath = literal.startsWith('/') ? literal : `/${[...prefix, literal].filter(Boolean).join('/')}`
        routes.push(item(hit, `${verb[1]} '${literal}'`, 'route'))
        if (apiScoped || /^\/api(?:\/|$)/.test(routePath)) rest.push({ file: file.path, line: i + 1,
          entry: `${method} '${routePath}'`, detail: 'rails-api-route', method, path: routePath,
          api_class: 'Rails API routes', purpose: 'REST API operation', auth_notes: '' })
      }
      if (rubyBlockStart(raw)) blocks.push({ scope: scope || '' })
    }
  }
  return { routes, rest }
}

// ── the Rails plugin (regex-based; the reference stack from the GitLab maps) ─────────────────────
export const railsPlugin = definePlugin({
  id: 'rails', langs: ['Ruby'],
  // Detect Rails from the Gemfile OR from STRUCTURE — a repo can be Rails-shaped without a Gemfile at its root
  // (subtrees, extracted apps, fixtures). Ruby files + a Rails layout (config/routes.rb or an app/ dir) is enough.
  detect: (profile) => {
    if ((profile?.frameworks || []).includes('Rails') || (profile?.manifests || []).includes('Gemfile')) return true
    const hasRuby = (profile?.languages_by_bytes || []).some((l) => l.ext === '.rb')
    const railsLayout = (profile?.entry_points || []).some((e) => /(^|\/)config\/routes\.rb$/.test(e)) ||
      (profile?.top_directories || []).some((d) => d.dir === 'app')
    return hasRuby && railsLayout
  },
  inventory(ctx) {
    const g = ctx.grep.bind(ctx)
    const out = Object.fromEntries(INVENTORY_KEYS.map((k) => [k, []]))

    // 01 routes/endpoints ← config/routes.rb. Expand `resources :a, :b, :c` into one row PER resource (a single
    // regex-per-line otherwise drops every resource after the first), and capture verb routes with a path.
    const routeInventories = railsRouteInventories(ctx)
    out.routes_endpoints = routeInventories.routes
    // Controller actions are entry points too. Route declarations alone cannot describe mounted engines,
    // inherited routes, or action-level behavior in a large Rails monolith.
    out.routes_endpoints.push(...g(/^\s*def\s+([a-zA-Z_][\w!?=]*)/, { pathRe: /(^|\/)app\/controllers\//, nameRe: /_controller\.rb$/ })
      .map((h) => item(h, `${/_params$|^(set|find|load|ensure|validate|authorize)_/.test(h.m[1]) ? 'helper' : 'action'} ${h.m[1]}`,
        /_params$|^(set|find|load|ensure|validate|authorize)_/.test(h.m[1]) ? 'controller-helper' : 'controller-action')))
    // 02 REST API ← Grape / GitLab API::Base endpoints, including pathless verbs in resource blocks.
    out.rest_api = [...routeInventories.rest, ...railsRestApi(ctx)]
    // 03 GraphQL ← type/resolver/mutation field decls
    out.graphql = g(/^\s*field\s+:\w+/, { pathRe: /(^|\/)app\/graphql\//, nameRe: /\.rb$/ }).map((h) => item(h, h.text.trim(), 'graphql-field'))
      .concat(g(/class\s+\w+\s*<\s*(Types::|Resolvers::|Mutations::)/, { nameRe: /\.rb$/ }).map((h) => item(h, h.text.trim(), 'graphql-type')))
    // 04 workers/jobs + enqueues
    out.workers_jobs = g(/include\s+Sidekiq::(Worker|Job)|<\s*ApplicationJob\b/, { nameRe: /\.rb$/ }).map((h) => item(h, h.text.trim(), 'worker'))
      .concat(g(/\.(perform_async|perform_later|perform_in|set\()/, { nameRe: /\.rb$/ }).map((h) => item(h, h.text.trim(), 'enqueue')))
    // 05 services/finders/policies
    out.services_finders_policies = ctx.files
      .filter((f) => /(^|\/)app\/(services|finders|policies)\//.test(f.path) && f.ext === '.rb')
      .map((f) => ({ file: f.path, line: 1, entry: f.path.split('/').pop(), detail: f.path.includes('/policies/') ? 'policy' : f.path.includes('/finders/') ? 'finder' : 'service' }))
      .concat(ctx.files.filter((f) => /(^|\/)app\/models\//.test(f.path) && f.ext === '.rb')
        .map((f) => ({ file: f.path, line: 1, entry: f.path.split('/').pop(), detail: 'model' })))
    // 06 response shaping ← serializers/entities + render json
    out.response_shaping = ctx.files.filter((f) => /(^|\/)app\/(serializers|presenters)\//.test(f.path) && f.ext === '.rb')
      .map((f) => ({ file: f.path, line: 1, entry: f.path.split('/').pop(), detail: 'serializer' }))
      .concat(g(/render\s+(json|html|xml|plain|text|template|partial):/, { nameRe: /\.rb$/ }).map((h) => item(h, h.text.trim(), 'render')))
    // 07 downloads/uploads/exports
    out.downloads_uploads_exports = g(/\b(send_file|send_data|ActiveStorage|CarrierWave|has_one_attached|has_many_attached|to_csv|export)\b/, { nameRe: /\.rb$/ }).map((h) => item(h, h.text.trim(), 'file-io'))
    // 08 search/aggregation
    out.search_aggregation = g(/\.(search|aggregate)\(|Elasticsearch|::Search\b/, { nameRe: /\.rb$/ }).map((h) => item(h, h.text.trim(), 'search'))
    // 09 tokens/actors/auth
    out.tokens_actors = g(/\b(TokenAuthenticatable|authenticate_user!|current_user|before_action\s+:authenticate|devise|PersonalAccessToken|can\?|allowed\?|authorize!?|permission|access_level|admin\?|owner\?|maintainer\?|developer\?|reporter\?|guest\?|reset_session|has_secure_password)\b|session\s*\[|\.authenticate\s*\(|params\s*\[\s*:token\s*\]/, { nameRe: /\.rb$/ })
      .map((h) => item(h, h.text.trim(), /can\?|allowed\?|authorize|permission|access_level/.test(h.text) ? 'permission' : /token/i.test(h.text) ? 'token' : 'auth'))
    // 10 processes/IPC
    out.processes_ipc = ctx.files.filter((f) => /(^Procfile|(^|\/)config\/(puma|sidekiq|clockwork|schedule)\.\w+)$/.test(f.path))
      .map((f) => ({ file: f.path, line: 1, entry: f.name, detail: 'process' }))
    // 11 datastores/integrations
    out.datastores_integrations = ctx.files.filter((f) => /(^|\/)config\/(database|redis|cable|storage)\.yml$/.test(f.path))
      .map((f) => ({ file: f.path, line: 1, entry: f.name, detail: 'datastore' }))
      .concat(g(/\b(Faraday|HTTParty|Net::HTTP|RestClient|Octokit|Aws::|Redis\.new)\b/, { nameRe: /\.rb$/ }).map((h) => item(h, h.text.trim(), 'integration')))
    return out
  },
})

export function builtinRegistry() { return new Registry().register(railsPlugin) }

// ── universal polyglot extractor (fallback for ANY language) ────────────────────────────────────
// Language-specific plugins (Rails) give the most precise map. When none matches the stack, this fallback still
// produces a real, cited map for ANY language using (a) fast path/name role heuristics — which framework a file plays
// (controller, service, model, job, auth) is encoded in its path/name across almost every ecosystem — and (b) a few
// broad cross-framework CONTENT patterns for route/auth definitions. Not as sharp as a hand-tuned plugin, but it means
// PHP / Java / JS / TS / Python / Go / Rust / … all map instead of returning zero features.
const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|php|py|rb|go|java|kt|kts|rs|ex|exs|erl|cs|scala|sc|swift|vue|svelte|astro|c|cc|cpp|cxx|h|hpp|hh|clj|cljs|pl|pm|groovy|dart|cfm|cfc|cfml|vb|fs|fsx|razor|cshtml|aspx|jsp|jspx|gsp|hs|ml|mli|elm|re|res|rkt|scm|lua|r|jl|nim|cr|zig|v|d|m|mm|pas|f90|tcl|ps1|coffee|sol|move|cairo|gleam|vala|hx)$/i
const ROUTE_DEF = /\b(?:(?:app|router|route|api|bp|blueprint|srv|mux|group|http|r|Router|Route)\s*\.\s*(?:get|post|put|patch|delete|options|head|use|all|route|handle|handlefunc|match|any|resource|apiresource|add_route|add_url_rule)\s*\()|@(?:Get|Post|Put|Patch|Delete|Request|Api|Web)Mapping\b|@(?:app|router|blueprint|bp)\.(?:get|post|put|patch|delete|route)\b|Route::(?:get|post|put|patch|delete|any|match|resource|apiResource|group)\s*\(|#\[(?:Route|ApiRoute|FrontpageRoute|Get|Post|Put|Delete|Patch)\b|@(?:Path|GET|POST|PUT|DELETE|PATCH)\b|\b(?:path|re_path|url)\s*\(\s*[rf]?['"]|http\.HandleFunc\s*\(/i
const AUTH_DEF = /@(?:PreAuthorize|PostAuthorize|Secured|RolesAllowed|Authorize|Authenticated|PermitAll|DenyAll)\b|IsGranted|isGranted\s*\(|hasR(?:ole|oles|equest)|hasAnyRole|hasAuthority\s*\(|requireLogin|ensureLoggedIn|authenticate[_(]|current_user\b|getUser\(|@login_required|checkPermission|authorize[!(]|before_action[^,\n]*auth|passport\.|jwt\.verify|verifyToken|Auth::(?:check|user|guard)|#\[[A-Za-z]*(?:Admin|Auth|Role|Public|Require|Secur|Anonym|Grant|Permission|Guard|Login|Restrict|Permit|Deny)[A-Za-z]*\]/i
const DOWNLOAD_DEF = /\b(?:(?:function|def|func)\s+\w*(?:upload|download|export|attachment)\w*|(?:public|private|protected|async|static)\s+(?:\w+\s+)?\w*(?:upload|download|export|attachment)\w*\s*\(|sendFile\s*\(|send_file\b|send_data\b|FileResponse\s*\(|Content-Disposition\b|move_uploaded_file\s*\(|presigned\w*\s*\()/i
const SEARCH_DEF = /\b(?:(?:function|def|func)\s+\w*(?:search|query|aggregate|facet)\w*|(?:public|private|protected|async|static)\s+(?:\w+\s+)?\w*(?:search|query|aggregate|facet)\w*\s*\(|Elasticsearch\w*\s*\(|OpenSearch\w*\s*\(|Solr\w*\s*\(|Meilisearch\w*\s*\(|Algolia\w*\s*\()/i
const GRAPHQL_DEF = /\b(?:type\s+(?:Query|Mutation|Subscription)\b|extend\s+type\b|@Resolver\b|@Query\b|@Mutation\b|GraphQLObjectType|buildSchema\b|gql`)/i
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'])
export const INVENTORY_EXTRACTOR_VERSION = 'universal-v2'
const INVENTORY_META = Symbol.for('codengram.inventory.meta')
export const inventoryMeta = (inventories) => inventories?.[INVENTORY_META] || {
  extractor_version: INVENTORY_EXTRACTOR_VERSION, matched_plugins: [], universal_used: false,
  source_code_files: 0, represented_source_files: 0, unrepresented_source_files: 0,
}
// role of a file from its path/name — works across ecosystems (Rails, Laravel, Symfony, Nest, Spring, Django, …)
const ROLE = [
  ['services_finders_policies', /(?:^|\/)(?:policies|policy|guards?|abilities)(?:\/|$)|(?:Policy|Guard|Ability|Voter)\.\w+$/i, 'policy'],
  ['services_finders_policies', /(?:^|\/)(?:services?|usecases?|use_cases?|interactors?|managers?|providers?|repositor(?:y|ies)|finders?|handlers?)(?:\/|$)|(?:Service|UseCase|Interactor|Manager|Provider|Repository|Finder|Handler)\.\w+$/i, 'service'],
  ['services_finders_policies', /(?:^|\/)(?:models?|entit(?:y|ies)|domain\/models?|schemas?)(?:\/|$)|(?:Model|Entity)\.\w+$/i, 'model'],
  ['workers_jobs', /(?:^|\/)(?:jobs?|workers?|tasks?|queues?|consumers?|cron|schedulers?|commands?)(?:\/|$)|(?:Job|Worker|Task|Consumer|Cron|Scheduler|Command)\.\w+$/i, 'worker'],
  ['response_shaping', /(?:^|\/)(?:serializers?|transformers?|presenters?|resources?|views?|dtos?)(?:\/|$)|(?:Serializer|Transformer|Presenter|Resource|View|Dto|Response)\.\w+$/i, 'serializer'],
  ['routes_endpoints', /(?:^|\/)(?:controllers?|handlers?|routes?|endpoints?|api|resources?|views?)(?:\/|$)|(?:Controller|Handler|Endpoint|Resource|Api)\.\w+$/i, 'handler'],
  ['tokens_actors', /(?:^|\/)(?:auth|authentication|security|middlewares?|guards?|permissions?|identity)(?:\/|$)/i, 'auth'],
  ['datastores_integrations', /(?:^|\/)(?:migrations?|db|database|integrations?|clients?|gateways?|adapters?)(?:\/|$)|schema\.prisma$|knexfile|\.sql$|database\.(?:yml|php|json)$/i, 'integration'],
  ['processes_ipc', /(?:^Procfile$|(?:^|\/)Dockerfile$|docker-compose|(?:^|\/)Makefile$|(?:^|\/)cmd\/[^/]+\/main\.|(?:^|\/)bin\/)/i, 'process'],
]

const lineFor = (text, offset) => text.slice(0, Math.max(0, offset)).split(/\r?\n/).length
const routeFields = (text) => {
  const method = text.match(/\b(get|post|put|patch|delete|options|head)\b/i)?.[1]?.toUpperCase() ||
    text.match(/['"]verb['"]\s*=>\s*['"]([A-Z]+)['"]/i)?.[1]?.toUpperCase() || 'ANY'
  const route = text.match(/['"](?:url|path)['"]\s*=>\s*['"]([^'"]+)['"]/i)?.[1] ||
    text.match(/(?:get|post|put|patch|delete|options|head|route|handlefunc)\s*\(\s*[rf]?['"]([^'"]+)/i)?.[1] ||
    text.match(/#\[(?:Api)?Route[^\]]*url\s*:\s*['"]([^'"]+)/i)?.[1] ||
    text.match(/@(?:Get|Post|Put|Patch|Delete|Request|Api|Web)Mapping\s*\(?(?:value\s*=\s*)?['"]([^'"]+)/i)?.[1] || ''
  return { method, path: route }
}

function openApiInventory(ctx) {
  const rows = []
  const specFiles = ctx.files.filter((f) => /(?:^|\/)(?:openapi|swagger)(?:[-_.][^/]*)?\.(?:json|ya?ml)$/i.test(f.path))
  for (const file of specFiles) {
    const text = ctx.read(file.path)
    if (/\.json$/i.test(file.path)) {
      let doc; try { doc = JSON.parse(text) } catch { continue }
      for (const [route, operations] of Object.entries(doc?.paths || {})) {
        for (const [verb, operation] of Object.entries(operations || {})) {
          if (!HTTP_METHODS.has(String(verb).toLowerCase())) continue
          const needle = JSON.stringify(route), offset = text.indexOf(needle)
          const security = operation?.security ?? doc?.security
          rows.push({ file: file.path, line: offset >= 0 ? lineFor(text, offset) : 1,
            entry: `${String(verb).toUpperCase()} '${route}'`, detail: 'openapi', method: String(verb).toUpperCase(), path: route,
            api_class: operation?.tags?.join(', ') || doc?.info?.title || 'OpenAPI', handler: operation?.operationId || '',
            purpose: operation?.summary || operation?.description || 'OpenAPI operation',
            auth_notes: security?.length ? `OpenAPI security: ${security.flatMap((s) => Object.keys(s || {})).join(', ') || 'declared'}` : 'OpenAPI security not declared' })
        }
      }
      continue
    }
    const lines = text.split(/\r?\n/); let currentPath = ''
    for (let i = 0; i < lines.length; i++) {
      const pathHit = lines[i].match(/^\s{0,6}(\/[^:]+):\s*$/)
      if (pathHit) { currentPath = pathHit[1]; continue }
      const verb = lines[i].match(/^\s+(get|post|put|patch|delete|options|head):\s*$/i)
      if (currentPath && verb) rows.push({ file: file.path, line: i + 1, entry: `${verb[1].toUpperCase()} '${currentPath}'`,
        detail: 'openapi', method: verb[1].toUpperCase(), path: currentPath, api_class: 'OpenAPI', purpose: 'OpenAPI operation' })
    }
  }
  return rows
}

// Nextcloud and several PHP frameworks declare routes as arrays rather than executable route calls. Parse each
// bounded array item without evaluating PHP; preserve OCS/API classification and source lines.
function phpArrayRoutes(ctx) {
  const rows = []
  for (const file of ctx.files.filter((f) => /(?:^|\/)appinfo\/routes\.php$/i.test(f.path))) {
    const lines = ctx.read(file.path).split(/\r?\n/); let section = 'routes'
    const appId = file.path.match(/(?:^|\/)apps\/([^/]+)\/appinfo\/routes\.php$/i)?.[1] || ''
    for (let i = 0; i < lines.length; i++) {
      if (/['"]ocs['"]\s*=>\s*\[/.test(lines[i])) section = 'ocs'
      else if (/['"]routes['"]\s*=>\s*\[/.test(lines[i])) section = 'routes'
      if (!/['"](?:name|url)['"]\s*=>/.test(lines[i])) continue
      const start = i, block = []
      for (let j = i; j < Math.min(lines.length, i + 14); j++) {
        block.push(lines[j])
        if (/\],?\s*$/.test(lines[j]) && block.some((x) => /['"]url['"]\s*=>/.test(x))) { i = j; break }
      }
      const body = block.join(' '), relativeRoute = body.match(/['"]url['"]\s*=>\s*['"]([^'"]+)/)?.[1]
      if (!relativeRoute) continue
      const route = appId ? `${section === 'ocs' ? '/ocs/v2.php/apps' : '/index.php/apps'}/${appId}/${relativeRoute.replace(/^\//, '')}` : relativeRoute
      const methods = body.match(/['"]verb['"]\s*=>\s*\[([^\]]+)/)?.[1]?.match(/['"]([A-Z]+)['"]/g)?.map((v) => v.replace(/['"]/g, '')) ||
        [body.match(/['"]verb['"]\s*=>\s*['"]([A-Z]+)['"]/i)?.[1] || 'ANY']
      const handler = body.match(/['"]name['"]\s*=>\s*['"]([^'"]+)/)?.[1] || ''
      for (const method of methods) rows.push({ file: file.path, line: start + 1, entry: `${method} '${route}'`,
        detail: section === 'ocs' || /\/api\//i.test(route) ? 'php-rest-route' : 'php-web-route', method, path: route,
        api_class: section === 'ocs' ? 'OCS API' : 'PHP routes', handler, purpose: handler || 'PHP route', auth_notes: '' })
    }
  }
  return rows
}

export function universalInventory(ctx) {
  const out = Object.fromEntries(INVENTORY_KEYS.map((k) => [k, []]))
  // (a) machine-readable API contracts and framework route declarations.
  out.rest_api.push(...openApiInventory(ctx))
  for (const row of phpArrayRoutes(ctx)) (row.detail === 'php-rest-route' ? out.rest_api : out.routes_endpoints).push(row)
  // (b) content: explicit route/auth/data-boundary definitions (scoped to code files for speed).
  for (const h of ctx.grep(ROUTE_DEF, { nameRe: CODE_EXT })) {
    const parsed = routeFields(h.text), rest = /(?:^|\/)(?:api|rest|graphql)(?:\/|$)/i.test(h.file) || /^\/api(?:\/|$)/i.test(parsed.path) || /ApiRoute|RequestMapping/i.test(h.text)
    ;(rest ? out.rest_api : out.routes_endpoints).push({ ...item(h, parsed.path ? `${parsed.method} '${parsed.path}'` : h.text.slice(0, 90), rest ? 'generic-rest-route' : 'route'), ...parsed,
      api_class: rest ? 'Source API route' : '', purpose: rest ? 'REST API operation' : 'Web route' })
  }
  for (const h of ctx.grep(AUTH_DEF, { nameRe: CODE_EXT })) out.tokens_actors.push(item(h, h.text.slice(0, 90), 'auth'))
  for (const h of ctx.grep(DOWNLOAD_DEF, { nameRe: CODE_EXT })) out.downloads_uploads_exports.push(item(h, h.text.slice(0, 90), 'file-io'))
  for (const h of ctx.grep(SEARCH_DEF, { nameRe: CODE_EXT })) out.search_aggregation.push(item(h, h.text.slice(0, 90), 'search'))
  for (const h of ctx.grep(GRAPHQL_DEF, { nameRe: /\.(?:graphql|gql|js|jsx|ts|tsx|py|rb|php|java|kt|go)$/i })) out.graphql.push(item(h, h.text.slice(0, 90), 'graphql-operation'))
  // (c) file-role heuristics (fast, language-agnostic) — one representative row per meaningful file.
  const represented = new Set(INVENTORY_KEYS.flatMap((k) => out[k].map((r) => r.file)))
  for (const f of ctx.files) {
    if (!CODE_EXT.test(f.name) && !ROLE[8][1].test(f.path)) continue    // code file, or a process/infra file
    for (const [kind, re, detail] of ROLE) {
      if (re.test(f.path) || re.test(f.name)) { out[kind].push({ file: f.path, line: 1, entry: f.name, detail }); represented.add(f.path); break }
    }
  }
  // (d) total source coverage. Unknown naming conventions must not make a repository disappear. Represent each
  // otherwise-unclassified code file as a cited source-module symbol; downstream planning consolidates these rows by
  // coherent directory/module, and the completion gate keeps the resulting semantics explicitly low-confidence.
  for (const f of ctx.files) if (CODE_EXT.test(f.name) && !represented.has(f.path)) {
    out.services_finders_policies.push({ file: f.path, line: 1, entry: f.name, detail: 'source-module' })
  }
  return out
}

// ── engine ───────────────────────────────────────────────────────────────────────────────────
// Merge every matching plugin's 11 lists; dedup identical file:line:entry rows. If the language-specific plugins
// produced NO feature-bearing rows (an unsupported stack), fall back to the universal polyglot extractor so any
// language still maps instead of returning zero features.
const FEATURE_KINDS = ['routes_endpoints', 'rest_api', 'graphql', 'workers_jobs', 'services_finders_policies', 'response_shaping', 'tokens_actors', 'downloads_uploads_exports', 'search_aggregation']
export function extractInventories({ sourceRoot, profile, registry = builtinRegistry() }) {
  const ctx = buildContext(sourceRoot)
  const merged = Object.fromEntries(INVENTORY_KEYS.map((k) => [k, []]))
  const seen = Object.fromEntries(INVENTORY_KEYS.map((k) => [k, new Set()]))
  const absorb = (inv, pluginId) => {
    for (const key of INVENTORY_KEYS) for (const it of inv[key] || []) {
      const sig = `${it.file}:${it.line}:${it.entry}`
      if (seen[key].has(sig)) continue
      seen[key].add(sig); merged[key].push({ ...it, plugin: pluginId })
    }
  }
  const matched = registry.match(profile)
  for (const plugin of matched) absorb(plugin.inventory(ctx) || {}, plugin.id)
  const universal = universalInventory(ctx)
  const specializedFiles = new Set(INVENTORY_KEYS.flatMap((k) => merged[k].map((r) => r.file)))
  const extByLang = { Ruby: /\.rb$/i, Python: /\.py$/i, Go: /\.go$/i, PHP: /\.php$/i,
    'JavaScript/TypeScript': /\.(?:js|jsx|ts|tsx|mjs|cjs)$/i, Java: /\.(?:java|kt|kts)$/i }
  const coveredExt = matched.map((p) => p.langs.map((l) => extByLang[l]).filter(Boolean)).flat()
  const needsUniversal = (row) => matched.length === 0 || row.detail === 'openapi' ||
    !specializedFiles.has(row.file) && !coveredExt.some((re) => re.test(row.file))
  for (const key of INVENTORY_KEYS) absorb({ [key]: (universal[key] || []).filter(needsUniversal) }, 'universal')
  for (const key of INVENTORY_KEYS) merged[key].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  const sourceFiles = ctx.files.filter((f) => CODE_EXT.test(f.name))
  const represented = new Set(INVENTORY_KEYS.flatMap((k) => merged[k].map((r) => r.file)))
  Object.defineProperty(merged, INVENTORY_META, { enumerable: false, value: Object.freeze({
    extractor_version: INVENTORY_EXTRACTOR_VERSION, matched_plugins: matched.map((p) => p.id),
    universal_used: INVENTORY_KEYS.some((k) => merged[k].some((r) => r.plugin === 'universal')),
    source_code_files: sourceFiles.length, represented_source_files: sourceFiles.filter((f) => represented.has(f.path)).length,
    unrepresented_source_files: sourceFiles.filter((f) => !represented.has(f.path)).length,
  }) })
  return merged
}

// Write raw inventories (source-of-truth) as `<outDir>/inventories/NN_key.txt` + a counts manifest. Returns counts.
export function writeInventories(outDir, inv) {
  const dir = path.join(outDir, 'inventories')
  fs.mkdirSync(dir, { recursive: true })
  const counts = {}
  INVENTORY_KEYS.forEach((key, i) => {
    const nn = String(i + 1).padStart(2, '0')
    const rows = inv[key] || []
    counts[key] = rows.length
    const body = rows.map((r) => `${r.file}:${r.line} · ${r.entry}${r.detail ? ` · ${r.detail}` : ''}`).join('\n')
    fs.writeFileSync(path.join(dir, `${nn}_${key}.txt`), body + (rows.length ? '\n' : ''))
  })
  const manifest = ['# Inventory manifest', '', ...INVENTORY_KEYS.map((k, i) => `- ${String(i + 1).padStart(2, '0')}_${k}: ${counts[k]}`)].join('\n') + '\n'
  fs.writeFileSync(path.join(dir, '00_MANIFEST.md'), manifest)
  return counts
}
