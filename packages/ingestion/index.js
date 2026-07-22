// @codengram/ingestion — M1: projects + IMMUTABLE snapshots with a FROZEN source tree.
//
// A snapshot freezes exactly the reviewable file set (the profiler's source predicate) into `source/`, records a
// per-file manifest with hashes, and is addressed by a content hash — so the SAME source yields the SAME snapshot id
// (the basis for dedup + incremental refresh). Provenance resolves file:line against the frozen `source/`, never the
// live repo. Deletion removes only generated `data/`; the user's source is never touched.
//
// Freeze strategy: content-addressed COPY in all cases (git metadata recorded when present).
// ponytail: git-worktree/`git archive` would avoid a copy for huge clean repos — an optimization, not correctness.
//   The copy is deterministic and unifies git + dirty + non-git on one path. Swap in worktree at M15 if scale needs it.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { isSourceFile } from '../profiler/index.js'
import { ID, safeRelPath, slug } from '../schemas/index.js'

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const nowIso = () => new Date().toISOString()
const SKIP_DIR = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'coverage', '.next', 'tmp', 'log',
  'logs', '__pycache__', '.venv', 'venv', 'target', 'data']) // 'data' = Codengram's own output dir

const projectsRoot = (dataRoot) => path.join(dataRoot, 'projects')
// #1 CRITICAL GUARD: a malformed id (e.g. "!!!") slugs to '' and would collapse a path to the PARENT directory —
// deleteProject would then wipe every project. Refuse any id that doesn't yield a non-empty, prefixed path segment.
function idSeg(id, prefix) {
  const s = String(id || '')
  if (prefix && !s.startsWith(prefix + ':')) throw new Error(`expected a ${prefix}: id, got ${JSON.stringify(id)}`)
  const seg = slug(s)
  if (!seg) throw new Error(`refusing empty/invalid path segment for id ${JSON.stringify(id)}`)
  return seg
}
const projectDir = (dataRoot, projectId) => path.join(projectsRoot(dataRoot), idSeg(projectId, 'project'))
export const snapshotDir = (dataRoot, projectId, snapshotId) =>
  path.join(projectDir(dataRoot, projectId), 'snapshots', idSeg(snapshotId, 'snapshot'))

// Refuse to touch anything outside dataRoot — the guarantee that deletion never reaches the user's source.
function assertUnderData(dataRoot, target) {
  const root = path.resolve(dataRoot), t = path.resolve(target)
  if (t !== root && !t.startsWith(root + path.sep)) throw new Error(`refusing to write/delete outside data root: ${t}`)
  return t
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, file)
}
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

// ── projects ─────────────────────────────────────────────────────────────────────────────────
export function createProject(dataRoot, sourceRoot, { name, now = nowIso() } = {}) {
  const abs = path.resolve(sourceRoot)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`source root is not a directory: ${abs}`)
  const id = ID.project(abs)                    // stable key = absolute path, independent of display name
  const dir = assertUnderData(dataRoot, projectDir(dataRoot, id))
  const existing = readJson(path.join(dir, 'project.json'))
  if (existing) return existing                 // idempotent: re-creating the same repo returns the same project
  const project = { id, name: name || path.basename(abs), source_root: abs, created_at: now }
  writeJson(path.join(dir, 'project.json'), project)
  return project
}
export const getProject = (dataRoot, projectId) => { try { return readJson(path.join(projectDir(dataRoot, projectId), 'project.json')) } catch { return null } }
export function listProjects(dataRoot) {
  let names; try { names = fs.readdirSync(projectsRoot(dataRoot)) } catch { return [] }
  return names.map((n) => readJson(path.join(projectsRoot(dataRoot), n, 'project.json'))).filter(Boolean)
    .sort((a, b) => String(a.created_at).localeCompare(b.created_at))
}
export function deleteProject(dataRoot, projectId) {
  const dir = assertUnderData(dataRoot, projectDir(dataRoot, projectId))
  fs.rmSync(dir, { recursive: true, force: true })   // only ever under data/ — source_root lives elsewhere, untouched
}

// ── snapshots ────────────────────────────────────────────────────────────────────────────────
// Walk the source tree (skip build/vendor dirs), keep files matching `include` (default: profiler source predicate).
function walkSource(root, include, base = root, out = []) {
  let entries; try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(root, e.name)
    if (e.isSymbolicLink()) continue                          // never follow symlinks out of the repo
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walkSource(full, include, base, out); continue }
    if (!include(e.name)) continue
    out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}
