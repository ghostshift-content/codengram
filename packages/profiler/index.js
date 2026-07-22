// @codengram/profiler — DETERMINISTIC repository facts (no LLM). The Lead session plans over these; it never
// invents scale. Adapted from ARCHON's hardened profiler (context budgeting, config-file recognition, real file
// manifest) + language/framework/entry-point detection. Read-only; never runs the project.
import fs from 'node:fs'
import path from 'node:path'

export const CODE_EXT = new Set(['.rb', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.java', '.php',
  '.cs', '.c', '.cc', '.cpp', '.h', '.hpp', '.rs', '.kt', '.swift', '.scala', '.ex', '.exs', '.erl', '.clj',
  '.groovy', '.pl', '.pm', '.sh', '.bash', '.sql', '.graphql', '.gql', '.vue', '.svelte', '.html', '.erb', '.haml',
  '.yml', '.yaml', '.json', '.tf', '.conf', '.cnf', '.properties', '.ini', '.toml', '.cfg', '.env', '.xml', '.gradle'])
export const CODE_FILES = new Set(['gemfile', 'gemfile.lock', 'dockerfile', 'makefile', 'rakefile', 'procfile',
  'requirements.txt', 'pom.xml', 'build.gradle', 'go.mod', 'go.sum', 'cargo.toml', 'cargo.lock', 'composer.json',
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'nginx.conf', 'docker-compose.yml', 'docker-compose.yaml'])
const CODE_PATTERNS = [/^\.env(\.|$)/i, /^dockerfile(\.|$)/i, /^requirements[\w.-]*\.txt$/i, /^docker-compose[\w.-]*\.ya?ml$/i, /\.conf(\.[\w-]+)?$/i]
const SKIP_DIR = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'coverage', '.next', 'tmp', 'log', 'logs', '__pycache__', '.venv', 'venv', 'target'])

export function isSourceFile(name) {
  const l = String(name || '').toLowerCase()
  if (CODE_FILES.has(l)) return true
  const ext = path.extname(l)
  if (ext && CODE_EXT.has(ext)) return true
  return CODE_PATTERNS.some((re) => re.test(l))
}
export const estimateTokens = (bytes) => Math.ceil((Number(bytes) || 0) / 4)

// §1: model-capability table matching Anthropic's DOCUMENTED context windows. Current Claude models default to a
// 200K-token window; a 1M-token window is a BETA opt-in for Claude Sonnet 4 (the `context-1m` beta) — so we grant
// 1M ONLY on an explicit opt-in, never from a broad name match. Update this table as Anthropic publishes changes.
export const MODEL_CONTEXT = Object.freeze({
  'claude-opus-4': 200_000, 'claude-sonnet-4': 200_000, 'claude-haiku-4': 200_000,
  'claude-3-7-sonnet': 200_000, 'claude-3-5-sonnet': 200_000, 'claude-3-5-haiku': 200_000,
  'claude-3-opus': 200_000, 'claude-3-sonnet': 200_000, 'claude-3-haiku': 200_000,
})
export function modelContext(model, { context1m = false } = {}) {
  const m = String(model || '').toLowerCase()
  if (context1m || /\[1m\]|context-1m|-1m\b/.test(m)) return 1_000_000   // Sonnet-4 1M beta — explicit opt-in only
  for (const k of Object.keys(MODEL_CONTEXT)) if (m.includes(k)) return MODEL_CONTEXT[k]
  return 200_000                                                          // documented default for current Claude models
}
// §1: reserves sized to fit a 200K model. usable = model − (prompt + reasoning + output + safety + shared).
// We REJECT impossible configs (reserves ≥ model) — never manufacture positive capacity with Math.max().
export const DEFAULT_RESERVES = Object.freeze({ prompt: 16_000, reasoning: 32_000, output: 16_000, safety: 8_000 })
export function usableContext(model_context, reserves = {}) {
  const mc = Number(model_context) || 0
  const r = { ...DEFAULT_RESERVES, ...reserves }
  const used = (r.prompt || 0) + (r.reasoning || 0) + (r.output || 0) + (r.safety || 0) + (r.shared_context || 0)
  if (!(mc > 0)) throw new Error('model_context must be a positive number')
  if (used >= mc) throw new Error(`impossible context budget: reserves ${used} ≥ model_context ${mc}`)
  return mc - used
}

// The real file manifest: [{ path (repo-relative), bytes, ext }].
export function listSourceFiles(root, base = root, out = []) {
  let entries; try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(root, e.name)
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) listSourceFiles(full, base, out); continue }
    if (!isSourceFile(e.name)) continue
    try { out.push({ path: path.relative(base, full), bytes: fs.statSync(full).size, ext: path.extname(e.name).toLowerCase() }) } catch {}
  }
  return out
}

