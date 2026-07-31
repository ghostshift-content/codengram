'use strict'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as CR from '../index.js'

process.env.CODENGRAM_DISABLE_AI = '1'

test('isAvailable is false when AI is disabled (offline-safe)', async () => {
  assert.equal(await CR.isAvailable(), false)
})

test('askClaude returns null when unavailable, so callers fall back deterministically', async () => {
  const r = await CR.askClaude({ preamble: 'x', question: 'y', bundle: { facts: [], citations: [] } })
  assert.equal(r, null)
})

test('recon-only policy permits target feature taxonomy but rejects finding-shaped output', () => {
  assert.equal(CR.isReconFeatureLabel('Vulnerability Management'), true)
  assert.equal(CR.isReconFeatureLabel('Security Dashboard'), true)
  assert.equal(CR.isReconFeatureLabel('Critical SQL injection in users'), false)
  assert.equal(CR.isReconAnswer('The authentication flow is implemented in app/controllers/sessions_controller.rb:3.'), true)
  assert.equal(CR.isReconAnswer('Severity: critical. SQL injection vulnerability confirmed.'), false)
})

test('security assessment questions are outside the recon-only Ask contract', () => {
  assert.equal(CR.isReconQuestion('How does authentication work?'), true)
  assert.equal(CR.isReconQuestion('Find SQL injection vulnerabilities in this feature'), false)
  assert.equal(CR.isReconQuestion('Perform a security assessment'), false)
})

test('large semantic summaries are split without dropping clusters and preserve locality', () => {
  const clusters = Array.from({ length: 80 }, (_, i) => ({ slug: `feature-${i}`, domain: i < 40 ? 'sales' : 'identity',
    paths: [i < 40 ? `packages/sales/mod-${i}` : `packages/identity/mod-${i}`], samples: [`service:${'x'.repeat(200)}`] }))
  const workstreams = CR.createReconWorkstreams(clusters, { maxBytes: 4_000 })
  assert.ok(workstreams.length > 2)
  assert.equal(workstreams.flatMap((w) => w.clusters).length, clusters.length, 'every cluster is assigned')
  assert.equal(new Set(workstreams.flatMap((w) => w.clusters.map((c) => c.slug))).size, clusters.length, 'no cluster overlaps')
  assert.ok(workstreams.every((w) => w.clusters.every((c) => w.locality.startsWith(c.domain))), 'domain locality is retained')
  assert.ok(workstreams.every((w) => w.cluster_count <= 30 && w.summary_bytes <= 4_000), 'both planning budgets are enforced')
})

test('workstream plan merge deduplicates capabilities and retains selectors and evidence', () => {
  const merged = CR.mergeReconPlans([
    { features: [{ name: 'Orders', slug: 'orders', domain: 'sales', include_paths: ['apps/orders'], include_terms: ['order'], evidence: [{ file: 'apps/orders/a.ts', line: 1 }] }], gaps: [] },
    { features: [{ name: 'Orders', slug: 'orders', domain: 'sales', include_paths: ['packages/orders'], include_terms: ['checkout'], evidence: [{ file: 'packages/orders/b.ts', line: 2 }] }], gaps: ['one gap'] },
  ])
  assert.equal(merged.features.length, 1)
  assert.deepEqual(merged.features[0].include_paths.sort(), ['apps/orders', 'packages/orders'])
  assert.equal(merged.features[0].evidence.length, 2)
  assert.deepEqual(merged.gaps, ['one gap'])
})

test('workstream runtime checkpoints session ids and resumes a failed bounded worker only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ws-'))
  const calls = []
  const attempts = new Map()
  const query = async function* ({ prompt, options }) {
    const id = prompt.match(/"id":"(ws-\d+)"/)?.[1]
    calls.push({ id, resume: options.resume || null })
    yield { type: 'system', subtype: 'init', session_id: `session:${id}` }
    const n = (attempts.get(id) || 0) + 1; attempts.set(id, n)
    if (id === 'ws-001' && n === 1) throw new Error('transient')
    yield { type: 'result', structured_output: { features: [{ name: `Capability ${id}`, slug: `capability-${id}`, domain: 'core',
      purpose: 'Grounded capability', include_paths: [`src/${id}`], include_terms: ['capability'], evidence: [{ file: `src/${id}/index.ts`, line: 1 }] }] } }
  }
  const workstreams = [1, 2].map((n) => ({ id: `ws-00${n}`, locality: `core:src/${n}`, cluster_count: 1,
    paths: [`src/${n}`], clusters: [{ slug: `c${n}`, domain: 'core', paths: [`src/${n}`] }] }))
  const result = await CR.planReconWorkstreams({ query, sourceRoot: dir, profile: { files: 50 }, inventoryCounts: { routes_endpoints: 2 },
    workstreams, skill: { text: 'Map coherent capabilities.' }, checkpointDir: path.join(dir, 'checkpoints'), onEvent: () => {} })
  assert.equal(result.workstreams.completed, 2)
  assert.ok(calls.some((c) => c.id === 'ws-001' && c.resume === 'session:ws-001'), 'failed session is resumed')
  const restoredCalls = []
  const restored = await CR.planReconWorkstreams({ query: async function* (args) { restoredCalls.push(args); }, sourceRoot: dir,
    profile: { files: 50 }, inventoryCounts: {}, workstreams, skill: { text: 'x' }, checkpointDir: path.join(dir, 'checkpoints'), onEvent: () => {} })
  assert.equal(restored.workstreams.completed, 2)
  assert.equal(restoredCalls.length, 0, 'completed workstreams are loaded without another model call')
  fs.rmSync(dir, { recursive: true, force: true })
})