function gitMeta(sourceRoot) {
  // Repositories are untrusted input. In particular, `git status` consults repo-local core.fsmonitor and can execute
  // an arbitrary command. Override every execution-capable facility used by these read-only metadata calls, ignore
  // user/system configuration, disable prompts and locks, and never let Git block a scan indefinitely.
  const env = { ...process.env, GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  const hardened = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat']
  const git = (args) => execFileSync('git', [...hardened, '-C', sourceRoot, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env, timeout: 5000, maxBuffer: 1024 * 1024,
  }).trim()
  try {
    const sha = git(['rev-parse', 'HEAD'])
    const tree_sha = git(['rev-parse', 'HEAD^{tree}'])
    const dirty = git(['status', '--porcelain']).length > 0
    return { sha, tree_sha, dirty }
  } catch { return null }   // not a git repo (or no commits) — content hash still makes it deterministic
}

// Create (or reuse) an immutable frozen snapshot of a project's source. Idempotent by content hash.
export function createSnapshot(dataRoot, projectId, { include = isSourceFile, now = nowIso() } = {}) {
  const project = getProject(dataRoot, projectId)
  if (!project) throw new Error(`unknown project: ${projectId}`)
  const src = project.source_root

  // #5: STREAM one file at a time — read → hash → freeze → discard — so peak memory is a single file, not the whole
  //     repo (GitLab-scale safe). We hash the SAME bytes we freeze (no TOCTOU double-read). The snapshot id is
  //     content-addressed, so we build into a `.building` temp dir first, then rename once the id is known.
  const rels = walkSource(src, include).sort()
  const snapsRoot = path.join(projectDir(dataRoot, projectId), 'snapshots')
  const tmp = assertUnderData(dataRoot, path.join(snapsRoot, `.building-${process.pid}-${Date.now().toString(36)}`))
  fs.rmSync(tmp, { recursive: true, force: true })
  const srcOut = path.join(tmp, 'source')
  fs.mkdirSync(srcOut, { recursive: true })   // create up front so a ZERO-file repo still writes its (empty) manifest
  const manifest = []; let bytes = 0
  try {
    for (const rel of rels) {
      const buf = fs.readFileSync(path.join(src, safeRelPath(rel)))     // one file in memory at a time
      manifest.push({ path: rel, bytes: buf.length, sha256: sha256(buf) }); bytes += buf.length
      const dest = path.join(srcOut, safeRelPath(rel))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, buf)                                       // freeze exactly what we hashed; buf then GC'd
    }
    const content_hash = sha256(manifest.map((m) => `${m.path}\0${m.sha256}`).join('\n'))
    const snapshot_id = ID.snapshot(content_hash)
    const dir = assertUnderData(dataRoot, snapshotDir(dataRoot, projectId, snapshot_id))
    const existing = readJson(path.join(dir, 'snapshot.json'))
    if (existing && existing.source_frozen) { fs.rmSync(tmp, { recursive: true, force: true }); return existing }  // dedup

    fs.writeFileSync(path.join(tmp, 'source-manifest.jsonl'), manifest.map((m) => JSON.stringify(m)).join('\n') + (manifest.length ? '\n' : ''))
    const snapshot = {
      id: snapshot_id, project_id: project.id, kind: 'cas', content_hash,
      git: gitMeta(src), file_count: manifest.length, bytes,
      // source_frozen = the immutable source freeze (M1). Publication sealing (M7) is a separate CURRENT pointer.
      source_dir: 'source', source_frozen: true, created_at: now,
    }
    fs.writeFileSync(path.join(tmp, 'snapshot.json'), JSON.stringify(snapshot, null, 2))
    fs.rmSync(dir, { recursive: true, force: true })
    fs.renameSync(tmp, dir)                                             // atomic: snapshot appears fully-formed
    return snapshot
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e }
}
export function listSnapshots(dataRoot, projectId) {
  let base; try { base = path.join(projectDir(dataRoot, projectId), 'snapshots') } catch { return [] }
  let names; try { names = fs.readdirSync(base) } catch { return [] }
  return names.map((n) => readJson(path.join(base, n, 'snapshot.json'))).filter(Boolean)
    .sort((a, b) => String(a.created_at).localeCompare(b.created_at))
}
export const getSnapshot = (dataRoot, projectId, snapshotId) => { try { return readJson(path.join(snapshotDir(dataRoot, projectId, snapshotId), 'snapshot.json')) } catch { return null } }
export function deleteSnapshot(dataRoot, projectId, snapshotId) {
  fs.rmSync(assertUnderData(dataRoot, snapshotDir(dataRoot, projectId, snapshotId)), { recursive: true, force: true })
}

// The frozen `source/` root of a snapshot (recon reads this, never the live repo).
export const sourceRootDir = (dataRoot, projectId, snapshotId) =>
  path.join(snapshotDir(dataRoot, projectId, snapshotId), 'source')

// ── provenance resolution (against the frozen source, not the live repo) ───────────────────────
export function resolveSource(dataRoot, projectId, snapshotId, relPath) {
  const dir = snapshotDir(dataRoot, projectId, snapshotId)
  return path.join(dir, 'source', safeRelPath(relPath))   // safeRelPath rejects `..` — no escape from source/
}
// Pull a 1-indexed inclusive line range for a citation. Returns '' if the file/range is absent.
export function readSourceLines(dataRoot, projectId, snapshotId, relPath, start = 1, end = null) {
  let txt; try { txt = fs.readFileSync(resolveSource(dataRoot, projectId, snapshotId, relPath), 'utf8') } catch { return '' }
  const lines = txt.split(/\r?\n/)
  const s = Math.max(1, start | 0), e = end == null ? s : Math.max(s, end | 0)
  return lines.slice(s - 1, e).join('\n')
}
