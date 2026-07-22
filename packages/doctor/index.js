// @codengram/doctor — preflight checks run BEFORE a scan or the server, so problems are shown up front instead of
// failing mid-run. Hard failures (Node too old, no SQLite, unwritable data dir, port taken) block; AI/login issues
// are warnings (the tool works deterministically without Claude).
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { isAvailable, claudeExecutable, probeLogin } from '../claude-runtime/index.js'

export const REQUIRED_NODE_MAJOR = 22
const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer()
  s.once('error', () => resolve(false))
  s.once('listening', () => s.close(() => resolve(true)))
  s.listen(port, '127.0.0.1')
})

// Returns { ok, checks:[{ name, status:'ok'|'warn'|'fail', detail, fix }] }. ok=false iff any check FAILED.
// probeAi=true does a real (quota-costing) Claude login round-trip; leave it off for fast per-run preflights.
export async function runDoctor({ dataRoot = 'data', port = null, probeAi = false } = {}) {
  const checks = []
  const add = (name, status, detail, fix) => checks.push({ name, status, detail, fix })

  const major = Number(String(process.versions.node).split('.')[0])
  major >= REQUIRED_NODE_MAJOR
    ? add('Node.js', 'ok', `v${process.versions.node}`)
    : add('Node.js', 'fail', `v${process.versions.node} — Codengram needs Node ${REQUIRED_NODE_MAJOR}+`, 'Install Node 22+ (e.g. `nvm install 22 && nvm use 22`)')

  try { const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE t(x)'); db.close(); add('SQLite (built-in)', 'ok', 'node:sqlite working') }
  catch (e) { add('SQLite (built-in)', 'fail', `node:sqlite unavailable: ${e.message}`, 'Node 22+ ships built-in SQLite — upgrade Node') }

  try {
    fs.mkdirSync(dataRoot, { recursive: true })
    const probe = path.join(dataRoot, '.doctor-probe'); fs.writeFileSync(probe, 'ok'); fs.rmSync(probe)
    add('Data directory', 'ok', `writable · ${path.resolve(dataRoot)}`)
  } catch { add('Data directory', 'fail', `not writable: ${path.resolve(dataRoot)}`, 'Fix permissions or pass a different --data dir') }

  if (port != null) {
    (await portFree(port))
      ? add('Server port', 'ok', `${port} is free`)
      : add('Server port', 'fail', `port ${port} is already in use`, `Stop the other process, or run with a different --port`)
  }

  // ── AI (optional — the tool is fully functional without it) ──
  const sdk = await isAvailable()
  const cli = claudeExecutable()
  if (!sdk) add('Claude Agent SDK', 'warn', 'not installed — running in deterministic mode', 'Run `npm install` to enable optional Claude features')
  else if (!cli) add('Claude CLI', 'warn', '`claude` not found on PATH — deterministic mode', 'Install Claude Code, then run `claude` once')
  else if (probeAi) {
    const login = await probeLogin()
    login.ok
      ? add('Claude login', 'ok', 'subscription session working')
      : add('Claude login', 'warn', `not logged in — deterministic mode (${login.detail || login.reason})`, 'Run `claude`, then `/login`')
  } else add('Claude', 'ok', 'SDK + CLI present (login verified on first use, or run `doctor` to probe now)')

  return { ok: !checks.some((c) => c.status === 'fail'), checks }
}

// Pretty terminal report; returns the same ok boolean.
export function printDoctor({ ok, checks }, log = console.log) {
  const icon = { ok: '\x1b[32m✓\x1b[0m', warn: '\x1b[33m⚠\x1b[0m', fail: '\x1b[31m✗\x1b[0m' }
  const bold = (s) => `\x1b[1m${s}\x1b[0m`, dim = (s) => `\x1b[2m${s}\x1b[0m`
  log(`\n  ${bold('codengram doctor')}\n`)
  for (const c of checks) {
    log(`  ${icon[c.status]} ${c.name.padEnd(20)} ${dim(c.detail || '')}`)
    if (c.status !== 'ok' && c.fix) log(`      ${dim('→ ' + c.fix)}`)
  }
  log(`\n  ${ok ? '\x1b[32mReady.\x1b[0m' : '\x1b[31mBlocked — fix the ✗ items above before running.\x1b[0m'}\n`)
  return ok
}
