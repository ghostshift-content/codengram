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

// Test seam: a fake Claude Lead so the SEMANTIC path is exercised without the real Agent SDK. Returns a plan the
// validator can ground against the fixture's rows (broad include_paths capture every app/lib/config row into one feature).
const fakeLead = (features) => async () => ({ plan: { features }, sessionId: 'session:test-lead', model: 'claude-test' })
const railsLead = fakeLead([{ name: 'User Accounts', slug: 'user-accounts', domain: 'identity', purpose: '', include_paths: ['app/', 'lib/', 'config/'], include_terms: ['user', 'issue', 'api'] }])

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
  const res = await scanSnapshot(dataRoot, project.id, { planLead: railsLead, render: (db, out) => renderPhase1Maps(db, out, {}) })
  assert.ok(res.snapshotId.startsWith('snapshot:') && res.missionId.startsWith('mission:'))
  assert.ok(res.graph.nodes > 5 && res.graph.edges > 3 && res.graph.claims > 0)
  assert.equal(res.gate.status, 'COMPLETE')
  assert.equal(res.publication.state, 'COMPLETE')   // schema-aligned gate status, not a non-schema 'PUBLISHED'
  assert.equal(res.publication.executed_planner, 'agent-lead')       // semantic path via the (injected) Lead
  assert.equal(res.publication.semantic_coverage > 0, true)
  assert.ok(res.coverage.feature_count > 0 && res.publication.published)
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
  assert.ok(res.gate.gaps.some((x) => /semantics remain estimated/.test(x)))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('endpoints are exposed by their OWNING feature; no hardcoded-taxonomy cross-links are invented', () => {
  const inv = Object.fromEntries(['routes_endpoints','rest_api','graphql','workers_jobs','services_finders_policies','response_shaping','downloads_uploads_exports','search_aggregation','tokens_actors','processes_ipc','datastores_integrations'].map((k) => [k, []]))
  inv.rest_api.push({ file: 'lib/api/issues.rb', line: 10, entry: "GET '/issues'", detail: 'grape', method: 'GET', path: '/issues', api_class: 'API::Issues' })
  const plan = [
    { domain: 'interfaces', slug: 'rest-api', name: 'REST API Surface', rows: [{ kind: 'rest_api', row: inv.rest_api[0] }], planning_method: 'agent-lead' },
    { domain: 'planning', slug: 'issues-work-items', name: 'Issues & Work Items', rows: [], planning_method: 'agent-lead' },
  ]
  const g = openGraph()
  buildGraph(g, { project: { id: 'project:test', name: 'test' }, snapshot: { id: 'snapshot:test', file_count: 1 },
    profile: { languages: ['Ruby'] }, inventories: inv, featurePlan: plan })
  const owned = g.prepare(`SELECT 1 FROM edges WHERE src=? AND type='EXPOSES'`).get(ID.feature('interfaces', 'rest-api'))
  assert.ok(owned, 'endpoint is exposed by its owning feature')
  // The endpoint's path contains "issues", but with NO hardcoded taxonomy there is no invented cross-link to a
  // business capability the Lead did not map to it.
  const invented = g.prepare(`SELECT 1 FROM edges WHERE src=? AND type='EXPOSES'`).get(ID.feature('planning', 'issues-work-items'))
  assert.ok(!invented, 'no cross-link is fabricated from a curated taxonomy')
})

test('an endpoint whose handler references another feature\'s class is cross-linked to it (code-derived, any language)', () => {
  const inv = Object.fromEntries(['routes_endpoints','rest_api','graphql','workers_jobs','services_finders_policies','response_shaping','downloads_uploads_exports','search_aggregation','tokens_actors','processes_ipc','datastores_integrations'].map((k) => [k, []]))
  inv.services_finders_policies.push({ file: 'lib/Accounts/AccountManager.php', line: 1, entry: 'AccountManager', detail: 'service' })  // Account owns this class
  inv.rest_api.push({ file: 'apps/settings/SettingsController.php', line: 20, entry: "GET '/settings/account'", detail: 'route', method: 'GET' })  // endpoint clustered under Settings
  const plan = [
    { domain: 'core', slug: 'account', name: 'Account', rows: [{ kind: 'services_finders_policies', row: inv.services_finders_policies[0] }], planning_method: 'test' },
    { domain: 'apps', slug: 'settings', name: 'Settings', rows: [{ kind: 'rest_api', row: inv.rest_api[0] }], planning_method: 'test' },
  ]
  const readSource = (rel) => rel === 'apps/settings/SettingsController.php' ? 'class SettingsController { function account() { return new AccountManager(); } }' : ''
  const g = openGraph()
  buildGraph(g, { project: { id: 'project:corr', name: 'corr' }, snapshot: { id: 'snapshot:corr', file_count: 2 },
    profile: { languages: ['PHP'] }, inventories: inv, featurePlan: plan, readSource })
  const link = g.prepare(`SELECT json_extract(data,'$.relationship') rel FROM edges WHERE src=? AND type='EXPOSES'`).get(ID.feature('core', 'account'))
  assert.ok(link, 'Account surfaces the endpoint whose handler uses its AccountManager class')
  assert.equal(link.rel, 'capability-reference', 'the cross-link is labelled as a code reference, not a fabricated one')
  // a generated spec file that mentions the same class must NOT correlate (non-code source is skipped)
  const specRead = () => JSON.stringify({ schemas: { AccountManager: {} } })
  const g2 = openGraph()
  const inv2 = { ...inv, rest_api: [{ file: 'openapi.json', line: 1, entry: "GET '/x'", detail: 'spec', method: 'GET' }] }
  buildGraph(g2, { project: { id: 'project:spec', name: 'spec' }, snapshot: { id: 'snapshot:spec', file_count: 2 },
    profile: { languages: ['PHP'] }, inventories: inv2, featurePlan: [plan[0], { ...plan[1], rows: [{ kind: 'rest_api', row: inv2.rest_api[0] }] }], readSource: specRead })
  const noise = g2.prepare(`SELECT 1 FROM edges WHERE src=? AND type='EXPOSES'`).get(ID.feature('core', 'account'))
  assert.ok(!noise, 'a generated spec (openapi.json) referencing the class does not create a false cross-link')
})

