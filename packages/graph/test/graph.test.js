'use strict'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openGraph, upsertNode, upsertEdge, addClaim, addReconItem, reconCounts, reconTotal, getNode, counts, neighbourhood, search, mergeStaging } from '../index.js'
import { ID } from '../../schemas/index.js'

test('stable-id upsert merges data instead of duplicating', () => {
  const db = openGraph()
  const fid = ID.feature('identity', 'oauth')
  upsertNode(db, { type: 'FEATURE', id: fid, name: 'OAuth', data: { domain: 'identity' } })
  upsertNode(db, { type: 'FEATURE', id: fid, data: { purpose: 'sign-in' } })   // re-scan enriches
  assert.equal(counts(db).nodes, 1, 'same id ⇒ one node')
  assert.deepEqual(getNode(db, fid).data, { domain: 'identity', purpose: 'sign-in' })
})

test('edges store canonical from/to as src/dst and support bounded neighbourhood', () => {
  const db = openGraph()
  const f = ID.feature('core', 'users'), e = ID.endpoint('GET', '/users'), fl = ID.file('app/users.rb')
  for (const n of [{ type: 'FEATURE', id: f }, { type: 'ENDPOINT', id: e }, { type: 'FILE', id: fl }]) upsertNode(db, n)
  upsertEdge(db, { type: 'EXPOSES', from: f, to: e })
  upsertEdge(db, { type: 'HANDLED_BY', from: e, to: fl })
  const n1 = neighbourhood(db, f, 1)
  assert.ok(n1.nodes.some((x) => x.id === e) && !n1.nodes.some((x) => x.id === fl), '1 hop reaches endpoint, not file')
  const n2 = neighbourhood(db, f, 2)
  assert.ok(n2.nodes.some((x) => x.id === fl), '2 hops reaches the file')
  assert.equal(neighbourhood(db, f, 2, 2).nodes.length, 2, 'cap bounds the node count')
})

test('search finds nodes by name/id', () => {
  const db = openGraph()
  upsertNode(db, { type: 'FEATURE', id: ID.feature('billing', 'invoices'), name: 'Invoices' })
  assert.equal(search(db, 'Invoic')[0].name, 'Invoices')
})

test('#4 addClaim validates strictly — bad provenance / dangling node / not-exactly-one are rejected', () => {
  const db = openGraph()
  const fid = ID.feature('a', 'b'); upsertNode(db, { type: 'FEATURE', id: fid })
  const P = { snapshot_id: 's', file: 'a.rb', confidence: 'high' }
  assert.throws(() => addClaim(db, { id: 'c', node_id: fid, field: 'x', method: 'grep', ...P }), /invalid claim/) // grep needs a line
  assert.throws(() => addClaim(db, { id: 'c', field: 'x', line_start: 1, method: 'ast', ...P }), /invalid claim/)  // neither node nor edge
  assert.throws(() => addClaim(db, { id: 'c', node_id: ID.feature('z', 'z'), field: 'x', line_start: 1, method: 'ast', ...P }), /missing node/)
  addClaim(db, { id: 'c', node_id: fid, field: 'x', line_start: 1, method: 'ast', ...P })                          // valid
  assert.equal(counts(db).claims, 1)
})

test('#14 opening a DB written by an incompatible schema is rejected, not silently corrupted', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-g-')), 'index.sqlite')
  const db = openGraph(f); db.prepare("UPDATE meta SET value='0.0.1' WHERE key='schema_version'").run(); db.close()
  assert.throws(() => openGraph(f), /schema 0\.0\.1/)
  fs.rmSync(path.dirname(f), { recursive: true, force: true })
})

test('#7 an edge to a missing node is rejected (no dangling edges enter the graph)', () => {
  const db = openGraph()
  upsertNode(db, { type: 'FEATURE', id: ID.feature('a', 'b') })
  assert.throws(() => upsertEdge(db, { type: 'CONTAINS', from: ID.feature('a', 'b'), to: ID.file('missing.rb') }), /missing dst node/)
  upsertNode(db, { type: 'FILE', id: ID.file('missing.rb') })
  upsertEdge(db, { type: 'CONTAINS', from: ID.feature('a', 'b'), to: ID.file('missing.rb') })   // now both exist → ok
  assert.equal(counts(db).edges, 1)
})

test('#6 reconciliation ledger records per-item terminal statuses', () => {
  const db = openGraph()
  addReconItem(db, { id: 'r1', kind: 'routes_endpoints', file: 'a.rb', line: 1, status: 'MAPPED_TO_FEATURE', feature_id: ID.feature('x', 'y'), snapshot_id: 's' })
  addReconItem(db, { id: 'r2', kind: 'datastores_integrations', file: 'db.yml', line: 1, status: 'SHARED_INFRASTRUCTURE', snapshot_id: 's' })
  assert.throws(() => addReconItem(db, { id: 'r3', status: 'NONSENSE' }), /invalid reconciliation status/)
  assert.deepEqual(reconCounts(db), { MAPPED_TO_FEATURE: 1, SHARED_INFRASTRUCTURE: 1 })
  assert.equal(reconTotal(db), 2)
})

test('staging → index merge is transactional; a bad row rolls the whole batch back', () => {
  const index = openGraph(), staging = openGraph()
  upsertNode(staging, { type: 'FEATURE', id: ID.feature('a', 'b'), name: 'B' })
  upsertNode(staging, { type: 'FILE', id: ID.file('x.rb') })     // node before edge (#7)
  upsertEdge(staging, { type: 'CONTAINS', from: ID.feature('a', 'b'), to: ID.file('x.rb') })
  addClaim(staging, { id: 'c1', node_id: ID.feature('a', 'b'), field: 'name', snapshot_id: 's', file: 'x.rb', line_start: 1, method: 'ast', confidence: 'high' })
  const c = mergeStaging(index, staging)
  assert.deepEqual(c, { nodes: 2, edges: 1, claims: 1 })

  // corrupt staging with an invalid edge, then merge into a fresh index → must roll back entirely
  const index2 = openGraph()
  staging.prepare("INSERT INTO edges(id,type,src,dst) VALUES('bad','NOPE','','')").run()
  assert.throws(() => mergeStaging(index2, staging), /invalid edge/)
  assert.equal(counts(index2).nodes, 0, 'rollback left nothing behind')
})
