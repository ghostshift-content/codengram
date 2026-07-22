'use strict'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as I from '../index.js'

// A throwaway { dataRoot, repo } pair with a small source tree written into `repo`.
function scaffold() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ing-'))
  const repo = path.join(base, 'repo'), dataRoot = path.join(base, 'data')
  fs.mkdirSync(path.join(repo, 'app', 'controllers'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'node_modules', 'junk'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'Gemfile'), "gem 'rails'\n")
  fs.writeFileSync(path.join(repo, 'app', 'controllers', 'users_controller.rb'), 'class UsersController\n  def index; end\nend\n')
  fs.writeFileSync(path.join(repo, 'node_modules', 'junk', 'big.js'), 'x'.repeat(5000)) // must be excluded
  fs.writeFileSync(path.join(repo, 'logo.png'), 'PNG')                                   // non-source, excluded
  return { base, repo, dataRoot }
}

test('project create is idempotent + id is stable from the path, not the name', () => {
  const { base, repo, dataRoot } = scaffold()
  const a = I.createProject(dataRoot, repo, { name: 'First' })
  const b = I.createProject(dataRoot, repo, { name: 'Renamed' })
  assert.equal(a.id, b.id, 'same repo path ⇒ same project id')
  assert.equal(b.name, 'First', 'existing project is returned, not overwritten')
  assert.deepEqual(I.listProjects(dataRoot).map((p) => p.id), [a.id])
  fs.rmSync(base, { recursive: true, force: true })
})

test('snapshot freezes only source files, writes a hashed manifest, and is content-addressed + idempotent', () => {
  const { base, repo, dataRoot } = scaffold()
  const p = I.createProject(dataRoot, repo)
  const s1 = I.createSnapshot(dataRoot, p.id)
  assert.ok(s1.id.startsWith('snapshot:') && s1.source_frozen && s1.kind === 'cas')
  assert.equal(s1.file_count, 2, 'Gemfile + users_controller.rb; node_modules + logo.png excluded')

  const dir = I.snapshotDir(dataRoot, p.id, s1.id)
  assert.ok(fs.existsSync(path.join(dir, 'source', 'app', 'controllers', 'users_controller.rb')), 'frozen source present')
  assert.ok(!fs.existsSync(path.join(dir, 'source', 'node_modules')), 'build dirs never frozen')
  const manifest = fs.readFileSync(path.join(dir, 'source-manifest.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(manifest.length, 2)
  assert.ok(manifest.every((m) => /^[0-9a-f]{64}$/.test(m.sha256) && m.bytes > 0))

  const s2 = I.createSnapshot(dataRoot, p.id)          // no source change ⇒ same id, reused
  assert.equal(s2.id, s1.id)
  assert.deepEqual(I.listSnapshots(dataRoot, p.id).map((s) => s.id), [s1.id], 'dedup: one snapshot, not two')

  fs.writeFileSync(path.join(repo, 'app', 'new.rb'), 'class New; end\n')  // change source ⇒ new snapshot
  const s3 = I.createSnapshot(dataRoot, p.id)
  assert.notEqual(s3.id, s1.id)
  assert.equal(I.listSnapshots(dataRoot, p.id).length, 2)
  fs.rmSync(base, { recursive: true, force: true })
})

test('an empty source directory produces a valid (0-file) snapshot, not a crash', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-empty-'))
  const repo = path.join(base, 'empty'), dataRoot = path.join(base, 'data')
  fs.mkdirSync(repo)
  const p = I.createProject(dataRoot, repo)
  const s = I.createSnapshot(dataRoot, p.id)
  assert.equal(s.file_count, 0)
  assert.ok(fs.existsSync(path.join(I.snapshotDir(dataRoot, p.id, s.id), 'source-manifest.jsonl')), 'empty manifest still written')
  fs.rmSync(base, { recursive: true, force: true })
})

test('provenance resolves against the frozen source; path traversal is rejected', () => {
  const { base, repo, dataRoot } = scaffold()
  const p = I.createProject(dataRoot, repo)
  const s = I.createSnapshot(dataRoot, p.id)
  assert.equal(I.readSourceLines(dataRoot, p.id, s.id, 'app/controllers/users_controller.rb', 1, 1), 'class UsersController')
  assert.equal(I.readSourceLines(dataRoot, p.id, s.id, 'app/controllers/users_controller.rb', 2, 2), '  def index; end')
  assert.throws(() => I.resolveSource(dataRoot, p.id, s.id, '../../etc/passwd'), /unsafe/)

  // editing the live repo after freezing must NOT change what the snapshot resolves — it's frozen
  fs.writeFileSync(path.join(repo, 'app', 'controllers', 'users_controller.rb'), 'class Hacked; end\n')
  assert.equal(I.readSourceLines(dataRoot, p.id, s.id, 'app/controllers/users_controller.rb', 1, 1), 'class UsersController')
  fs.rmSync(base, { recursive: true, force: true })
})

test('#1 a malformed id can never collapse a path and wipe other projects', () => {
  const { base, repo, dataRoot } = scaffold()
  const a = I.createProject(dataRoot, repo)                       // one real project
  assert.throws(() => I.deleteProject(dataRoot, '!!!'), /project: id|empty\/invalid/)  // never resolves to the parent dir
  assert.throws(() => I.deleteProject(dataRoot, ''), /project: id|empty\/invalid/)
  assert.throws(() => I.snapshotDir(dataRoot, a.id, '###'), /snapshot: id|empty\/invalid/)
  assert.ok(I.getProject(dataRoot, a.id), 'the real project survived the malformed-delete attempts')
  fs.rmSync(base, { recursive: true, force: true })
})

test('deletion removes only generated data, never the source repo', () => {
  const { base, repo, dataRoot } = scaffold()
  const p = I.createProject(dataRoot, repo)
  I.createSnapshot(dataRoot, p.id)
  I.deleteProject(dataRoot, p.id)
  assert.equal(I.getProject(dataRoot, p.id), null)
  assert.ok(fs.existsSync(path.join(repo, 'Gemfile')), 'source repo untouched by deletion')
  fs.rmSync(base, { recursive: true, force: true })
})

test('git metadata is recorded when the source is a git repo', () => {
  const { base, repo, dataRoot } = scaffold()
  try {
    execFileSync('git', ['-C', repo, 'init', '-q'], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t.co'], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'config', 'user.name', 't'], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'init'], { stdio: 'ignore' })
  } catch { fs.rmSync(base, { recursive: true, force: true }); return } // git unavailable → skip silently
  const p = I.createProject(dataRoot, repo)
  const s = I.createSnapshot(dataRoot, p.id)
  assert.ok(s.git && /^[0-9a-f]{40}$/.test(s.git.sha) && s.git.dirty === false)
  fs.rmSync(base, { recursive: true, force: true })
})

test('snapshot Git metadata never executes a repository-controlled fsmonitor command', () => {
  const { base, repo, dataRoot } = scaffold()
  const marker = path.join(base, 'fsmonitor-executed')
  try {
    execFileSync('git', ['-C', repo, 'init', '-q'], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t.co'], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'config', 'user.name', 't'], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'init'], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'config', 'core.fsmonitor', `!touch ${marker}`], { stdio: 'ignore' })
  } catch { fs.rmSync(base, { recursive: true, force: true }); return }
  const p = I.createProject(dataRoot, repo)
  const snapshot = I.createSnapshot(dataRoot, p.id)
  assert.ok(snapshot.git?.sha, 'hardened metadata remains available')
  assert.equal(fs.existsSync(marker), false, 'repository-controlled fsmonitor was not executed')
  fs.rmSync(base, { recursive: true, force: true })
})
