'use strict'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanSnapshot, latestPublished } from '../index.js'
import { renderPhase1Maps } from '../../markdown-renderer/index.js'
import { createProject } from '../../ingestion/index.js'
import { openGraph, nodesByType } from '../../graph/index.js'

const cases = [
  {
    name: 'Express API-only',
    file: 'src/orders.js',
    body: "router.get('/orders/:id', requireUser, async (req, res) => res.json(await orders.find(req.params.id)))\n",
    feature: 'Order API',
    slug: 'order-api',
    domain: 'commerce',
    purpose: 'Read and manage orders through the service API.',
  },
  {
    name: 'Django',
    file: 'billing/views.py',
    body: "class InvoiceView(APIView):\n    def get(self, request, invoice_id):\n        return Response(load_invoice(invoice_id))\n",
    feature: 'Invoice Management',
    slug: 'invoice-management',
    domain: 'billing',
    purpose: 'Retrieve and manage customer invoices.',
  },
  {
    name: 'Go service',
    file: 'internal/catalog/handler.go',
    body: 'package catalog\nfunc ListProducts(w http.ResponseWriter, r *http.Request) {}\n',
    feature: 'Product Catalog',
    slug: 'product-catalog',
    domain: 'catalog',
    purpose: 'Expose the product catalogue through service handlers.',
  },
  {
    name: 'Spring API',
    file: 'src/main/java/demo/ProfileController.java',
    body: 'class ProfileController { @GetMapping("/profiles/{id}") Object show(String id) { return service.find(id); } }\n',
    feature: 'Profile API',
    slug: 'profile-api',
    domain: 'identity',
    purpose: 'Retrieve profiles through the application API.',
  },
]

for (const fixture of cases) test(`Claude semantic plan is authoritative for ${fixture.name}`, async () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stack-source-'))
  const target = path.join(source, fixture.file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, fixture.body)
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stack-data-'))
  const project = createProject(dataRoot, source)
  const planLead = async () => ({
    sessionId: `session:${fixture.slug}`,
    model: 'claude-test',
    plan: {
      features: [{
        name: fixture.feature,
        slug: fixture.slug,
        domain: fixture.domain,
        purpose: fixture.purpose,
        include_paths: [fixture.file],
        include_terms: [],
        include_symbols: [],
        include_entries: [],
        exclude_paths: [],
        exclude_terms: [],
        evidence: [{ file: fixture.file, line: 1 }],
      }],
      actors: [],
      roles: [],
      permissions: [],
      relationships: [],
      gaps: [],
    },
  })
  const result = await scanSnapshot(dataRoot, project.id, {
    planLead,
    render: (db, out, options) => renderPhase1Maps(db, out, options),
  })
  const graph = openGraph(latestPublished(dataRoot, project.id).indexPath)
  const features = nodesByType(graph, 'FEATURE')
  assert.deepEqual(features.map((f) => f.name), [fixture.feature], 'only Claude-derived semantics are published')
  assert.equal(features[0].data.purpose, fixture.purpose)
  assert.equal(features[0].data.planning_method, 'agent-lead')
  assert.notEqual(result.publication.executed_planner, 'blocked')
  graph.close()
  fs.rmSync(source, { recursive: true, force: true })
  fs.rmSync(dataRoot, { recursive: true, force: true })
})
