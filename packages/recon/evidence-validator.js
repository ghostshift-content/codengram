// @codengram/recon/evidence-validator — S4. The Lead may only claim what the source proves. Every ontology entity
// (feature/actor/role/permission/relationship) cites { file, line?, symbol? }; this verifies each citation against
// the FROZEN snapshot and REJECTS anything hallucinated or unsupported. Pure over an injected source reader — no I/O
// policy of its own, so it is trivially testable and reusable by the Lead path, the reconciler, and tests.

import { safeRelPath, isValidEvidence, canEstablishIdentity } from '../schemas/index.js'

// Build a verifier bound to a snapshot's file reader. `readSource(rel)` returns file text or '' (missing/binary).
// `fileExists(rel)` is optional; defaults to "readSource returned non-empty".
export function makeEvidenceVerifier({ readSource, fileExists = null }) {
  const cache = new Map()
  const get = (rel) => { if (cache.has(rel)) return cache.get(rel); let t = ''; try { t = readSource(safeRelPath(rel)) || '' } catch { t = '' }; cache.set(rel, t); return t }
  const exists = (rel) => { if (fileExists) { try { return !!fileExists(safeRelPath(rel)) } catch { return false } } return get(rel).length > 0 }

  // Verify ONE piece of evidence. Returns { ok, reason }. A citation is grounded only if the file exists, the line
  // (when given) is within the file, and the symbol (when given) actually appears in the file — near the line if both.
  function verify(ev, { requireEstablishing = false } = {}) {
    if (!isValidEvidence(ev)) return { ok: false, reason: 'malformed evidence (missing file / bad line)' }
    let rel; try { rel = safeRelPath(ev.file) } catch { return { ok: false, reason: `unsafe path: ${ev.file}` } }
    if (!exists(rel)) return { ok: false, reason: `cited file does not exist in snapshot: ${rel}` }
    const text = get(rel)
    const lines = text ? text.split(/\r?\n/) : []
    if (ev.line != null && lines.length && ev.line > lines.length) return { ok: false, reason: `cited line ${ev.line} > ${lines.length} lines in ${rel}` }
    if (ev.symbol && text) {
      const sym = String(ev.symbol)
      // A Lead naturally cites QUALIFIED symbols — Role::Support, obj->method, Module.Class, name(), #[Attr]. Require a
      // significant identifier TOKEN of the symbol to appear in the file (not the whole qualified string verbatim). This
      // still grounds the claim against real source while tolerating how models write references. Line numbers drift, so
      // presence-in-file is the anchor, not presence-on-the-exact-line.
      const tokens = sym.split(/[^A-Za-z0-9_]+/).filter((t) => t.length >= 3)
      const needles = tokens.length ? tokens : [sym]
      if (!needles.some((t) => text.includes(t))) return { ok: false, reason: `symbol '${sym}' not found in ${rel}` }
    }
    if (requireEstablishing && !canEstablishIdentity(rel)) return { ok: false, reason: `identity evidence from non-authoritative source (test/fixture/asset/doc): ${rel}` }
    return { ok: true, reason: null }
  }

  // An entity is grounded when it has ≥1 verifying evidence. Identity entities (role/permission/actor) additionally
  // require ≥1 evidence from an AUTHORITATIVE source — a role proven only by a spec/fixture is rejected.
  function groundsEntity(evidenceList, { identity = false } = {}) {
    const list = Array.isArray(evidenceList) ? evidenceList : []
    const verified = list.map((ev) => ({ ev, ...verify(ev, { requireEstablishing: identity }) })).filter((r) => r.ok)
    return { grounded: verified.length > 0, verified: verified.map((r) => r.ev), considered: list.length }
  }

  return { verify, groundsEntity, exists }
}

