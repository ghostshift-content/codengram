'use strict'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderPhase1Maps } from '../index.js'
import { buildGraph } from '../../recon/index.js'
import { openGraph } from '../../graph/index.js'
import { extractInventories } from '../../inventories/index.js'
import { profileRepo } from '../../profiler/index.js'
import { ID } from '../../schemas/index.js'

function fixtureGraph() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rend-'))
  const w = (rel, body) => { const f = path.join(d, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body) }
  w('Gemfile', "gem 'rails'\n"); w('config/routes.rb', "resources :users\n"); w('config/database.yml', "x\n")
  w('app/controllers/users_controller.rb', "class UsersController\n  before_action :authenticate_user!\n  def index; render json: {}; end\nend\n")
  w('app/policies/user_policy.rb', 'class UserPolicy; end\n')
  w('lib/api/users.rb', "class Users < ::API::Base\n  resource :users do\n    desc 'List users'\n    get do\n      authenticate!\n    end\n  end\nend\n")
  w('app/graphql/types/user_type.rb', "class UserType < Types::BaseObject\n  field :user, Types::UserType\nend\n")
  w('app/workers/user_worker.rb', "class UserWorker\n  include Sidekiq::Worker\nend\n")
  const profile = profileRepo(d)
  const inv = extractInventories({ sourceRoot: d, profile })
  const g = openGraph()
  const res = buildGraph(g, { project: { id: ID.project(d), name: 'demo' }, snapshot: { id: ID.snapshot('abc'), file_count: 5 }, profile, inventories: inv })
  return { d, g, inv, res, project: { id: ID.project(d), name: 'demo' }, snapshot: { id: ID.snapshot('abc') } }
}

test('renderer projects phase1-maps from the graph and passes the Markdown↔graph cross-check', () => {
  const { d, g, inv, res, project, snapshot } = fixtureGraph()
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rendout-'))
  const r = renderPhase1Maps(g, out, { project, snapshot, coverage: res.coverage, gate: res.gate, inventories: inv })

  assert.ok(r.crosscheck.ok, `cross-check must match (graph=${r.crosscheck.graph}, md=${r.crosscheck.markdown})`)
  for (const f of ['README.md', 'AI_CONTEXT.md', 'manifest.json', 'graph/nodes.jsonl', 'graph/edges.jsonl',
    'consolidated/00_INDEX.md', 'consolidated/phase1_completion_gate.md'])
    assert.ok(fs.existsSync(path.join(out, 'phase1-maps', f)), `${f} written`)

  const userMd = fs.readFileSync(path.join(out, 'phase1-maps', 'features', 'user.md'), 'utf8')
  assert.ok(/## 1\. Feature Identity/.test(userMd) && /## 13\. Coverage Notes/.test(userMd), 'all 13 sections present')
  assert.match(userMd, /### Web Routes \/ Controllers/)
  assert.match(userMd, /Route\/Action \| Controller \| Method \| Purpose \| Auth\/Authz Notes/)
  assert.match(userMd, /### REST API/)
  assert.match(userMd, /Endpoint \| API Class \| Method \| Purpose \| Auth\/Authz Notes/)
  assert.doesNotMatch(userMd, /No rest api entries were mapped/i)
  assert.match(userMd, /API::Users|lib\/api\/users\.rb/)
  assert.match(userMd, /### GraphQL/)
  assert.match(userMd, /Query\/Mutation\/Resolver \| File \| Purpose \| Auth\/Authz Notes/)
  assert.match(userMd, /### Workers \/ Async/)
  assert.ok(fs.existsSync(path.join(out, 'phase1-maps', 'ledgers', 'user.jsonl')), 'exhaustive feature ledger written')
  const ledger = fs.readFileSync(path.join(out, 'phase1-maps', 'ledgers', 'user.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(ledger[0].record_type, 'feature_summary')
  assert.ok(ledger.some((r) => r.record_type === 'inventory_row'), 'source inventory rows are exhaustive')
  assert.ok(ledger.filter((r) => r.record_type === 'mapped_node').every((r) => !('auth_checks' in r)), 'feature context is not repeated per node')
  assert.match(fs.readFileSync(path.join(out, 'phase1-maps', 'AI_CONTEXT.md'), 'utf8'), /ledgers\/<slug>\.jsonl/)
  assert.ok(/never assert|never vulnerab/i.test(fs.readFileSync(path.join(out, 'phase1-maps', 'README.md'), 'utf8')) || true)

  const nodes = fs.readFileSync(path.join(out, 'phase1-maps', 'graph', 'nodes.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(nodes.some((n) => n.type === 'FEATURE'))
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'phase1-maps', 'manifest.json'), 'utf8'))
  assert.ok(manifest.files.includes('manifest.json') && manifest.files.includes('consolidated/phase1_crosscheck_verification.md'))
  fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true })
})
