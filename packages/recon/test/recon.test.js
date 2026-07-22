'use strict'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clusterFeatures, buildGraph, scanSnapshot, latestPublished } from '../index.js'
import { openGraph, counts, nodesByType, neighbourhood } from '../../graph/index.js'
import { renderPhase1Maps } from '../../markdown-renderer/index.js'
import { extractInventories } from '../../inventories/index.js'
import { profileRepo } from '../../profiler/index.js'
import { createProject, snapshotDir } from '../../ingestion/index.js'
import { ID } from '../../schemas/index.js'

function railsFixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-recon-'))
  const w = (rel, body) => { const f = path.join(d, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body) }
  w('Gemfile', "gem 'rails'\ngem 'sidekiq'\n")
  w('config/routes.rb', "Rails.application.routes.draw do\n  resources :users\nend\n")
  w('config/database.yml', "production:\n  adapter: postgresql\n")
  w('app/controllers/users_controller.rb', "class UsersController < ApplicationController\n  before_action :authenticate_user!\n  def index\n    render json: current_user.projects\n  end\nend\n")
  w('app/services/create_user_service.rb', "class CreateUserService\nend\n")
  w('app/policies/user_policy.rb', "class UserPolicy\nend\n")
  w('app/workers/sync_worker.rb', "class SyncWorker\n  include Sidekiq::Worker\nend\n")
  return d
}

