'use strict'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hostOk, originOk } from '../index.js'

test('Host guard accepts only the configured loopback host and port', () => {
  assert.equal(hostOk('127.0.0.1:4173', 4173), true)
  assert.equal(hostOk('localhost:4173', 4173), true)
  assert.equal(hostOk('[::1]:4173', 4173), true)
  assert.equal(hostOk('localhost:3000', 4173), false)
  assert.equal(hostOk('evil.example', 4173), false)
  assert.equal(hostOk(undefined, 4173), false)
})

test('Origin guard rejects cross-port localhost and non-loopback origins', () => {
  assert.equal(originOk(undefined, 4173), true)
  assert.equal(originOk('http://127.0.0.1:4173', 4173), true)
  assert.equal(originOk('http://localhost:4173', 4173), true)
  assert.equal(originOk('http://localhost:3000', 4173), false)
  assert.equal(originOk('https://localhost:4173', 4173), false)
  assert.equal(originOk('http://evil.example', 4173), false)
})