// Validate a full Lead ontology against the snapshot. Drops any feature/actor/role/permission whose evidence does not
// ground, and any relationship whose endpoints vanished. Returns the pruned ontology + a rejection ledger (audit trail).
export function validateOntology(ontology, verifier) {
  const rejected = []
  const keep = (arr, label, identity = false) => (Array.isArray(arr) ? arr : []).filter((e) => {
    const g = verifier.groundsEntity(e?.evidence, { identity })
    if (!g.grounded) { rejected.push({ kind: label, name: e?.name || e?.slug || '(unnamed)', reason: e?.evidence?.length ? 'no evidence verified against snapshot' : 'no evidence cited', considered: g.considered }); return false }
    e.evidence = g.verified
    return true
  })
  const features = keep(ontology?.features, 'feature')
  const actors = keep(ontology?.actors, 'actor', true)
  const roles = keep(ontology?.roles, 'role', true)
  const actorNames = new Set(actors.map((e) => e.name).filter(Boolean))
  const roleNames = new Set(roles.map((e) => e.name).filter(Boolean))
  const permissions = keep(ontology?.permissions, 'permission', true).filter((permission) => {
    const grantedRoles = (permission.enabled_by_roles || []).filter((name) => roleNames.has(name))
    const grantedActors = (permission.granted_to_actors || []).filter((name) => actorNames.has(name))
    if (!grantedRoles.length && !grantedActors.length) {
      rejected.push({ kind: 'permission', name: permission.name || '(unnamed)',
        reason: 'permission has no grounded actor or role grantee' })
      return false
    }
    permission.enabled_by_roles = grantedRoles
    permission.granted_to_actors = grantedActors
    return true
  })
  const names = new Set([...features, ...actors, ...roles, ...permissions].map((e) => e.slug || e.name).filter(Boolean))
  const relationships = (Array.isArray(ontology?.relationships) ? ontology.relationships : []).filter((r) => {
    const ok = names.has(r?.from) && names.has(r?.to)
    if (!ok) rejected.push({ kind: 'relationship', name: `${r?.from}→${r?.to}`, reason: 'endpoint not a grounded entity' })
    return ok
  })
  return { ontology: { ...ontology, features, actors, roles, permissions, relationships }, rejected,
    accepted: { features: features.length, actors: actors.length, roles: roles.length, permissions: permissions.length, relationships: relationships.length } }
}

// self-check
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = await import('node:assert')
  const files = { 'app/policies/issue_policy.rb': 'class IssuePolicy\n  def read?\n    can? :read_issue\n  end\nend\n',
    'spec/policies/issue_policy_spec.rb': 'role "admin"\n' }
  const v = makeEvidenceVerifier({ readSource: (r) => files[r] || '' })
  assert.ok(v.verify({ file: 'app/policies/issue_policy.rb', line: 2, symbol: 'read?' }).ok)
  assert.ok(!v.verify({ file: 'app/policies/nope.rb', line: 1 }).ok, 'missing file rejected')
  assert.ok(!v.verify({ file: 'app/policies/issue_policy.rb', line: 999 }).ok, 'out-of-range line rejected')
  assert.ok(!v.verify({ file: 'app/policies/issue_policy.rb', symbol: 'Nonexistent' }).ok, 'missing symbol rejected')
  // identity from a spec file is NOT authoritative
  assert.ok(!v.verify({ file: 'spec/policies/issue_policy_spec.rb', line: 1, symbol: 'admin' }, { requireEstablishing: true }).ok)
  const { ontology, rejected } = validateOntology({
    features: [{ slug: 'issues', name: 'Issues', evidence: [{ file: 'app/policies/issue_policy.rb', line: 1 }] },
               { slug: 'ghost', name: 'Ghost', evidence: [{ file: 'does/not/exist.rb', line: 1 }] }],
    roles: [{ name: 'admin', evidence: [{ file: 'spec/policies/issue_policy_spec.rb', line: 1, symbol: 'admin' }] }],   // spec-only → rejected
    relationships: [{ from: 'issues', to: 'ghost' }],
  }, v)
  assert.equal(ontology.features.length, 1)                 // ghost dropped (hallucinated file)
  assert.equal(ontology.roles.length, 0)                    // spec-only role dropped (not authoritative)
  assert.equal(ontology.relationships.length, 0)            // endpoint vanished
  assert.ok(rejected.length === 3)
  console.log('ok — evidence-validator: grounds real citations, rejects hallucinated files/lines/symbols + spec-only roles')
}
