'use strict'
import { test } from 'node:test'
import assert from 'node:assert/strict'
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
