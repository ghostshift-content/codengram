'use strict'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as P from '../index.js'

test('source-file recognition incl. config/manifest variants', () => {
  assert.ok(P.isSourceFile('Gemfile') && P.isSourceFile('app.rb') && P.isSourceFile('.env.production'))
  assert.ok(P.isSourceFile('requirements-dev.txt') && P.isSourceFile('Dockerfile.prod'))
  assert.ok(!P.isSourceFile('logo.png') && !P.isSourceFile('photo.jpg'))
})

test('§1 context budget matches Anthropic docs: 200K default, 1M only on explicit opt-in', () => {
  assert.equal(P.modelContext('claude-haiku-4-5'), 200_000)
  assert.equal(P.modelContext('claude-sonnet-4-6'), 200_000, 'Sonnet-4 default is 200K (1M is beta opt-in)')
  assert.equal(P.modelContext('mystery-model'), 200_000)
  assert.equal(P.modelContext('claude-sonnet-4-6', { context1m: true }), 1_000_000)
  assert.equal(P.modelContext('claude-sonnet-4-6[1m]'), 1_000_000)
})

test('§1 usableContext rejects impossible reserves; never manufactures capacity', () => {
  assert.ok(P.usableContext(200_000) > 0 && P.usableContext(200_000) < 200_000)      // 200K − ~72K reserves
  assert.ok(P.usableContext(1_000_000) > 400_000)
  assert.throws(() => P.usableContext(200_000, { reasoning: 250_000 }), /impossible/) // reserves ≥ model → reject
  assert.throws(() => P.usableContext(0), /positive/)
})

test('profileRepo returns deterministic facts + a real file manifest', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-prof-'))
  fs.mkdirSync(path.join(d, 'app', 'controllers'), { recursive: true })
  fs.mkdirSync(path.join(d, 'config'), { recursive: true })
  fs.writeFileSync(path.join(d, 'Gemfile'), "gem 'rails'\n")
  fs.writeFileSync(path.join(d, 'config', 'routes.rb'), "Rails.application.routes.draw do\nend\n")
  fs.writeFileSync(path.join(d, 'app', 'controllers', 'users_controller.rb'), 'class UsersController; end\n')
  fs.mkdirSync(path.join(d, 'node_modules')); fs.writeFileSync(path.join(d, 'node_modules', 'big.js'), 'x'.repeat(9999))
  const p = P.profileRepo(d)
  assert.ok(p.files >= 3, 'source files counted, node_modules skipped')
  assert.ok(p.languages.includes('Ruby') && p.frameworks.includes('Rails'))
  assert.ok(p.entry_points.some(e => /routes\.rb$/.test(e)), 'routes.rb detected as an entry point')
  assert.ok(Number.isFinite(p.est_tokens) && p.usable_context > 0)
  const m = P.listSourceFiles(d)
  assert.ok(m.every(f => typeof f.path === 'string' && Number.isFinite(f.bytes)))
  fs.rmSync(d, { recursive: true, force: true })
})
