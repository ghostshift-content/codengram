// @codengram/claude-runtime — the Claude Agent SDK adapter (BLUEPRINT §2a, §5, §6).
//
// AUTH IS NOT OUR JOB. Codengram runs through the user's existing official Claude Code subscription via the Agent
// SDK. We never implement OAuth, never read/copy/export/log/store credentials, never inspect the Keychain or
// ~/.claude/.credentials.json, never ask for an API key. The SDK resolves the local Claude Code login itself.
//
// This module is OPTIONAL: if the SDK isn't installed (or no local session is reachable), isAvailable() is false and
// every caller falls back to the deterministic path — the app is fully functional offline.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let _sdk           // cached dynamic import result: module | null
let _probed = false
let _claudePath
const SDK_TIMEOUT_MS = Math.max(5_000, Number(process.env.CODENGRAM_AI_TIMEOUT_MS) || 120_000)
const PLAN_TIMEOUT_MS = Math.max(60_000, Number(process.env.CODENGRAM_PLAN_TIMEOUT_MS) || 1_800_000)
const MODEL = process.env.CODENGRAM_MODEL || 'claude-agent-sdk'   // recorded in provenance; SDK owns the concrete model
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_RECON_SKILL = path.resolve(MODULE_DIR, '../../skills/phase1-feature-map')

function loadReconSkill() {
  const root = path.resolve(process.env.CODENGRAM_RECON_SKILL_PATH || DEFAULT_RECON_SKILL)
  const required = [
    'SKILL.md',
    'references/methodology.md',
    'references/output-structure.md',
    'references/inventory-manifest.md',
    'references/role-model.md',
    'references/feature-map-template.md',
    'references/consolidated-templates.md',
    'references/enumeration-by-language.md',
  ]
  const missing = required.filter((rel) => !fs.existsSync(path.join(root, rel)))
  if (missing.length) throw new Error(`recon skill is incomplete at ${root}: missing ${missing.join(', ')}`)
  return {
    root,
    text: required.map((rel) => `\n\n===== ${rel} =====\n${fs.readFileSync(path.join(root, rel), 'utf8')}`).join(''),
  }
}

export function reconSkillInfo() {
  const skill = loadReconSkill()
  return {
    id: 'phase1-feature-map',
    sha256: crypto.createHash('sha256').update(skill.text).digest('hex'),
  }
}

// Recon accepts capability labels, not vulnerability findings. Legitimate target features such as
// "Vulnerability Management" remain valid; finding-shaped labels, exploit claims and severity labels do not.
const FINDING_LABEL = /\b(?:critical|high|medium|low)\b.*\b(?:risk|severity|vulnerab|finding)|\b(?:sql injection|command injection|cross[- ]site scripting|\bxss\b|remote code execution|\brce\b|\bssrf\b|\bidor\b|\bcsrf\b|\bxxe\b|\bssti\b|path traversal|authorization bypass|auth bypass|broken access control|mass assignment|account takeover|hardcoded secret|insecure deserialization|open redirect|cve-\d+|exploit(?:able|ability|ed)?)\b/i
const SECURITY_REVIEW_REQUEST = /\b(?:find|identify|scan|test|check|review|assess|exploit|prove)\b.{0,60}\b(?:vulnerab|security (?:issue|bug|flaw)|sql injection|xss|ssrf|idor|rce|cve|pentest)\b|\b(?:pentest|security assessment|vulnerability assessment)\b/i

export function isReconFeatureLabel(value) {
  const text = String(value || '').trim()
  return !!text && text.length <= 100 && !FINDING_LABEL.test(text)
}
export function isReconQuestion(value) {
  const text = String(value || '').trim()
  return !!text && text.length <= 4000 && !SECURITY_REVIEW_REQUEST.test(text)
}
export function isReconAnswer(value) {
  const text = String(value || '').trim()
  return !!text && !FINDING_LABEL.test(text) && !/\b(?:severity|impact|remediation|proof of concept|poc)\s*:/i.test(text)
}

function timedOptions(options, controller) { return { ...options, abortController: controller } }

