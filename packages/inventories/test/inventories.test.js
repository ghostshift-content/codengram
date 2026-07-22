'use strict'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { profileRepo } from '../../profiler/index.js'
import { extractInventories, writeInventories, builtinRegistry } from '../index.js'
import { INVENTORY_KEYS } from '../../plugins/index.js'

// A small Rails-shaped fixture — enough to exercise each extractor.
function railsFixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-inv-'))
  const w = (rel, body) => { const f = path.join(d, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body) }
  w('Gemfile', "gem 'rails'\ngem 'sidekiq'\n")
  w('config/routes.rb', "Rails.application.routes.draw do\n  resources :users\n  get '/health', to: 'health#show'\n  namespace :api do\n    resources :tokens\n    post 'sessions/refresh'\n  end\nend\n")
  w('config/database.yml', "production:\n  adapter: postgresql\n")
  w('app/controllers/users_controller.rb', "class UsersController < ApplicationController\n  before_action :authenticate_user!\n  def index\n    render json: current_user.projects\n  end\nend\n")
  w('app/services/create_user_service.rb', "class CreateUserService\nend\n")
  w('app/policies/user_policy.rb', "class UserPolicy\nend\n")
  w('app/workers/sync_worker.rb', "class SyncWorker\n  include Sidekiq::Worker\n  def perform(id); end\nend\n")
  w('app/graphql/types/user_type.rb', "module Types\n  class UserType < Types::BaseObject\n    field :id, ID, null: false\n  end\nend\n")
  w('lib/api/pings.rb', "class Pings < Grape::API\n  get '/ping' do\n    'pong'\n  end\nend\n")
  w('lib/api/issues.rb', "class Issues < ::API::Base\n  resource :issues do\n    desc 'List issues'\n    route_setting :authorization, permissions: :read_issue\n    get do\n      authenticate!\n    end\n    post ':id/close' do\n      authorize! :update_issue, issue\n    end\n    [':id/notes', ':id/comments'].each do |path|\n      get path do\n        authorize! :read_issue, issue\n      end\n    end\n    get computed_path do\n      authenticate!\n    end\n  end\nend\n")
  return d
}

test('Rails plugin extracts the expected items into the right inventories', () => {
  const dir = railsFixture()
  const profile = profileRepo(dir)
  assert.ok(profile.frameworks.includes('Rails'))
  const inv = extractInventories({ sourceRoot: dir, profile })

  assert.ok(inv.routes_endpoints.some((r) => /resources :users/.test(r.entry)))
  assert.ok(inv.routes_endpoints.some((r) => /health/.test(r.entry)))
  assert.ok(inv.rest_api.some((r) => /ping/.test(r.entry)), 'Grape endpoint captured')
  assert.ok(inv.rest_api.some((r) => r.path === '/api/tokens' && r.detail === 'rails-api-route'), 'Rails API namespace resource captured')
  assert.ok(inv.rest_api.some((r) => r.path === '/api/sessions/refresh' && r.method === 'POST'), 'Rails API namespace verb captured')
  const gitlabApi = inv.rest_api.find((r) => r.path === '/issues' && r.method === 'GET')
  assert.ok(gitlabApi, 'GitLab ::API::Base pathless endpoint captured from its resource scope')
  assert.equal(gitlabApi.api_class, 'API::Issues')
  assert.match(gitlabApi.purpose, /List issues/)
  assert.match(gitlabApi.auth_notes, /authorization|authenticate/)
  assert.ok(inv.rest_api.some((r) => r.path === '/issues/:id/close' && r.method === 'POST'))
  assert.ok(inv.rest_api.some((r) => r.path === '/issues/:id/notes') && inv.rest_api.some((r) => r.path === '/issues/:id/comments'), 'literal dynamic route list expanded')
  assert.ok(!inv.rest_api.some((r) => /computed_path/.test(r.entry)), 'unresolved dynamic route is not collapsed to its parent')
  assert.ok(inv.graphql.some((r) => /field :id/.test(r.entry)), 'GraphQL field captured')
  assert.ok(inv.workers_jobs.some((r) => r.detail === 'worker'), 'Sidekiq worker captured')
  const sfp = inv.services_finders_policies
  assert.ok(sfp.some((r) => r.detail === 'service') && sfp.some((r) => r.detail === 'policy'))
  assert.ok(inv.response_shaping.some((r) => r.detail === 'render'))
  assert.ok(inv.tokens_actors.some((r) => /current_user|authenticate/.test(r.entry)))
  assert.ok(inv.datastores_integrations.some((r) => r.entry === 'database.yml'))

  // every row is a real file:line with a provenance-ready location
  for (const key of INVENTORY_KEYS) for (const r of inv[key]) {
    assert.ok(typeof r.file === 'string' && r.file && Number.isInteger(r.line) && r.line >= 1, `${key} row has file:line`)
    assert.equal(r.plugin, 'rails')
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

test('all 11 inventories are always produced and written to disk with a manifest', () => {
  const dir = railsFixture()
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-invout-'))
  const inv = extractInventories({ sourceRoot: dir, profile: profileRepo(dir) })
  assert.deepEqual(Object.keys(inv).sort(), [...INVENTORY_KEYS].sort())
  const counts = writeInventories(out, inv)
  for (let i = 0; i < INVENTORY_KEYS.length; i++) {
    const nn = String(i + 1).padStart(2, '0')
    assert.ok(fs.existsSync(path.join(out, 'inventories', `${nn}_${INVENTORY_KEYS[i]}.txt`)), `${nn} file written`)
  }
  assert.ok(fs.existsSync(path.join(out, 'inventories', '00_MANIFEST.md')))
  assert.equal(counts.routes_endpoints, inv.routes_endpoints.length)
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true })
})

test('a non-matching repo yields 11 empty inventories, never a crash', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-inv-empty-'))
  fs.writeFileSync(path.join(d, 'main.go'), 'package main\nfunc main() {}\n')
  const inv = extractInventories({ sourceRoot: d, profile: profileRepo(d), registry: builtinRegistry() })
  assert.equal(Object.keys(inv).length, 11)
  assert.ok(INVENTORY_KEYS.every((k) => Array.isArray(inv[k]) && inv[k].length === 0), 'no Rails plugin match → all empty')
  fs.rmSync(d, { recursive: true, force: true })
})
