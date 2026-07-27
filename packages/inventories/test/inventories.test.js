'use strict'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { profileRepo } from '../../profiler/index.js'
import { extractInventories, writeInventories, builtinRegistry, inventoryMeta } from '../index.js'
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

test('an unfamiliar single-file repo is still represented, never silently empty', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-inv-empty-'))
  fs.writeFileSync(path.join(d, 'main.go'), 'package main\nfunc main() {}\n')
  const inv = extractInventories({ sourceRoot: d, profile: profileRepo(d), registry: builtinRegistry() })
  assert.equal(Object.keys(inv).length, 11)
  assert.ok(INVENTORY_KEYS.every((k) => Array.isArray(inv[k])), 'all canonical inventories exist')
  assert.ok(inv.services_finders_policies.some((r) => r.file === 'main.go' && r.detail === 'source-module'), 'unknown source remains mapped')
  fs.rmSync(d, { recursive: true, force: true })
})

// ── universal polyglot fallback: any language should map ─────────────────────────────────────
function write(dir, rel, body) { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body) }
const featureRows = (inv) => ['routes_endpoints','rest_api','graphql','workers_jobs','services_finders_policies','response_shaping','tokens_actors'].reduce((s,k)=>s+(inv[k]||[]).length,0)

test('universal fallback maps a PHP (Nextcloud/Laravel-style) repo', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-php-'))
  write(d, 'composer.json', '{"name":"acme/app"}')
  write(d, 'apps/files/lib/Controller/ApiController.php', "<?php\nclass ApiController {\n  #[ApiRoute(verb: 'GET', url: '/files')]\n  public function index() {}\n}\n")
  write(d, 'apps/files/lib/Service/FileService.php', '<?php\nclass FileService {}\n')
  write(d, 'apps/dav/lib/Controller/CalendarController.php', "<?php\nRoute::get('/dav/calendars', 'x');\n")
  write(d, 'lib/private/Authentication/LoginController.php', '<?php\nclass LoginController { function login(){ authenticate_user(); } }\n')
  const inv = extractInventories({ sourceRoot: d, profile: profileRepo(d) })
  assert.ok(featureRows(inv) > 0, 'PHP repo produces feature-bearing rows')
  assert.ok(inv.routes_endpoints.some(r => r.plugin === 'universal'), 'via the universal fallback')
  assert.ok(inv.services_finders_policies.some(r => r.detail === 'service'))
  fs.rmSync(d, { recursive: true, force: true })
})

test('universal fallback parses real Nextcloud route arrays and OpenAPI operations', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nextcloud-'))
  write(d, 'composer.json', '{"name":"nextcloud/server"}')
  write(d, 'apps/files/appinfo/routes.php', `<?php
return ['routes' => [
  ['name' => 'page#index', 'url' => '/files', 'verb' => 'GET'],
], 'ocs' => [
  ['name' => 'api#share', 'url' => '/api/v1/shares', 'verb' => 'POST'],
]];
`)
  write(d, 'apps/files/openapi.json', JSON.stringify({ openapi: '3.0.0', info: { title: 'Files API' }, paths: {
    '/files/{id}': { get: { operationId: 'getFile', summary: 'Get file', security: [{ bearer: [] }] } },
  } }, null, 2))
  write(d, 'apps/files/lib/Controller/ApiController.php', '<?php class ApiController {}')
  const inv = extractInventories({ sourceRoot: d, profile: profileRepo(d) })
  assert.ok(inv.routes_endpoints.some((r) => r.path === '/index.php/apps/files/files' && r.method === 'GET'), 'web route parsed with app prefix')
  assert.ok(inv.rest_api.some((r) => r.path === '/ocs/v2.php/apps/files/api/v1/shares' && r.method === 'POST'), 'OCS route parsed as REST with app prefix')
  assert.ok(inv.rest_api.some((r) => r.path === '/files/{id}' && r.handler === 'getFile'), 'OpenAPI operation parsed')
  fs.rmSync(d, { recursive: true, force: true })
})

test('universal fallback maps a JS/TS (Express/Nest) repo', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-js-'))
  write(d, 'package.json', '{"name":"x"}')
  write(d, 'src/routes/users.js', "const router = require('express').Router()\nrouter.get('/users', (req,res)=>res.json({}))\nmodule.exports = router\n")
  write(d, 'src/services/userService.ts', 'export class UserService {}\n')
  write(d, 'src/jobs/emailWorker.ts', 'export class EmailWorker {}\n')
  const inv = extractInventories({ sourceRoot: d, profile: profileRepo(d) })
  assert.ok(inv.routes_endpoints.length > 0 && inv.services_finders_policies.length > 0 && inv.workers_jobs.length > 0)
  fs.rmSync(d, { recursive: true, force: true })
})

