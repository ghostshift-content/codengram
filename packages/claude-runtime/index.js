// @codengram/claude-runtime — the Claude Agent SDK adapter (BLUEPRINT §2a, §5, §6).
//
// AUTH IS NOT OUR JOB. Codengram runs through the user's existing official Claude Code subscription via the Agent
// SDK. We never implement OAuth, never read/copy/export/log/store credentials, never inspect the Keychain or
// ~/.claude/.credentials.json, never ask for an API key. The SDK resolves the local Claude Code login itself.
//
// This module is OPTIONAL: if the SDK isn't installed (or no local session is reachable), isAvailable() is false and
// every caller falls back to the deterministic path — the app is fully functional offline.
import { execFileSync } from 'node:child_process'

let _sdk           // cached dynamic import result: module | null
let _probed = false
let _claudePath
const SDK_TIMEOUT_MS = Math.max(5_000, Number(process.env.CODENGRAM_AI_TIMEOUT_MS) || 120_000)
const MODEL = process.env.CODENGRAM_MODEL || 'claude-agent-sdk'   // recorded in provenance; SDK owns the concrete model

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
const EVIDENCE = { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['file'],
  properties: { file: { type: 'string' }, line: { type: 'integer' }, symbol: { type: 'string' }, reason: { type: 'string' } } } }
// The full repository-specific ontology the Lead derives — features + the SEPARATED identity model + relationships +
// honest gaps. Every entity carries grounded evidence; nothing is accepted on the model's word alone.
const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['features'], properties: {
    features: { type: 'array', maxItems: 300, items: { type: 'object', additionalProperties: false,
      required: ['name', 'slug', 'domain', 'purpose', 'include_paths', 'include_terms'], properties: {
        name: { type: 'string' }, slug: { type: 'string' }, domain: { type: 'string' }, purpose: { type: 'string' },
        include_paths: { type: 'array', items: { type: 'string' } }, include_terms: { type: 'array', items: { type: 'string' } },
        actors: { type: 'array', items: { type: 'string' } }, evidence: EVIDENCE } } },
    actors: { type: 'array', maxItems: 60, items: { type: 'object', additionalProperties: false, required: ['name'],
      properties: { name: { type: 'string' }, obtained_via: { type: 'string' }, hierarchical: { type: 'boolean' }, evidence: EVIDENCE } } },
    roles: { type: 'array', maxItems: 120, items: { type: 'object', additionalProperties: false, required: ['name'],
      properties: { name: { type: 'string' }, hierarchical: { type: 'boolean' }, enables: { type: 'array', items: { type: 'string' } }, evidence: EVIDENCE } } },
    permissions: { type: 'array', maxItems: 400, items: { type: 'object', additionalProperties: false, required: ['name'],
      properties: { name: { type: 'string' }, enabled_by_roles: { type: 'array', items: { type: 'string' } }, evidence: EVIDENCE } } },
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
    ? `\n\nCANDIDATE TECHNICAL CLUSTERS (${candidateClusters.length}) — deterministic directory/namespace groupings extracted from the code. These are STRUCTURE, not business features. CONSOLIDATE them into coherent business capabilities (many clusters may fold into one feature; a cluster named "asset", "concern", "config", "policy" or "serializer" is infrastructure, not a feature). Ground each feature's include_paths in these cluster paths and spot-check source with Read/Grep to confirm:\n${JSON.stringify(candidateClusters).slice(0, 60000)}`
    : ''
  const prompt = `You are the persistent Lead for a codebase-recon mission.
Repository profile: ${JSON.stringify(profile)}
Inventory counts: ${JSON.stringify(inventoryCounts)}${clusterBlock}

Delegate architecture, domain, identity and interface reconnaissance to the supplied subagents where useful. Then produce ONE repository-specific ONTOLOGY: features, actors, roles, permissions, relationships and honest gaps.

Rules:
- A feature is a coherent business capability, NOT a file, class, directory, test, migration, serializer or GraphQL type. A directory named "admin", "issues" or "payments" is NOT automatically a feature — only real, source-proven capabilities are.
- Group web routes, REST/GraphQL operations, services, models, workers, policies and UI paths implementing the same capability.
- Keep shared infrastructure outside feature names.
- include_paths and include_terms must be distinctive selectors grounded in paths/names you inspected.
- IDENTITY IS SEPARATED: actors (who acts), roles (privilege levels), permissions (abilities). Derive roles ONLY from authoritative production evidence — role/access-level definitions, membership models, enums, assignment workflows, policy subjects, explicit grants. Derive permissions from policy rules, ability declarations, authorization calls, permission constants or access-control config. NEVER classify a permission name, method name, arbitrary string, UI label, error message or variable as a role. Specs, tests, fixtures, docs, assets, translations and generated code may corroborate but NEVER establish a role or feature.
- EVERY feature, actor, role and permission MUST cite grounded evidence: { file, line, symbol, reason } pointing at real source in THIS repository. Anything you cannot ground, put in "gaps" instead of inventing it.
- Cover the whole repository without overlapping selectors where practical. For a large monolith, prefer tens of durable capabilities over thousands of implementation nouns.
- Recon only: do not report vulnerabilities or security findings.`
  try {
    let structured = null, sessionId = null
    const activeWorkers = new Set()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SDK_TIMEOUT_MS)
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
    structured = { ...structured, features: structured.features.filter((f) => isReconFeatureLabel(f?.name)).map((f) => ({ ...f, purpose: '' })) }
    if (total !== structured.features.length) onEvent({ kind: 'lead_contract', dropped: total - structured.features.length, label: `Dropped ${total - structured.features.length} feature label(s) that crossed the recon-only contract; kept ${structured.features.length}` })
    if (!structured.features.length) { onEvent({ kind: 'lead_fallback', label: 'Lead produced no recon-safe features' }); return null }
    for (const worker of activeWorkers) onEvent({ kind: 'worker_completed', worker, label: `${worker} worker context returned to Lead` })
    onEvent({ kind: 'lead_planned', session_id: sessionId, count: structured.features?.length || 0,
      roles: structured.roles?.length || 0, actors: structured.actors?.length || 0, permissions: structured.permissions?.length || 0,
      label: `Lead derived ${structured.features?.length || 0} features · ${structured.actors?.length || 0} actors · ${structured.roles?.length || 0} roles · ${structured.permissions?.length || 0} permissions` })
    return { plan: structured, sessionId, model: MODEL }
  } catch (error) {
    onEvent({ kind: 'lead_fallback', label: `Lead unavailable; using deterministic semantic planner (${String(error?.message || error).slice(0, 140)})` })
    return null
  }
}
