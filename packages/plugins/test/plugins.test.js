'use strict'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { definePlugin, Registry, INVENTORY_KEYS } from '../index.js'

test('definePlugin rejects malformed plugins, freezes valid ones', () => {
  assert.throws(() => definePlugin({}), /string id/)
  assert.throws(() => definePlugin({ id: 'x', langs: [] }), /non-empty array/)
  assert.throws(() => definePlugin({ id: 'x', langs: ['Ruby'] }), /detect/)
  assert.throws(() => definePlugin({ id: 'x', langs: ['Ruby'], detect: () => true }), /inventory/)
  const p = definePlugin({ id: 'x', langs: ['Ruby'], detect: () => true, inventory: () => ({}) })
  assert.ok(Object.isFrozen(p) && p.schema_compat === '0.3.0')
})

test('registry match honors detect() and swallows plugin errors', () => {
  const r = new Registry()
    .register({ id: 'a', langs: ['Ruby'], detect: (p) => p.frameworks.includes('Rails'), inventory: () => ({}) })
    .register({ id: 'b', langs: ['Go'], detect: () => { throw new Error('boom') }, inventory: () => ({}) })
    .register({ id: 'c', langs: ['JS'], detect: () => false, inventory: () => ({}) })
  assert.deepEqual(r.match({ frameworks: ['Rails'] }).map((p) => p.id), ['a'], 'only a matches; b throws→skip, c→false')
})

test('INVENTORY_KEYS mirrors the 11 canonical inventories', () => {
  assert.equal(INVENTORY_KEYS.length, 11)
  assert.ok(INVENTORY_KEYS.includes('routes_endpoints') && INVENTORY_KEYS.includes('datastores_integrations'))
})