test('universal fallback maps a Python (FastAPI/Django) and a Go repo', () => {
  const py = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-'))
  write(py, 'requirements.txt', 'fastapi\n')
  write(py, 'app/api/routes.py', "from fastapi import APIRouter\nrouter = APIRouter()\n@router.get('/items')\ndef items(): ...\n")
  write(py, 'app/services/item_service.py', 'class ItemService: ...\n')
  const pin = extractInventories({ sourceRoot: py, profile: profileRepo(py) })
  assert.ok(featureRows(pin) > 0, 'Python maps')
  fs.rmSync(py, { recursive: true, force: true })

  const go = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-'))
  write(go, 'go.mod', 'module x\n')
  write(go, 'internal/handlers/user.go', 'package handlers\nfunc Register(r *mux.Router){ r.HandleFunc("/users", h) }\n')
  write(go, 'internal/services/user_service.go', 'package services\ntype UserService struct{}\n')
  const gin = extractInventories({ sourceRoot: go, profile: profileRepo(go) })
  assert.ok(featureRows(gin) > 0, 'Go maps')
  fs.rmSync(go, { recursive: true, force: true })
})

test('Django DRF plugin maps APIViews, SimpleJWT, viewsets, and authorization declarations', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-drf-'))
  write(d, 'requirements.txt', 'Django==5.1\ndjangorestframework==3.15\ndjangorestframework-simplejwt==5.3\n')
  write(d, 'app/views.py', `from rest_framework.views import APIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.authentication import BasicAuthentication
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

class UserView(APIView):
    permission_classes = []
    authentication_classes = []

    def post(self, request):
        return Response({})

class QuotesView(APIView):
    permission_classes = [IsAuthenticated]
    authentication_classes = [BasicAuthentication]

    def get(self, request):
        return Response([])

@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def api_logout(request):
    return Response({})

def custom_logout_view(request):
    return Response({})
`)
  write(d, 'app/viewsets.py', `from rest_framework.viewsets import ModelViewSet
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated

class QuoteViewSet(ModelViewSet):
    permission_classes = [IsAuthenticated]

    @action(detail=True, methods=['post'])
    def publish_now(self, request, pk=None):
        pass
`)
  write(d, 'app/urls.py', `from django.urls import path
from rest_framework_simplejwt.views import TokenObtainPairView as LoginTokenView, TokenRefreshView
from .views import UserView, QuotesView, api_logout, custom_logout_view

urlpatterns = [
    path('users/', UserView.as_view(), name='users'),
    path(
        'quotes/',
        QuotesView.as_view(),
        name='quotes',
    ),
    path('api/token/', LoginTokenView.as_view(), name='token'),
    path('api/token/refresh/', TokenRefreshView.as_view(), name='token_refresh'),
    path('api/logout/', api_logout, name='api_logout'),
    path('logout/', custom_logout_view, name='logout'),
    path('', QuotesView.as_view(), name='root_quotes'),
]
`)
  write(d, 'app/router.py', `from rest_framework.routers import DefaultRouter
from .viewsets import QuoteViewSet
router = DefaultRouter()
router.register('quote-items', QuoteViewSet, basename='quote')
`)

  const profile = profileRepo(d)
  assert.ok(profile.frameworks.includes('Django'))
  const inv = extractInventories({ sourceRoot: d, profile })
  assert.ok(inv.rest_api.some(r => r.method === 'POST' && r.path === '/users/' && r.handler === 'UserView'))
  const quotes = inv.rest_api.find(r => r.method === 'GET' && r.path === '/quotes/')
  assert.ok(quotes)
  assert.match(quotes.auth_notes, /IsAuthenticated/)
  assert.match(quotes.auth_notes, /BasicAuthentication/)
  assert.ok(inv.rest_api.some(r => r.method === 'POST' && r.path === '/api/token/' && r.api_class === 'TokenObtainPairView'))
  assert.ok(inv.rest_api.some(r => r.method === 'POST' && r.path === '/api/token/refresh/' && r.api_class === 'TokenRefreshView'))
  assert.ok(inv.rest_api.some(r => r.method === 'DELETE' && r.path === '/api/logout/' && r.handler === 'api_logout'))
  assert.ok(inv.rest_api.some(r => r.method === 'GET' && r.path === '/' && r.handler === 'QuotesView'), 'empty Django root path is retained')
  assert.ok(!inv.rest_api.some(r => r.path === '/logout/'), 'plain Django function view is not misclassified as REST')

  assert.ok(inv.rest_api.some(r => r.method === 'GET' && r.path === '/quote-items/'))
  assert.ok(inv.rest_api.some(r => r.method === 'POST' && r.path === '/quote-items/'))
  assert.ok(inv.rest_api.some(r => r.method === 'GET' && r.path === '/quote-items/{pk}/'))
  assert.ok(inv.rest_api.some(r => r.method === 'POST' && r.path === '/quote-items/{pk}/publish-now/'))

  assert.ok(inv.routes_endpoints.some(r => r.path === '/logout/' && r.plugin === 'django-drf'), 'general Django route ledger is preserved')
  const permission = inv.tokens_actors.find(r => /QuotesView permission_classes/.test(r.entry))
  const authentication = inv.tokens_actors.find(r => /QuotesView authentication_classes/.test(r.entry))
  assert.ok(permission && permission.line === 15, 'permission declaration has its exact source line')
  assert.ok(authentication && authentication.line === 16, 'authentication declaration has its exact source line')
  assert.ok(inv.tokens_actors.some(r => /api_logout permission_classes/.test(r.entry)), 'function decorator authorization is mapped')
  assert.equal(inventoryMeta(inv).matched_plugins.includes('django-drf'), true)
  fs.rmSync(d, { recursive: true, force: true })
})