test('FAIL-CLOSED: with no Claude Lead, a scan publishes technical architecture only — never folder clusters as features', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-unsup-'))
  fs.writeFileSync(path.join(d, 'main.go'), 'package main\nfunc main(){}\n')
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-unsup-data-'))
  const project = createProject(dataRoot, d)
  const res = await scanSnapshot(dataRoot, project.id, { agentic: false, render: (db, out) => renderPhase1Maps(db, out, {}) })
  assert.equal(res.gate.status, 'SEMANTIC_PLANNING_BLOCKED')
  assert.equal(res.publication.state, 'SEMANTIC_PLANNING_BLOCKED')
  assert.equal(res.coverage.feature_count, 0, 'NO business features are published without Claude')
  assert.equal(res.coverage.semantic_coverage, 0, 'never claims semantic coverage when blocked')
  assert.ok(res.coverage.technical_clusters > 0, 'technical clusters are preserved as architecture')
  assert.ok(res.gate.gaps.some((g) => /semantic planning blocked/i.test(g)))
  assert.equal(res.publication.executed_planner, 'blocked')
  assert.ok(res.publication.failure_reason && res.publication.fallback_reason)
  // the published graph carries ARCH_CLUSTER nodes, and ZERO FEATURE / ROLE nodes (no meaning was derived)
  const g = openGraph(latestPublished(dataRoot, project.id).indexPath)
  assert.ok(nodesByType(g, 'ARCH_CLUSTER').length > 0)
  assert.equal(nodesByType(g, 'FEATURE').length, 0)
  assert.equal(nodesByType(g, 'ROLE').length, 0)
  g.close()
  fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(dataRoot, { recursive: true, force: true })
})

test('#3 re-scanning an older snapshot makes it current again (latest = most-recently-sealed, not newest snapshot)', async () => {
  const dir = railsFixture()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-latest-'))
  const project = createProject(dataRoot, dir)
  const render = (db, out) => renderPhase1Maps(db, out, {})
  const A = await scanSnapshot(dataRoot, project.id, { planLead: railsLead, render })                   // snapshot A
  fs.writeFileSync(path.join(dir, 'config', 'extra.rb'), 'class Extra; end\n')     // change source → snapshot B
  const B = await scanSnapshot(dataRoot, project.id, { planLead: railsLead, render })
  assert.notEqual(A.snapshotId, B.snapshotId)
  assert.equal(latestPublished(dataRoot, project.id).snapshot.id, B.snapshotId)    // B is newest + latest-sealed
  fs.rmSync(path.join(dir, 'config', 'extra.rb'))                                  // revert → snapshot A again
  const A2 = await scanSnapshot(dataRoot, project.id, { planLead: railsLead, render })
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

test('roles/permissions are derived from the authorization code, never a fixed vocabulary', () => {
  const kinds = ['routes_endpoints','rest_api','graphql','workers_jobs','services_finders_policies','response_shaping','downloads_uploads_exports','search_aggregation','tokens_actors','processes_ipc','datastores_integrations']
  const inv = Object.fromEntries(kinds.map((k) => [k, []]))
  inv.tokens_actors.push({ file: 'lib/Controller/FilesController.php', line: 3, entry: '#[AdminRequired] #[PublicPage]', detail: 'auth' })
  inv.tokens_actors.push({ file: 'src/UserApi.java', line: 5, entry: '@RolesAllowed("EDITOR") hasRole(\'MODERATOR\')', detail: 'auth' })
  inv.tokens_actors.push({ file: 'app/Http/routes.php', line: 8, entry: '$user->hasRole("billing-admin")', detail: 'auth' })
  const g = openGraph()
  buildGraph(g, { project: { id: 'project:t', name: 't' }, snapshot: { id: 'snapshot:t', file_count: 3 }, profile: { languages: ['PHP','Java'] }, inventories: inv })
  const roles = nodesByType(g, 'ROLE').map((r) => r.name)
  // exactly the tokens the code names — nothing invented
  assert.ok(roles.some((r) => /AdminRequired/i.test(r)) && roles.some((r) => /PublicPage/i.test(r)), 'PHP attributes surfaced')
  assert.ok(roles.some((r) => /EDITOR/i.test(r)) && roles.some((r) => /MODERATOR/i.test(r)), 'annotation + hasRole literals surfaced')
  assert.ok(roles.some((r) => /billing/i.test(r)), 'quoted role name surfaced')
  assert.ok(!roles.some((r) => /^Owner$/i.test(r)), 'no hardcoded role appears when the code does not name it')
})
