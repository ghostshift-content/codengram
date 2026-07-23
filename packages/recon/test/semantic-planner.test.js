'use strict'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deterministicSemanticPlan, validateLeadPlan } from '../semantic-planner.js'
import { INVENTORY_KEYS } from '../../plugins/index.js'

const empty = () => Object.fromEntries(INVENTORY_KEYS.map((k) => [k, []]))
const rowCount = (features) => features.reduce((n, f) => n + f.rows.length, 0)

test('large repositories consolidate into bounded modules from their OWN structure (no hardcoded taxonomy)', () => {
  const inv = empty()
  for (let i = 0; i < 120; i++) inv.graphql.push({ file: `src/billing/issue_${i}.rb`, line: 1, entry: `field :issue_${i}`, detail: 'graphql-field', plugin: 'rails' })
  for (let i = 0; i < 40; i++) inv.services_finders_policies.push({ file: `src/reporting/helper_${i}.rb`, line: 1, entry: `helper_${i}.rb`, detail: 'service', plugin: 'rails' })
  const plan = deterministicSemanticPlan(inv)
  assert.ok(plan.length < 10, `expected module consolidation, got ${plan.length}`)
  assert.equal(rowCount(plan), 160, 'no inventory row is dropped')
  assert.ok(plan.some((f) => f.slug === 'billing') && plan.some((f) => f.slug === 'reporting'), 'features derived from the code’s modules')
  assert.ok(!plan.some((f) => f.slug === 'issues-work-items' || f.slug === 'supporting-capabilities'), 'no curated product taxonomy')
  assert.ok(plan.every((f) => f.planning_method === 'module-cohesion'))
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
  const { features } = validateLeadPlan(plan, inv)
  const issues = features.find((f) => f.slug === 'issues-work-items')
  assert.equal(issues.rows.length, 2, 'specific issue evidence wins over broad user selector')
  assert.equal(issues.purpose, 'Issue workflows', 'Claude-derived purpose is preserved')
  assert.equal(rowCount(features), 2, 'each row is assigned exactly once')
})

test('Lead keeps the rows its selectors claim; unmatched rows go to a module fallback (no taxonomy coalescing)', () => {
  const inv = empty()
  inv.services_finders_policies.push({ file: 'app/services/issues/create_issue_service.rb', line: 1, entry: 'CreateIssueService', detail: 'service', plugin: 'rails' })
  for (let i = 0; i < 80; i++) inv.graphql.push({ file: `src/billing/issue_${i}.rb`, line: 3, entry: `field :issue_${i}`, detail: 'graphql-field', plugin: 'rails' })
  const plan = { features: [{ name: 'Issues', slug: 'issues-work-items', domain: 'planning', purpose: 'Issue workflows',
    include_paths: ['app/services/issues'], include_terms: [] }] }
  const { features, archClusters } = validateLeadPlan(plan, inv)
  const issues = features.find((f) => f.slug === 'issues-work-items')
  assert.equal(issues.rows.length, 1, 'Lead claims the service it selected by path')
  assert.equal(rowCount(features) + rowCount(archClusters), 81, 'no inventory row is dropped')
  // STRICT RULE: the 80 rows the Lead did NOT confirm are ARCHITECTURE (clusters), never Lead features.
  assert.ok(!features.some((f) => f.slug === 'billing'), 'an unconfirmed directory does not become a business feature')
  assert.ok(archClusters.some((f) => f.slug === 'billing' && f.planning_method === 'lead-gap-fallback'), 'it is preserved as a technical cluster instead')
})