test('a Rails repo still uses the precise Rails plugin, not the universal fallback', () => {
  const dir = railsFixture()
  const inv = extractInventories({ sourceRoot: dir, profile: profileRepo(dir) })
  assert.ok(inv.routes_endpoints.length > 0 && inv.routes_endpoints.every(r => r.plugin === 'rails'), 'Rails precision preserved')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a polyglot Rails repository also maps uncovered non-Ruby modules', () => {
  const dir = railsFixture()
  write(dir, 'services/account-api/src/routes/users.ts', "router.get('/api/users', handler)\n")
  const inv = extractInventories({ sourceRoot: dir, profile: profileRepo(dir) })
  assert.ok(inv.routes_endpoints.some((r) => r.plugin === 'rails'), 'Rails precision preserved')
  assert.ok(inv.rest_api.some((r) => r.plugin === 'universal' && r.file.endsWith('users.ts')), 'uncovered TypeScript API mapped')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a specialized plugin adds precision but never claims files it did not represent (universal still anchors them)', () => {
  const dir = railsFixture()
  write(dir, 'app/lib/opaque.rb', "module Opaque\n  X = 1\nend\n")   // rails plugin does not map this .rb file
  const inv = extractInventories({ sourceRoot: dir, profile: profileRepo(dir) })
  const opaque = INVENTORY_KEYS.flatMap((k) => inv[k]).find((r) => r.file.endsWith('opaque.rb'))
  assert.ok(opaque && opaque.plugin === 'universal', 'the plugin-unrepresented .rb is still covered by a universal anchor')
  assert.equal(inventoryMeta(inv).unrepresented_source_files, 0, 'no snapshotted code file is left uncounted')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('advertised languages the profiler snapshots all map + are counted (one canonical predicate, no zero-mapping)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-poly-'))
  write(d, 'Bank.lhs', '> module Bank where\n> transfer = undefined\n')       // Haskell literate
  write(d, 'PAYROLL.cbl', 'IDENTIFICATION DIVISION.\nPROGRAM-ID. PAYROLL.\n')  // COBOL
  write(d, 'Api.fsi', 'module Api\nval handler : unit -> unit\n')             // F# signature
  write(d, 'home.pug', 'html\n  body\n    h1 Home\n')                          // Pug template
  const inv = extractInventories({ sourceRoot: d, profile: profileRepo(d) })
  const meta = inventoryMeta(inv)
  assert.equal(meta.source_code_files, 4, 'every snapshotted code/template file is counted as source')
  assert.equal(meta.unrepresented_source_files, 0, 'none vanish from coverage (no narrower private list)')
  fs.rmSync(d, { recursive: true, force: true })
})

test('OpenAPI contracts are recognized by content — non-blessed filenames + quoted YAML paths', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-spec-'))
  write(d, 'api-spec.json', JSON.stringify({ openapi: '3.0.0', paths: { '/users': { get: { summary: 'list' } } } }))
  write(d, 'api-spec.yaml', 'openapi: 3.0.0\npaths:\n  "/accounts":\n    get:\n    post:\n')
  const inv = extractInventories({ sourceRoot: d, profile: profileRepo(d) })
  const ops = inv.rest_api.filter((r) => r.detail === 'openapi').map((r) => r.entry)
  assert.ok(ops.includes("GET '/users'"), 'content-detected JSON spec maps its operations')
  assert.ok(ops.includes("GET '/accounts'") && ops.includes("POST '/accounts'"), 'quoted-path YAML spec maps its operations')
  fs.rmSync(d, { recursive: true, force: true })
})

test('minified/vendored client assets are not scraped as server routes or counted as source', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bundle-'))
  write(d, 'app/controllers/orders_controller.rb', "class OrdersController < ApplicationController\n  def index; end\nend\n")
  write(d, 'public/assets/vendor.min.js', 'var x=1;'.repeat(200))                      // minified by name
  write(d, 'public/js/jquery.jstree.js', "$.get('/x');\n".repeat(50) + '$http.get(url)\n')  // unminified lib in an asset dir
  const inv = extractInventories({ sourceRoot: d, profile: profileRepo(d) })
  const all = INVENTORY_KEYS.flatMap((k) => inv[k])
  assert.ok(!all.some((r) => /vendor\.min\.js|jquery\.jstree\.js/.test(r.file)), 'no rows sourced from client bundles/assets')
  assert.ok(all.some((r) => r.file.endsWith('orders_controller.rb')), 'real server source still mapped')
  fs.rmSync(d, { recursive: true, force: true })
})
