'use strict'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEvidenceVerifier, validateOntology } from '../evidence-validator.js'

const files = {
  'app/policies/issue_policy.rb': 'class IssuePolicy\n  def read?\n    can? :read_issue\n  end\nend\n',
  'app/models/member.rb': 'class Member\n  ROLE_OWNER = 50\nend\n',
  'spec/policies/issue_policy_spec.rb': 'role "admin"\n',
  'config/roles.yml': "owner:\n  - admin\n",
}
const verifier = () => makeEvidenceVerifier({ readSource: (r) => files[r] || '' })

test('verify grounds real citations and rejects hallucinated file / line / symbol', () => {
  const v = verifier()
  assert.ok(v.verify({ file: 'app/policies/issue_policy.rb', line: 2, symbol: 'read?' }).ok)
  assert.ok(v.verify({ file: 'app/models/member.rb' }).ok)
  assert.ok(!v.verify({ file: 'app/policies/nope.rb', line: 1 }).ok)
  assert.ok(!v.verify({ file: 'app/policies/issue_policy.rb', line: 999 }).ok)
  assert.ok(!v.verify({ file: 'app/policies/issue_policy.rb', symbol: 'Nonexistent' }).ok)
  assert.ok(!v.verify({ file: 'app/policies/issue_policy.rb', line: 2, symbol: 'ROLE_OWNER' }).ok, 'a symbol absent from the file is rejected')
})

test('qualified symbols the Lead naturally cites are grounded by identifier token (Role::Support, reply(), $user->role)', () => {
  const src = { 'app/Models/Role.php': "enum Role: string {\n    case Support = 'support';\n}\n", 'app/Policies/TicketPolicy.php': 'function reply($user){ return $user->role; }\n' }
  const v = makeEvidenceVerifier({ readSource: (r) => src[r] || '' })
  assert.ok(v.verify({ file: 'app/Models/Role.php', line: 2, symbol: 'Role::Support' }, { requireEstablishing: true }).ok, 'namespaced enum case grounds via its token')
  assert.ok(v.verify({ file: 'app/Policies/TicketPolicy.php', symbol: 'reply()' }).ok)
  assert.ok(v.verify({ file: 'app/Policies/TicketPolicy.php', symbol: '$user->role' }).ok)
  assert.ok(!v.verify({ file: 'app/Models/Role.php', symbol: 'Administrator::Delete' }).ok, 'a symbol with no token in the file is still rejected')
})

test('identity evidence must come from authoritative production/config — specs/fixtures/assets never establish it', () => {
  const v = verifier()
  assert.ok(v.verify({ file: 'app/models/member.rb', line: 2, symbol: 'ROLE_OWNER' }, { requireEstablishing: true }).ok)
  assert.ok(v.verify({ file: 'config/roles.yml', line: 1 }, { requireEstablishing: true }).ok)
  assert.ok(!v.verify({ file: 'spec/policies/issue_policy_spec.rb', line: 1, symbol: 'admin' }, { requireEstablishing: true }).ok)
})

test('validateOntology drops ungrounded features, spec-only roles, and orphaned relationships', () => {
  const { ontology, rejected, accepted } = validateOntology({
    features: [
      { slug: 'issues', name: 'Issues', evidence: [{ file: 'app/policies/issue_policy.rb', line: 1 }] },
      { slug: 'ghost', name: 'Ghost', evidence: [{ file: 'does/not/exist.rb', line: 1 }] },
      { slug: 'nocite', name: 'NoCite' },
    ],
    roles: [
      { name: 'owner', evidence: [{ file: 'app/models/member.rb', line: 2, symbol: 'ROLE_OWNER' }] },
      { name: 'admin', evidence: [{ file: 'spec/policies/issue_policy_spec.rb', line: 1, symbol: 'admin' }] },
    ],
    relationships: [{ from: 'issues', to: 'ghost' }, { from: 'issues', to: 'owner' }],
  }, verifier())
  assert.deepEqual(ontology.features.map((f) => f.slug), ['issues'])
  assert.deepEqual(ontology.roles.map((r) => r.name), ['owner'])
  assert.deepEqual(ontology.relationships, [{ from: 'issues', to: 'owner' }])
  assert.equal(accepted.features, 1)
  assert.ok(rejected.length >= 4)
})

test('permissions require a grounded actor or role grantee; internal controls cannot float as abilities', () => {
  const { ontology, rejected } = validateOntology({
    actors: [{ name: 'member', kind: 'human', evidence: [{ file: 'app/models/member.rb', line: 1, symbol: 'Member' }] }],
    roles: [{ name: 'owner', evidence: [{ file: 'app/models/member.rb', line: 2, symbol: 'ROLE_OWNER' }] }],
    permissions: [
      { name: 'read_issue', enabled_by_roles: ['owner'], granted_to_actors: [],
        evidence: [{ file: 'app/policies/issue_policy.rb', line: 1, symbol: 'IssuePolicy' }] },
      { name: 'create_issue', enabled_by_roles: [], granted_to_actors: ['member'],
        evidence: [{ file: 'app/policies/issue_policy.rb', line: 1, symbol: 'IssuePolicy' }] },
      { name: 'body_size_limit', enabled_by_roles: [], granted_to_actors: [],
        evidence: [{ file: 'app/policies/issue_policy.rb', line: 1, symbol: 'IssuePolicy' }] },
    ],
  }, verifier())
  assert.deepEqual(ontology.permissions.map((p) => p.name), ['read_issue', 'create_issue'])
  assert.ok(rejected.some((r) => r.name === 'body_size_limit' && /no grounded actor or role grantee/.test(r.reason)))
})
