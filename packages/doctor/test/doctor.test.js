'use strict'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runDoctor, REQUIRED_NODE_MAJOR } from '../index.js'

const byName = (r, name) => r.checks.find((c) => c.name === name)

test('doctor passes the hard checks on a writable data dir + free port', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-doc-'))
  const r = await runDoctor({ dataRoot, port: 0 })   // port 0 = ephemeral, always free
  assert.equal(r.ok, true)
  assert.equal(byName(r, 'Node.js').status, 'ok')
  assert.equal(byName(r, 'SQLite (built-in)').status, 'ok')
  assert.equal(byName(r, 'Data directory').status, 'ok')
  fs.rmSync(dataRoot, { recursive: true, force: true })
})

test('AI is a WARNING, never a hard failure — the tool runs without Claude', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-doc2-'))
  const r = await runDoctor({ dataRoot })            // CODENGRAM_DISABLE_AI or no SDK → warn, still ok
  const ai = r.checks.find((c) => /Claude/.test(c.name))
  assert.ok(ai && ai.status !== 'fail', 'Claude checks never hard-fail')
  assert.equal(r.ok, true, 'overall ok even when AI is unavailable')
  fs.rmSync(dataRoot, { recursive: true, force: true })
})

test('a taken port is a hard failure with a fix hint', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-doc3-'))
  const net = await import('node:net')
  const srv = net.createServer(); await new Promise((res) => srv.listen(0, '127.0.0.1', res))
  const port = srv.address().port
  const r = await runDoctor({ dataRoot, port })
  assert.equal(byName(r, 'Server port').status, 'fail')
  assert.ok(byName(r, 'Server port').fix)
  assert.equal(r.ok, false)
  srv.close(); fs.rmSync(dataRoot, { recursive: true, force: true })
})

test('REQUIRED_NODE_MAJOR is 22 (built-in SQLite baseline)', () => assert.equal(REQUIRED_NODE_MAJOR, 22))