// Manifest/config files → detected frameworks (best-effort, deterministic).
const MANIFESTS = [
  { file: 'Gemfile', lang: 'Ruby', fw: [[/rails/i, 'Rails'], [/sinatra/i, 'Sinatra'], [/hanami/i, 'Hanami']] },
  { file: 'package.json', lang: 'JavaScript/TypeScript', fw: [[/"express"/, 'Express'], [/"@nestjs/, 'NestJS'], [/"next"/, 'Next.js'], [/"react"/, 'React'], [/"fastify"/, 'Fastify'], [/"koa"/, 'Koa']] },
  { file: 'requirements.txt', lang: 'Python', fw: [[/django/i, 'Django'], [/flask/i, 'Flask'], [/fastapi/i, 'FastAPI']] },
  { file: 'pyproject.toml', lang: 'Python', fw: [[/django/i, 'Django'], [/flask/i, 'Flask'], [/fastapi/i, 'FastAPI']] },
  { file: 'go.mod', lang: 'Go', fw: [[/gin-gonic/i, 'Gin'], [/labstack\/echo/i, 'Echo'], [/gofiber/i, 'Fiber']] },
  { file: 'pom.xml', lang: 'Java', fw: [[/spring-boot/i, 'Spring Boot'], [/spring-web/i, 'Spring']] },
  { file: 'build.gradle', lang: 'Java/Kotlin', fw: [[/spring/i, 'Spring'], [/ktor/i, 'Ktor']] },
  { file: 'composer.json', lang: 'PHP', fw: [[/laravel/i, 'Laravel'], [/symfony/i, 'Symfony']] },
  { file: 'Cargo.toml', lang: 'Rust', fw: [[/axum/i, 'Axum'], [/actix/i, 'Actix'], [/rocket/i, 'Rocket']] },
  { file: 'mix.exs', lang: 'Elixir', fw: [[/phoenix/i, 'Phoenix']] },
]
function detectStack(root) {
  const langs = new Set(), frameworks = new Set(), manifests = []
  for (const m of MANIFESTS) {
    const p = path.join(root, m.file)
    let txt; try { txt = fs.readFileSync(p, 'utf8') } catch { continue }
    manifests.push(m.file); langs.add(m.lang)
    for (const [re, name] of m.fw) if (re.test(txt)) frameworks.add(name)
  }
  return { languages: [...langs], frameworks: [...frameworks], manifests }
}
// Common process entry points (deterministic path patterns).
const ENTRY_PATTERNS = [/^config\/application\.rb$/i, /^config\/routes\.rb$/i, /(^|\/)main\.(go|py|rs|ts|js)$/i,
  /(^|\/)app\.(py|js|ts|rb)$/i, /(^|\/)server\.(js|ts)$/i, /(^|\/)index\.(js|ts)$/i, /manage\.py$/i,
  /(^|\/)wsgi\.py$/i, /(^|\/)asgi\.py$/i, /(^|\/)cmd\//i, /Procfile$/i, /docker-compose\.ya?ml$/i, /Dockerfile$/i]

// Profile a repository from an already-computed file manifest (or compute one).
export function profileRepo(root, opts = {}) {
  const files = opts.files || listSourceFiles(root)
  const bytes = files.reduce((s, f) => s + f.bytes, 0)
  const est_tokens = estimateTokens(bytes)
  const byLang = {}; for (const f of files) { const k = f.ext || '(none)'; byLang[k] = (byLang[k] || 0) + f.bytes }
  const languages_by_bytes = Object.entries(byLang).sort((a, b) => b[1] - a[1]).map(([ext, b]) => ({ ext, bytes: b, files: files.filter(f => f.ext === ext).length }))
  const topDirs = {}; for (const f of files) { const top = String(f.path).split(/[\\/]/)[0] || '.'; topDirs[top] = (topDirs[top] || 0) + 1 }
  const top_directories = Object.entries(topDirs).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([dir, n]) => ({ dir, files: n }))
  const entry_points = files.map(f => f.path).filter(p => ENTRY_PATTERNS.some(re => re.test(p))).slice(0, 60)
  const stack = detectStack(root)
  // Structural inference: infer language/framework from LAYOUT when manifests are absent (e.g. a Rails app with no
  // Gemfile at root). Deterministic, additive — never overrides a manifest-detected stack.
  const byExt = new Set(languages_by_bytes.map((l) => l.ext))
  const inferLang = (ext, name) => { if (byExt.has(ext) && !stack.languages.includes(name)) stack.languages.push(name) }
  inferLang('.rb', 'Ruby'); inferLang('.py', 'Python'); inferLang('.go', 'Go'); inferLang('.php', 'PHP')
  const railsLayout = entry_points.some((e) => /(^|\/)config\/routes\.rb$/.test(e)) || top_directories.some((d) => d.dir === 'app')
  if (byExt.has('.rb') && railsLayout && !stack.frameworks.includes('Rails')) stack.frameworks.push('Rails')
  // §1: default to a 200K model (never assume 1M). The 1M window is opt-in via opts.context1m or a [1m] model id.
  const model = opts.model || 'claude-sonnet-4'
  const model_context = modelContext(model, { context1m: opts.context1m })
  const usable = usableContext(model_context, opts.reserves)
  return {
    root, files: files.length, bytes, est_tokens,
    languages: stack.languages, frameworks: stack.frameworks, manifests: stack.manifests,
    languages_by_bytes, top_directories, entry_points,
    model, model_context, usable_context: usable,
    fits_in_one_session: est_tokens <= usable, min_sessions: Math.max(1, Math.ceil(est_tokens / usable)),
  }
}

// self-check
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = await import('node:assert')
  assert.ok(isSourceFile('Gemfile') && isSourceFile('app.rb') && isSourceFile('.env.production') && !isSourceFile('logo.png'))
  assert.strictEqual(estimateTokens(4000), 1000)
  assert.ok(usableContext(200_000) <= 200_000 && usableContext(1_000_000) > 400_000)
  console.log('ok — profiler: source recognition, context budget, stack detection')
}