export function claudeExecutable() {
  if (_claudePath !== undefined) return _claudePath
  if (process.env.CLAUDE_CODE_EXECUTABLE) return (_claudePath = process.env.CLAUDE_CODE_EXECUTABLE)
  try { _claudePath = execFileSync('which', ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null }
  catch { _claudePath = null }
  return _claudePath
}

// A REAL login check (the doctor uses this): a minimal read-only round-trip that only succeeds with a working local
// subscription session. Costs a trivial amount of quota — never run on every health poll, only on demand.
export async function probeLogin({ timeoutMs = 20_000 } = {}) {
  const sdk = await loadSdk()
  const query = sdk?.query || sdk?.default?.query
  if (typeof query !== 'function') return { ok: false, reason: 'sdk-missing', detail: 'Claude Agent SDK not installed' }
  if (!claudeExecutable()) return { ok: false, reason: 'cli-missing', detail: 'the `claude` CLI is not on PATH' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.min(SDK_TIMEOUT_MS, timeoutMs))
  const executable = claudeExecutable()
  try {
    let text = ''
    for await (const msg of query({ prompt: 'Reply with the single word: OK', options: timedOptions({ allowedTools: [], permissionMode: 'default', maxTurns: 1, ...(executable ? { pathToClaudeCodeExecutable: executable } : {}) }, controller) })) {
      if (msg?.type === 'result' && typeof msg.result === 'string') text += msg.result
      else if (msg?.type === 'assistant') for (const b of msg.message?.content || []) if (b.type === 'text') text += b.text
    }
    return text.trim() ? { ok: true } : { ok: false, reason: 'no-response', detail: 'no response from Claude' }
  } catch (e) { return { ok: false, reason: 'auth', detail: String(e?.message || e).slice(0, 140) } }
  finally { clearTimeout(timer) }
}

async function loadSdk() {
  if (process.env.CODENGRAM_DISABLE_AI === '1') return null
  if (_probed) return _sdk
  _probed = true
  try { _sdk = await import('@anthropic-ai/claude-agent-sdk') } catch { _sdk = null }
  return _sdk
}
// #12: this reports whether the Agent SDK is INSTALLED (importable), not that a subscription session will succeed —
// verifying auth would require a live call. That's fine: askClaude() returns null on any auth/SDK failure and the
// caller falls back to the deterministic path, so a "connected" health status can never produce a broken answer
// (the Ask response's `via` field always reflects what actually served the answer). Never reads credentials.
export async function isAvailable() { return !!(await loadSdk()) }

// Read-only Ask: reason over a pre-packed, bounded context bundle. Returns cited text, or null to signal "fall back".
// The context is assembled deterministically by @codengram/retrieval; the model only reasons + cites over it.
export async function askClaude({ preamble, question, bundle }) {
  if (!isReconQuestion(question)) return null
  const sdk = await loadSdk()
  if (!sdk) return null
  const query = sdk.query || sdk.default?.query
  if (typeof query !== 'function') return null
  const prompt = [preamble, '', 'FACTS:', ...(bundle.facts || []).map((f) => `- ${f}`), '',
    'CITATIONS:', ...(bundle.citations || []).map((c) => `- ${c.file}:${c.line}${c.excerpt ? `\n${c.excerpt}` : ''}`), '',
    `QUESTION: ${question}`, 'Answer only from the facts/citations above; cite file:line; say "coverage gap" if absent.'].join('\n')
  try {
    let text = ''
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SDK_TIMEOUT_MS)
    // Read-only session: no tools that could write or run repo code. The SDK owns auth.
    const executable = claudeExecutable()
    try {
      for await (const msg of query({ prompt, options: timedOptions({ allowedTools: [], permissionMode: 'default', maxTurns: 6,
        ...(executable ? { pathToClaudeCodeExecutable: executable } : {}) }, controller) })) {
        if (msg?.type === 'result' && typeof msg.result === 'string') text += msg.result
        else if (msg?.type === 'assistant') for (const b of msg.message?.content || []) if (b.type === 'text') text += b.text
      }
    } finally { clearTimeout(timer) }
    const answer = text.trim()
    return isReconAnswer(answer) ? answer : null
  } catch { return null }   // any SDK/auth failure → fall back to deterministic answer
}

