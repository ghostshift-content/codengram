'use strict'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as S from '../index.js'

test('node/edge/inventory/phase contracts are complete', () => {
  assert.equal(S.NODE_TYPES.length, 22)
  assert.ok(S.NODE_TYPES.includes('DOMAIN'))
  assert.equal(S.EDGE_TYPES.length, 16)
  assert.equal(S.INVENTORY_STATUS.length, 5)
  assert.equal(S.INVENTORY_FILES.length, 11)
  assert.equal(S.RECON_PHASES.length, 6)
})

test('§7 ids are traversal-safe, non-empty, and id↔type consistent', () => {
  assert.throws(() => S.ID.file('../../etc/passwd'), /unsafe/)
  assert.throws(() => S.ID.project(''), /stable key/)
  assert.throws(() => S.ID.role('!!!'), /empty/)
  assert.ok(S.ID.project('/Users/me/code/acme').startsWith('project:acme-'))
  assert.ok(S.isValidNode({ type: 'FEATURE', id: S.ID.feature('identity', 'oauth') }))
  assert.ok(!S.isValidNode({ type: 'FEATURE', id: 'oauth' }), 'FEATURE id must carry the feature: prefix')
})

test('§7 ordered/positive provenance + strict claims', () => {
  assert.ok(!S.isValidProvenance(S.provenance({ snapshot_id: 's', file: 'a', line_start: 10, line_end: 2, method: 'ast' })), 'line_end < line_start invalid')
  assert.ok(S.isValidProvenance(S.provenance({ snapshot_id: 's', file: 'a', line_start: 3, line_end: 9, method: 'ast' })))
  assert.ok(!S.isValidClaim({}))
  assert.ok(!S.isValidClaim({ claim_id: 'c', node_id: 'n', edge_id: 'e', field: 'x', provenance: S.provenance({ snapshot_id: 's', file: 'a', method: 'manifest' }) }), 'needs exactly one of node/edge')
  assert.ok(S.isValidClaim({ claim_id: 'c', node_id: S.ID.feature('d', 'f'), field: 'purpose', provenance: S.provenance({ snapshot_id: 's', file: 'Gemfile', method: 'manifest' }) }))
})

test('§6 canonical edge direction is from/to (not src/dst)', () => {
  assert.ok(S.isValidEdge({ type: 'HANDLED_BY', from: 'a', to: 'b' }))
  assert.ok(!S.isValidEdge({ type: 'HANDLED_BY', src: 'a', dst: 'b' }))
  assert.deepEqual(S.EDGE_SQL_MAP, { from: 'src', to: 'dst' })
})

test('§8 stable, deterministic ids', () => {
  assert.equal(S.ID.endpoint('get', '/users/:id/edit/'), 'endpoint:GET:/users/:param/edit')
  assert.equal(S.ID.file('./App/Models/User.rb'), 'file:App/Models/User.rb')
  assert.equal(S.ID.feature('identity', 'OAuth Sign-in'), 'feature:identity-oauth-sign-in')
  // same input ⇒ same id (the basis for incremental refresh)
  assert.equal(S.ID.symbol('a/b.rb', 'Foo#bar'), S.ID.symbol('a/b.rb', 'Foo#bar'))
})

test('row-derived scoped ids do not collide after readable-prefix truncation', () => {
  const prefix = `app/services/${'very-long-shared-directory/'.repeat(6)}`
  const a = S.ID.scoped('service', `${prefix}alpha.rb`, 1)
  const b = S.ID.scoped('service', `${prefix}beta.rb`, 1)
  assert.notEqual(a, b)
  assert.equal(a, S.ID.scoped('service', `${prefix}alpha.rb`, 1), 'stable for the same logical row')
})

test('§7 provenance requires a real location or a repo/generated method — never a fake line', () => {
  assert.ok(S.isValidProvenance(S.provenance({ snapshot_id: 's', file: 'a.rb', line_start: 3, confidence: 'high', method: 'ast' })))
  assert.ok(!S.isValidProvenance(S.provenance({ snapshot_id: 's', file: 'a.rb', confidence: 'high', method: 'grep' })), 'grep needs a line')
  assert.ok(S.isValidProvenance(S.provenance({ snapshot_id: 's', file: 'Gemfile', confidence: 'high', method: 'manifest' })), 'manifest may omit the line')
  assert.equal(S.provenance({ snapshot_id: 's', file: 'a', confidence: 'med' }).confidence, 'medium', "'med' normalizes to 'medium'")
})

test('§5 three distinct, guarded state machines', () => {
  assert.ok(S.canMissionTransition('RUNNING', 'PAUSED_QUOTA'))
  assert.ok(!S.canMissionTransition('COMPLETED', 'RUNNING'))
  assert.ok(S.canTaskTransition('RUNNING', 'RETRY_WAIT') && S.isTaskTerminal('BLOCKED'))
  assert.ok(S.PUBLICATION_STATES.includes('COMPLETE_WITH_GAPS'))
  assert.ok(!S.PUBLICATION_STATES.includes('PAUSED_QUOTA'), 'PAUSED_QUOTA is a mission state, not a publication result')
})
