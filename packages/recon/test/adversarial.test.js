'use strict'
// S9 — universality + anti-name-mapping proof. A directory named `admin`, `issues`, `payments` or `roles` must NEVER
// become a business feature or a role from its NAME alone. And the SAME fail-closed behaviour must hold for every
// stack (no GitLab/framework special-casing). No live Claude here: offline ⇒ SEMANTIC_PLANNING_BLOCKED everywhere.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanSnapshot, latestPublished } from '../index.js'
import { openGraph, nodesByType } from '../../graph/index.js'
import { createProject } from '../../ingestion/index.js'
import { renderPhase1Maps } from '../../markdown-renderer/index.js'

function makeRepo(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-adv-'))
  for (const [rel, body] of Object.entries(files)) { const f = path.join(d, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body) }
  return d
}
async function scanBlocked(dir) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-adv-data-'))
  const project = createProject(dataRoot, dir)
  const res = await scanSnapshot(dataRoot, project.id, { agentic: false, render: (db, out, opts) => renderPhase1Maps(db, out, opts) })
  const g = openGraph(latestPublished(dataRoot, project.id).indexPath)
  const cleanup = () => { g.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dataRoot, { recursive: true, force: true }) }
  return { res, g, cleanup }
}

test('adversarial directory names never become features or roles by name alone (fail-closed, no Claude)', async () => {
  // Directories named exactly like tempting capabilities/roles — but with NO real routes, policies or role definitions.
  const dir = makeRepo({
    'admin/notes.txt': 'just some notes, not code',
    'issues/helper.rb': 'module Issues\n  def util; end\nend\n',
    'payments/readme.md': '# payments folder',
    'roles/config.rb': 'module Roles\n  LIST = []\nend\n',
    'app/util.rb': 'class Util; end\n',
  })
  const { res, g, cleanup } = await scanBlocked(dir)
  assert.equal(res.gate.status, 'SEMANTIC_PLANNING_BLOCKED')
  assert.equal(res.coverage.feature_count, 0, 'no directory becomes a business feature')
  // NOT ONE feature or role is invented from the folder names
  assert.equal(nodesByType(g, 'FEATURE').length, 0)
  const roleNames = nodesByType(g, 'ROLE').map((r) => r.name.toLowerCase())
  for (const name of ['admin', 'owner', 'payments', 'roles', 'issues']) assert.ok(!roleNames.includes(name), `no role named "${name}" fabricated from a directory/string`)
  // the folders survive only as clearly-labelled technical clusters (architecture), never as MAPPED capabilities
  assert.ok(nodesByType(g, 'ARCH_CLUSTER').length > 0)
  cleanup()
})

// One universal rule for every stack: offline ⇒ blocked (facts preserved, no features/roles), no crash, no special-casing.
const STACKS = {
  'express (Node)': { 'package.json': '{"name":"api","dependencies":{"express":"^4"}}', 'src/routes/users.js': "const r=require('express').Router()\nr.get('/users', (req,res)=>res.json([]))\nmodule.exports=r\n" },
  'django (Python)': { 'manage.py': 'import django\n', 'app/urls.py': "from django.urls import path\nurlpatterns=[path('users/', views.users)]\n", 'app/views.py': 'def users(request): return None\n' },
  'go services': { 'go.mod': 'module acme\n', 'cmd/api/main.go': 'package main\nfunc main(){}\n', 'internal/user/handler.go': 'package user\nfunc List(){}\n' },
  'php (Laravel-ish)': { 'composer.json': '{"require":{"laravel/framework":"^10"}}', 'routes/api.php': "<?php\nRoute::get('/users', 'UserController@index');\n", 'app/Http/Controllers/UserController.php': '<?php\nclass UserController {}\n' },
  'unknown language': { 'main.zig': 'pub fn main() void {}\n', 'lib/thing.zig': 'pub fn thing() void {}\n' },
}
for (const [name, files] of Object.entries(STACKS)) {
  test(`fail-closed is universal — ${name}: offline scan blocks cleanly, preserves facts, invents no features/roles`, async () => {
    const { res, g, cleanup } = await scanBlocked(makeRepo(files))
    assert.equal(res.gate.status, 'SEMANTIC_PLANNING_BLOCKED', `${name} must fail closed`)
    assert.equal(nodesByType(g, 'FEATURE').length, 0, `${name}: no business features without Claude`)
    assert.equal(nodesByType(g, 'ROLE').length, 0, `${name}: no roles without Claude`)
    assert.equal(res.coverage.semantic_coverage, 0)
    assert.ok(res.coverage.technical_clusters > 0, `${name}: technical facts preserved as architecture`)
    assert.ok(res.publication.state === 'SEMANTIC_PLANNING_BLOCKED')
    cleanup()
  })
}