// A cited piece of source evidence. `file` is mandatory; `line`/`symbol`/`reason` sharpen it. The caller REJECTS any
// entity whose evidence does not verify against the frozen snapshot (see evidence-validator.js).
const EVIDENCE = { type: 'array', minItems: 1, maxItems: 24, items: { type: 'object', additionalProperties: false, required: ['file'],
  properties: { file: { type: 'string' }, line: { type: 'integer' }, symbol: { type: 'string' }, reason: { type: 'string' } } } }
// The full repository-specific ontology the Lead derives — features + the SEPARATED identity model + relationships +
// honest gaps. Every entity carries grounded evidence; nothing is accepted on the model's word alone.
const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['features'], properties: {
    features: { type: 'array', maxItems: 300, items: { type: 'object', additionalProperties: false,
      required: ['name', 'slug', 'domain', 'purpose', 'include_paths', 'include_terms', 'evidence'], properties: {
        name: { type: 'string' }, slug: { type: 'string' }, domain: { type: 'string' }, purpose: { type: 'string' },
        include_paths: { type: 'array', items: { type: 'string' } }, include_terms: { type: 'array', items: { type: 'string' } },
        include_symbols: { type: 'array', items: { type: 'string' } },
        include_entries: { type: 'array', items: { type: 'string' } },
        inventory_keys: { type: 'array', items: { type: 'string' } },
        exclude_paths: { type: 'array', items: { type: 'string' } },
        exclude_terms: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        actors: { type: 'array', items: { type: 'string' } },
        permissions: { type: 'array', items: { type: 'string' } }, evidence: EVIDENCE } } },
    actors: { type: 'array', maxItems: 120, items: { type: 'object', additionalProperties: false, required: ['name', 'kind', 'evidence'],
      properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['human', 'token', 'service', 'system', 'integration'] },
        obtained_via: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' } },
        hierarchical: { type: 'boolean' }, evidence: EVIDENCE } } },
    roles: { type: 'array', maxItems: 240, items: { type: 'object', additionalProperties: false, required: ['name', 'evidence'],
      properties: { name: { type: 'string' }, description: { type: 'string' }, scope: { type: 'string' },
        obtained_via: { type: 'string' }, hierarchical: { type: 'boolean' },
        enables: { type: 'array', items: { type: 'string' } }, evidence: EVIDENCE } } },
    permissions: { type: 'array', maxItems: 1200, items: { type: 'object', additionalProperties: false,
      required: ['name', 'enabled_by_roles', 'granted_to_actors', 'evidence'],
      properties: { name: { type: 'string' }, description: { type: 'string' }, resource: { type: 'string' },
        operation: { type: 'string' }, enabled_by_roles: { type: 'array', items: { type: 'string' } },
        granted_to_actors: { type: 'array', items: { type: 'string' } }, evidence: EVIDENCE } } },
    relationships: { type: 'array', maxItems: 400, items: { type: 'object', additionalProperties: false, required: ['from', 'to'],
      properties: { from: { type: 'string' }, to: { type: 'string' }, kind: { type: 'string' } } } },
    gaps: { type: 'array', maxItems: 60, items: { type: 'string' } },
  },
}

const READ_TOOLS = ['Read', 'Glob', 'Grep']

