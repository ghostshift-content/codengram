'use strict'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getContextBundle, answer } from '../index.js'
import { featureBundle, dashboardView, missionProgress } from '../../../apps/server/index.js'
import { buildGraph } from '../../recon/index.js'
import { openGraph, upsertNode, upsertEdge } from '../../graph/index.js'
import { extractInventories } from '../../inventories/index.js'
import { profileRepo } from '../../profiler/index.js'
import { ID } from '../../schemas/index.js'

function graph() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ret-'))
  const w = (rel, body) => { const f = path.join(d, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body) }
  w('Gemfile', "gem 'rails'\n"); w('config/routes.rb', "resources :users\n")
  w('app/controllers/users_controller.rb', "class UsersController\n  before_action :authenticate_user!\nend\n")
  w('app/policies/user_policy.rb', 'class UserPolicy; end\n')
  const profile = profileRepo(d), inv = extractInventories({ sourceRoot: d, profile })
  const g = openGraph(); buildGraph(g, { project: { id: ID.project(d), name: 'demo' }, snapshot: { id: ID.snapshot('abc'), file_count: 4 }, profile, inventories: inv })
  return { d, g }
}

test('context bundle is bounded, fact-listed, and citation-backed', () => {
  const { d, g } = graph()
  const b = getContextBundle(g, ID.feature('core', 'user'), { hops: 1 })
  assert.ok(b.ok && b.node.type === 'FEATURE')
  assert.ok(b.facts.some((f) => /AUTHORIZED_BY|USES_SERVICE|EXPOSES|AUTHENTICATED_BY/.test(f)))
  assert.ok(b.citations.length > 0 && b.citations.every((c) => c.file && c.line))
  fs.rmSync(d, { recursive: true, force: true })
})

test('a missing node returns a coverage gap, never a guess', () => {
  const { d, g } = graph()
  assert.equal(getContextBundle(g, ID.feature('nope', 'nope')).ok, false)
  fs.rmSync(d, { recursive: true, force: true })
})

test('deterministic answer finds the right feature and cites source', () => {
  const { d, g } = graph()
  const a = answer(g, 'how does user authentication work?')
  assert.ok(a.ok && /user/i.test(a.text) && a.citations.length > 0)
  const miss = answer(g, 'quantum blockchain kubernetes mesh')
  assert.equal(miss.ok, false)
  fs.rmSync(d, { recursive: true, force: true })
})

test('feature display bundle samples node families independently', () => {
  const g = openGraph()
  const feature = { type: 'FEATURE', id: ID.feature('core', 'large'), name: 'Large', data: { slug: 'large' } }
  upsertNode(g, feature)
  for (let i = 0; i < 30; i++) {
    const id = `route:${i}`
    upsertNode(g, { type: 'ROUTE', id, name: `route ${i}`, data: { file: 'routes.rb', line: i + 1 } })
    upsertEdge(g, { type: 'EXPOSES', from: feature.id, to: id })
  }
  for (let i = 0; i < 3; i++) {
    const id = `authcheck:${i}`
    upsertNode(g, { type: 'AUTH_CHECK', id, name: `auth ${i}`, data: { file: 'policy.rb', line: i + 1 } })
    upsertEdge(g, { type: 'AUTHORIZED_BY', from: feature.id, to: id })
  }
  const b = featureBundle(g, feature, { perType: 10 })
  assert.equal(b.projection.totals.ROUTE, 30)
  assert.equal(b.projection.returned.ROUTE, 10)
  assert.equal(b.projection.returned.AUTH_CHECK, 3, 'auth is not crowded out by routes')
  assert.equal(b.projection.truncated, true)
})

test('dashboard projection is bounded and source-grounded', () => {
  const { d, g } = graph()
  const out = dashboardView(g, { limit: 100 })
  assert.ok(out.features.length > 0)
  assert.ok(out.interfaces.every((x) => x.handler || x.operation))
  assert.deepEqual(out.coverage.rows.map((x) => x.id).sort(), out.features.map((x) => x.id).sort())
  assert.ok(Array.isArray(out.identity.matrix) && Array.isArray(out.data_flows.boundaries))
  fs.rmSync(d, { recursive: true, force: true })
})

test('recon progress advances by phase and then by mapped feature count', () => {
  const state = { phase: 'start' }
  assert.equal(missionProgress(state, { phase: 'freeze' }), 5)
  assert.equal(missionProgress(state, { phase: 'planning' }), 40)
  assert.equal(missionProgress(state, { kind: 'features_planned', count: 4 }), 40)
  state.phase = 'graph'
  assert.equal(missionProgress(state, { kind: 'feature_mapped' }), 58)
  assert.equal(missionProgress(state, { kind: 'feature_mapped' }), 65)
  assert.equal(missionProgress(state, { phase: 'render' }), 85)
  assert.equal(missionProgress(state, { phase: 'ready' }), 100)
})
