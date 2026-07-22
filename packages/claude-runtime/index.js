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

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['features'], properties: {
    features: { type: 'array', maxItems: 250, items: { type: 'object', additionalProperties: false,
      required: ['name', 'slug', 'domain', 'purpose', 'include_paths', 'include_terms'], properties: {
        name: { type: 'string' }, slug: { type: 'string' }, domain: { type: 'string' }, purpose: { type: 'string' },
        include_paths: { type: 'array', items: { type: 'string' } }, include_terms: { type: 'array', items: { type: 'string' } },
      } } },
  },
}

const READ_TOOLS = ['Read', 'Glob', 'Grep']

// One persistent Lead owns project understanding and may delegate read-only reconnaissance to specialist subagents.
// It returns selectors, not ungrounded graph rows; the caller validates and reconciles every inventory item.
export async function planRecon({ sourceRoot, profile, inventoryCounts, resume = null, onEvent = () => {} }) {
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
  const prompt = `You are the persistent Lead for a codebase-recon mission.
Repository profile: ${JSON.stringify(profile)}
Inventory counts: ${JSON.stringify(inventoryCounts)}

Delegate architecture, domain, identity and interface reconnaissance to the supplied subagents where useful. Then produce ONE semantic feature plan for the entire repository.

Rules:
- A feature is a coherent business capability, not a file, class, test, migration, serializer or GraphQL type.
- Group web routes, REST/GraphQL operations, services, models, workers, policies and UI paths implementing the same capability.
- Keep shared infrastructure outside feature names.
- include_paths and include_terms must be distinctive selectors grounded in paths/names you inspected.
- Cover the whole repository without overlapping selectors where practical.
- For a large monolith, prefer tens of durable capabilities over thousands of implementation nouns.
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
    if (!structured) return null
    if (!Array.isArray(structured.features) || structured.features.some((f) => !isReconFeatureLabel(f?.name))) {
      onEvent({ kind: 'lead_fallback', label: 'Lead output crossed the recon-only contract; using deterministic semantic planner' })
      return null
    }
    // AI chooses coherent groupings/selectors. Persisted descriptions are regenerated from grounded inventory.
    structured = { ...structured, features: structured.features.map((f) => ({ ...f, purpose: '' })) }
    for (const worker of activeWorkers) onEvent({ kind: 'worker_completed', worker, label: `${worker} worker context returned to Lead` })
    onEvent({ kind: 'lead_planned', session_id: sessionId, count: structured.features?.length || 0,
      label: `Lead consolidated ${structured.features?.length || 0} semantic features` })
    return { plan: structured, sessionId }
  } catch (error) {
    onEvent({ kind: 'lead_fallback', label: `Lead unavailable; using deterministic semantic planner (${String(error?.message || error).slice(0, 140)})` })
    return null
  }
}