// One persistent Lead owns project understanding and may delegate read-only reconnaissance to specialist subagents.
// It returns selectors, not ungrounded graph rows; the caller validates and reconciles every inventory item.
export async function planRecon({ sourceRoot, profile, inventoryCounts, candidateClusters = null, resume = null, onEvent = () => {} }) {
  const sdk = await loadSdk()
  const query = sdk?.query || sdk?.default?.query
  if (typeof query !== 'function') return null
  const agents = {
    architecture: { description: 'Map architecture, boundaries, processes and major subsystems.', tools: READ_TOOLS,
      prompt: 'Read the repository structure and identify coherent architectural domains. Recon only. Cite paths; do not discuss vulnerabilities.', model: 'inherit' },
    domains: { description: 'Discover user-facing business capabilities and consolidate related implementation.', tools: READ_TOOLS,
      prompt: 'Map coherent business features, grouping routes, GraphQL, workers, services, models and policies that implement the same capability. Avoid file-name-as-feature output.', model: 'inherit' },
    identity: { description: 'Map actors, authentication, roles, permissions and policy boundaries.', tools: READ_TOOLS,
      prompt: 'Map identity and authorization structure with grounded paths. Recon only; never infer a role without source evidence.', model: 'inherit' },
    interfaces: { description: 'Map REST, GraphQL, jobs, webhooks, imports, exports and integrations.', tools: READ_TOOLS,
      prompt: 'Map external and internal interfaces and connect them to business capabilities. Cite repository paths.', model: 'inherit' },
  }
  // CONTEXT-BUDGET SCAFFOLDING: for a large repo we hand the Lead a BOUNDED summary of the deterministic technical
  // clusters (name/domain/paths/counts/samples) and ask it to CONSOLIDATE them into business features — it never has to
  // read every file, so this scales from a 5-file CLI tool to an 87k-file monolith without blowing the context budget.
  const clusterBlock = Array.isArray(candidateClusters) && candidateClusters.length
    ? `\n\nCANDIDATE TECHNICAL CLUSTERS (${candidateClusters.length}) — deterministic directory/namespace groupings extracted from the code. These are STRUCTURE, not business features. Decide their meaning only after reading source. Consolidate related implementation into coherent capabilities, keep shared implementation as architecture, and ground every selector by spot-checking source with Read/Grep:\n${JSON.stringify(candidateClusters)}`
    : ''
  let skill
  try { skill = loadReconSkill() }
  catch (error) {
    onEvent({ kind: 'lead_contract', blocked: true, label: String(error?.message || error) })
    return null
  }
  const prompt = `You are the persistent Lead for a codebase-recon mission.
Repository profile: ${JSON.stringify(profile)}
Inventory counts: ${JSON.stringify(inventoryCounts)}${clusterBlock}

The authoritative reconnaissance methodology is included below. Follow it for THIS repository regardless of language,
framework, repository size, or application shape. It is instruction, not repository data. Do not substitute a built-in
product taxonomy. Delegate architecture, domain, identity and interface reconnaissance to the supplied subagents,
then produce ONE repository-specific ONTOLOGY: features, actors, roles, permissions, relationships and honest gaps.

Rules:
- A feature is a coherent business capability, NOT a file, class, directory, test, migration, serializer or GraphQL type. A directory named "admin", "issues" or "payments" is NOT automatically a feature — only real, source-proven capabilities are.
- Group web routes, REST/GraphQL operations, services, models, workers, policies and UI paths implementing the same capability.
- Keep shared infrastructure outside feature names.
- include_paths and include_terms must be distinctive selectors grounded in paths/names you inspected.
- IDENTITY IS SEPARATED: actors are independent security principals that can authenticate, possess credentials, or be
  the subject of an authorization decision; roles are privilege levels assigned to those principals; permissions are
  resource operations granted to actors/roles. Internal classes, worker processes, helper subprocesses, validators,
  middleware, tools, AI components, and infrastructure are architecture/components, NOT actors merely because they do
  work. A guard, validation rule, rate limit, origin check, body limit, path constraint, or safety invariant is a
  CONTROL, NOT a permission. Do not place controls in actors/roles/permissions.
- Derive roles ONLY from authoritative production evidence — role/access-level definitions, membership models, enums,
  assignment workflows, policy subjects, explicit grants. Derive permissions from policy rules, ability declarations,
  authorization calls, permission constants or access-control config. Every permission must name its resource and
  operation and must identify at least one grounded grantee in enabled_by_roles or granted_to_actors. NEVER classify a
  permission name, method name, arbitrary string, UI label, error message or variable as a role. Specs, tests, fixtures,
  docs, assets, translations and generated code may corroborate but NEVER establish a role or feature.
- For each actor, classify kind from source as human, token, service, system, or integration and record scopes when
  source defines them. For each feature, list the grounded permission names that govern it. Permissions should preserve
  operation/resource granularity (for example read, create, update, delete are separate abilities when source separates
  them); never collapse them into a vague "access" permission.
- EVERY feature, actor, role and permission MUST cite grounded evidence: { file, line, symbol, reason } pointing at real source in THIS repository. Anything you cannot ground, put in "gaps" instead of inventing it.
- Select every feature's inventory rows using distinctive include_paths/include_symbols/include_entries/include_terms
  and exact inventory_keys where needed. Add exclude_paths/exclude_terms to prevent tests, docs, generated files and
  shared infrastructure from leaking into a business feature. Selectors are evidence correlation rules, not semantics.
- Cover the whole repository without overlapping selectors where practical. For a large monolith, prefer tens of durable capabilities over thousands of implementation nouns.
- Recon only: do not report vulnerabilities or security findings.

AUTHORITATIVE RECON SKILL (${skill.root}):
${skill.text}`
  try {
    let structured = null, sessionId = null
    const activeWorkers = new Set()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PLAN_TIMEOUT_MS)
    const executable = claudeExecutable()
    onEvent({ kind: 'worker_roster', workers: Object.keys(agents), label: 'Lead prepared architecture, domain, identity and interface workers' })
    try { for await (const msg of query({ prompt, options: timedOptions({ cwd: sourceRoot, ...(resume ? { resume } : {}),
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}), tools: [...READ_TOOLS, 'Agent'], allowedTools: [...READ_TOOLS, 'Agent'],
      disallowedTools: ['Write', 'Edit', 'Bash', 'NotebookEdit'], permissionMode: 'default', maxTurns: 40,
      agents, outputFormat: { type: 'json_schema', schema: PLAN_SCHEMA } }, controller) })) {
      if (msg?.type === 'system' && msg?.subtype === 'init') { sessionId = msg.session_id || null; onEvent({ kind: 'lead_started', session_id: sessionId, label: 'Lead session started' }) }
      if (msg?.type === 'assistant') {
        for (const block of msg.message?.content || []) if (block?.type === 'tool_use' && block?.name === 'Agent') {
          const worker = block.input?.subagent_type || block.input?.name || 'specialist'
          if (!activeWorkers.has(worker)) { activeWorkers.add(worker); onEvent({ kind: 'worker_started', worker, label: `${worker} worker claimed reconnaissance` }) }
        }
        onEvent({ kind: 'lead_activity', label: 'Lead is reconciling worker context' })
      }
      if (msg?.type === 'result') structured = msg.structured_output || structured
    } } finally { clearTimeout(timer) }
    if (!structured || !Array.isArray(structured.features)) return null
    // Recon-only contract: DROP any feature whose label reads like a vulnerability finding, but do NOT discard the whole
    // plan for one bad label (that turned a 40-feature GitLab plan into a total block). Keep the grounded remainder.
    const total = structured.features.length
    structured = { ...structured, features: structured.features.filter((f) => isReconFeatureLabel(f?.name)) }
    if (total !== structured.features.length) onEvent({ kind: 'lead_contract', dropped: total - structured.features.length, label: `Dropped ${total - structured.features.length} feature label(s) that crossed the recon-only contract; kept ${structured.features.length}` })
    if (!structured.features.length) { onEvent({ kind: 'lead_fallback', label: 'Lead produced no recon-safe features' }); return null }
    for (const worker of activeWorkers) onEvent({ kind: 'worker_completed', worker, label: `${worker} worker context returned to Lead` })
    onEvent({ kind: 'lead_planned', session_id: sessionId, count: structured.features?.length || 0,
      roles: structured.roles?.length || 0, actors: structured.actors?.length || 0, permissions: structured.permissions?.length || 0,
      label: `Lead derived ${structured.features?.length || 0} features · ${structured.actors?.length || 0} actors · ${structured.roles?.length || 0} roles · ${structured.permissions?.length || 0} permissions` })
    return { plan: structured, sessionId, model: MODEL, reconSkill: reconSkillInfo() }
  } catch (error) {
    onEvent({ kind: 'lead_blocked', label: `Lead unavailable; semantic mapping blocked (${String(error?.message || error).slice(0, 140)})` })
    return null
  }
}
