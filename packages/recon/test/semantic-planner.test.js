'use strict'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deterministicSemanticPlan, validateLeadPlan } from '../semantic-planner.js'
import { INVENTORY_KEYS } from '../../plugins/index.js'

const empty = () => Object.fromEntries(INVENTORY_KEYS.map((k) => [k, []]))
const rowCount = (features) => features.reduce((n, f) => n + f.rows.length, 0)

test('large repositories consolidate implementation rows into bounded business capabilities', () => {
  const inv = empty()
  for (let i = 0; i < 120; i++) inv.graphql.push({ file: `app/graphql/types/issue_${i}_type.rb`, line: 1, entry: `field :issue_${i}`, detail: 'graphql-field', plugin: 'rails' })
  for (let i = 0; i < 40; i++) inv.services_finders_policies.push({ file: `app/services/internal/helper_${i}.rb`, line: 1, entry: `helper_${i}.rb`, detail: 'service', plugin: 'rails' })
  const plan = deterministicSemanticPlan(inv)
  assert.ok(plan.some((f) => f.slug === 'issues-work-items'))
  assert.ok(plan.some((f) => f.slug === 'supporting-capabilities'))
  assert.ok(plan.length < 10, `expected semantic consolidation, got ${plan.length}`)
  assert.equal(rowCount(plan), 160, 'no inventory row is dropped')
})

test('large universal repositories use their own modules, never the curated product taxonomy', () => {
  const inv = empty()
  for (let i = 0; i < 100; i++) inv.services_finders_policies.push({
    file: `apps/files/lib/Service/UserFile${i}.php`, line: 1, entry: `UserFile${i}.php`, detail: 'source-module', plugin: 'universal',
  })
  const plan = deterministicSemanticPlan(inv)
  assert.ok(plan.some((f) => f.domain === 'applications' && f.slug === 'file'))
  assert.ok(!plan.some((f) => f.slug === 'users-profile' || f.slug === 'uploads-files'), 'generic words do not select curated taxonomy')
  assert.equal(rowCount(plan), 100)
})

test('Lead selectors use strongest-match assignment, not feature-list order', () => {
  const inv = empty()
  inv.services_finders_policies.push({ file: 'app/services/issues/create_issue_service.rb', line: 1, entry: 'CreateIssueService', detail: 'service' })
  inv.tokens_actors.push({ file: 'app/policies/issue_policy.rb', line: 7, entry: 'can?(:read_issue, user)', detail: 'permission' })
  const plan = { features: [
    { name: 'Users', slug: 'users-profile', domain: 'identity', purpose: 'User accounts', include_paths: [], include_terms: ['user'] },
    { name: 'Issues', slug: 'issues-work-items', domain: 'planning', purpose: 'Issue workflows', include_paths: ['app/services/issues'], include_terms: ['issue'] },
  ] }
  const features = validateLeadPlan(plan, inv)
  const issues = features.find((f) => f.slug === 'issues-work-items')
  assert.equal(issues.rows.length, 2, 'specific issue evidence wins over broad user selector')
  assert.equal(rowCount(features), 2, 'each row is assigned exactly once')
})

test('Lead and fallback rows resolving to the same feature are coalesced', () => {
  const inv = empty()
  inv.services_finders_policies.push({ file: 'app/services/issues/create_issue_service.rb', line: 1, entry: 'CreateIssueService', detail: 'service', plugin: 'rails' })
  for (let i = 0; i < 80; i++) inv.graphql.push({ file: `app/graphql/types/issue_${i}_type.rb`, line: 3, entry: `field :issue_${i}`, detail: 'graphql-field', plugin: 'rails' })
  const plan = { features: [{ name: 'Issues', slug: 'issues-work-items', domain: 'planning', purpose: 'Issue workflows',
    include_paths: ['app/services/issues'], include_terms: [] }] }
  const features = validateLeadPlan(plan, inv)
  const issues = features.filter((f) => f.domain === 'planning' && f.slug === 'issues-work-items')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].rows.length, 81)
  assert.equal(issues[0].planning_method, 'agent-lead')
})