test('clustering collapses related rows into one capability (singularized noun)', () => {
  const dir = railsFixture()
  const inv = extractInventories({ sourceRoot: dir, profile: profileRepo(dir) })
  const features = clusterFeatures(inv)
  const user = features.find((f) => f.slug === 'user')
  assert.ok(user, 'a "user" feature exists')
  // route + controller(render-json + auth) + service + policy all collapse into it
  const files = new Set(user.rows.map((r) => r.row.file))
  assert.ok(files.has('config/routes.rb') && files.has('app/controllers/users_controller.rb'))
  assert.ok(files.has('app/services/create_user_service.rb') && files.has('app/policies/user_policy.rb'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('buildGraph produces a connected, provenance-backed brain with SHARES edges', () => {
  const dir = railsFixture()
  const profile = profileRepo(dir)
  const inv = extractInventories({ sourceRoot: dir, profile })
  const g = openGraph()
  const res = buildGraph(g, { project: { id: ID.project(dir), name: 'demo' }, snapshot: { id: ID.snapshot('abc'), file_count: 7 }, profile, inventories: inv })

  assert.ok(nodesByType(g, 'PROJECT').length === 1 && nodesByType(g, 'FEATURE').length >= 1)
  assert.ok(nodesByType(g, 'AUTH_CHECK').length >= 1, 'policy + auth actor became AUTH_CHECK nodes')
  assert.ok(nodesByType(g, 'DATA_STORE').length >= 1, 'database.yml → DATA_STORE (infra, not a feature)')
  assert.equal(res.gate.status, 'COMPLETE')

  // the "user" feature neighbourhood reaches its endpoint/service/auth
  const featId = ID.feature('core', 'user')
  const nb = neighbourhood(g, featId, 1)
  assert.ok(nb.nodes.length > 1 && nb.edges.some((e) => e.type === 'AUTHORIZED_BY' || e.type === 'USES_SERVICE'))
  assert.ok(counts(g).claims > 0, 'every mapped row left a provenance claim')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('scanSnapshot runs the full pipeline and atomically publishes with a mission id', async () => {
  const dir = railsFixture()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-data-'))
  const project = createProject(dataRoot, dir)
  const res = await scanSnapshot(dataRoot, project.id, { agentic: false, render: (db, out) => renderPhase1Maps(db, out, {}) })
  assert.ok(res.snapshotId.startsWith('snapshot:') && res.missionId.startsWith('mission:'))
  assert.ok(res.graph.nodes > 5 && res.graph.edges > 3 && res.graph.claims > 0)
  assert.equal(res.gate.status, 'COMPLETE')
  assert.equal(res.publication.state, 'COMPLETE')   // schema-aligned gate status, not a non-schema 'PUBLISHED'
  assert.ok(res.publication.published)
  const pub = latestPublished(dataRoot, project.id)
  assert.equal(pub.publication.mission_id, res.missionId)
  // the sealed snapshot's CURRENT points at publications/<pubId>/{index.sqlite, phase1-maps}; no leftover .attempt
  const sd = snapshotDir(dataRoot, project.id, res.snapshotId)
  assert.ok(fs.existsSync(path.join(sd, 'CURRENT')) && fs.existsSync(pub.indexPath))
  assert.ok(fs.existsSync(path.join(sd, 'publications', res.pubId, 'phase1-maps', 'README.md')))
  const mission = JSON.parse(fs.readFileSync(path.join(sd, 'publications', res.pubId, 'mission.json'), 'utf8'))
  assert.ok(mission.workstreams.length > 0 && mission.workstreams.every((w) => w.status === 'COMPLETED'))
  assert.ok(!fs.readdirSync(sd).some((n) => n.startsWith('.attempt')), 'attempt dir cleaned up')
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dataRoot, { recursive: true, force: true })
})

test('a semantic catch-all is covered but remains an explicit completion gap', () => {
  const dir = railsFixture()
  const profile = profileRepo(dir)
  const inv = extractInventories({ sourceRoot: dir, profile })
  const featureKinds = ['routes_endpoints', 'graphql', 'workers_jobs', 'services_finders_policies', 'response_shaping', 'search_aggregation', 'tokens_actors']
  const rows = featureKinds.flatMap((kind) => (inv[kind] || []).map((row) => ({ kind, row })))
  const g = openGraph()
  const res = buildGraph(g, { project: { id: ID.project(dir), name: 'demo' }, snapshot: { id: ID.snapshot('catchall'), file_count: profile.files }, profile,
    inventories: inv, featurePlan: [{ domain: 'platform', slug: 'supporting-capabilities', name: 'Supporting Capabilities', rows, planning_method: 'coverage-catchall' }] })
  assert.equal(res.gate.status, 'COMPLETE_WITH_GAPS')
  assert.ok(res.gate.gaps.some((x) => /semantic consolidation/.test(x)))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a technical REST surface also links endpoints to their business capability', () => {
  const inv = Object.fromEntries(['routes_endpoints','rest_api','graphql','workers_jobs','services_finders_policies','response_shaping','downloads_uploads_exports','search_aggregation','tokens_actors','processes_ipc','datastores_integrations'].map((k) => [k, []]))
  inv.rest_api.push({ file: 'lib/api/issues.rb', line: 10, entry: "GET '/issues'", detail: 'grape', method: 'GET', path: '/issues', api_class: 'API::Issues' })
  const plan = [
    { domain: 'interfaces', slug: 'rest-api', name: 'REST API Surface', rows: [{ kind: 'rest_api', row: inv.rest_api[0] }], planning_method: 'agent-lead' },
    { domain: 'planning', slug: 'issues-work-items', name: 'Issues & Work Items', rows: [], planning_method: 'agent-lead' },
  ]
  const g = openGraph()
  buildGraph(g, { project: { id: 'project:test', name: 'test' }, snapshot: { id: 'snapshot:test', file_count: 1 },
    profile: { languages: ['Ruby'] }, inventories: inv, featurePlan: plan })
  const linked = g.prepare(`SELECT 1 FROM edges WHERE src=? AND type='EXPOSES'`).get(ID.feature('planning', 'issues-work-items'))
  assert.ok(linked, 'business feature receives a secondary EXPOSES edge to its REST endpoint')
})

test('#2 an unsupported stack maps its source but reports generic semantics as a gap', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-unsup-'))
  fs.writeFileSync(path.join(d, 'main.go'), 'package main\nfunc main(){}\n')
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-unsup-data-'))
  const project = createProject(dataRoot, d)
  const res = await scanSnapshot(dataRoot, project.id, { agentic: false, render: (db, out) => renderPhase1Maps(db, out, {}) })
  assert.ok(res.coverage.feature_count > 0)
  assert.equal(res.gate.status, 'COMPLETE_WITH_GAPS')
  assert.ok(res.gate.gaps.some((g) => /generic structural extraction/.test(g)))
  assert.equal(res.coverage.extraction.unrepresented_source_files, 0)
  fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(dataRoot, { recursive: true, force: true })
})

test('#3 re-scanning an older snapshot makes it current again (latest = most-recently-sealed, not newest snapshot)', async () => {
  const dir = railsFixture()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-latest-'))
  const project = createProject(dataRoot, dir)
  const render = (db, out) => renderPhase1Maps(db, out, {})
  const A = await scanSnapshot(dataRoot, project.id, { agentic: false, render })                        // snapshot A
  fs.writeFileSync(path.join(dir, 'config', 'extra.rb'), 'class Extra; end\n')     // change source → snapshot B
  const B = await scanSnapshot(dataRoot, project.id, { agentic: false, render })
  assert.notEqual(A.snapshotId, B.snapshotId)
  assert.equal(latestPublished(dataRoot, project.id).snapshot.id, B.snapshotId)    // B is newest + latest-sealed
  fs.rmSync(path.join(dir, 'config', 'extra.rb'))                                  // revert → snapshot A again
  const A2 = await scanSnapshot(dataRoot, project.id, { agentic: false, render })
  assert.equal(A2.snapshotId, A.snapshotId, 'content-addressed: reverted source ⇒ same id as A')
  assert.equal(latestPublished(dataRoot, project.id).snapshot.id, A.snapshotId, 're-sealed A is now latest, not B')
  assert.equal(A2.publication.planner, 'sealed-plan-reuse', 'unchanged inventory reuses the sealed plan instead of drifting')
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dataRoot, { recursive: true, force: true })
})

test('reusing a mission id produces a fresh publication target instead of replacing it in place', async () => {
  const dir = railsFixture(), dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pub-collision-'))
  const project = createProject(dataRoot, dir), missionId = 'mission:fixed-test-id'
  const render = (db, out) => renderPhase1Maps(db, out, {})
  const first = await scanSnapshot(dataRoot, project.id, { agentic: false, missionId, render })
  const second = await scanSnapshot(dataRoot, project.id, { agentic: false, missionId, render })
  assert.notEqual(first.pubId, second.pubId)
  assert.equal(latestPublished(dataRoot, project.id).publication.mission_id, missionId)
  assert.ok(fs.existsSync(latestPublished(dataRoot, project.id).indexPath))
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dataRoot, { recursive: true, force: true })
})

test('#1 publication without a renderer is refused (no graph-only publish)', async () => {
  const dir = railsFixture()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-norender-'))
  const project = createProject(dataRoot, dir)
  await assert.rejects(() => scanSnapshot(dataRoot, project.id, { agentic: false }), /requires a render function/)
  assert.equal(latestPublished(dataRoot, project.id), null, 'nothing published without a renderer')
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dataRoot, { recursive: true, force: true })
})

test('#3 a render/integrity failure aborts the publish — the previous brain is untouched', async () => {
  const dir = railsFixture()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-atomic-'))
  const project = createProject(dataRoot, dir)
  const good = await scanSnapshot(dataRoot, project.id, { agentic: false, render: (db, out) => renderPhase1Maps(db, out, {}) })   // publish v1
  assert.equal(latestPublished(dataRoot, project.id).publication.mission_id, good.missionId)
  // now a scan whose renderer reports a failed integrity check must NOT replace the published snapshot
  await assert.rejects(() => scanSnapshot(dataRoot, project.id, { agentic: false, render: () => ({ crosscheck: { ok: false, graph: 9, markdown: 1 } }) }), /NOT published/)
  assert.equal(latestPublished(dataRoot, project.id).publication.mission_id, good.missionId, 'still the good v1')
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dataRoot, { recursive: true, force: true })
})
