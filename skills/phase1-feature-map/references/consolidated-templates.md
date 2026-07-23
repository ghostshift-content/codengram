# Consolidated Templates (`consolidated/*.md`)

Six files, aggregated from the per-feature maps after all features are mapped. Reproduce
headings and columns verbatim. `00_INDEX.md` is covered in `output-structure.md`.

---

## `feature_coverage_matrix.md`

Header line: `# Phase 1 — Feature Coverage Matrix`, then target + `N/N features mapped` +
`**M total endpoint/action ledger rows.**`, then the legend and the depth note.

One row per feature. `Y` = section present & populated in that feature map. Depth columns
reflect honest per-row status.

```markdown
| # | Feature | Core Files | Entry Pts | Svc/Model/Policy | Workers | Serializers/GraphQL | Same-Func | Ledger Rows | Coverage | Phase 2 Pri | Top Gap |
|---|---|---|---|---|---|---|---|---:|---|---|---|
| 1 | <Feature> | Y | Y | Y | Y | Y | Y | <N> | Complete/Partial | High/Medium/Low | <one-line top gap> |
```

End with `## Aggregate`:
- Features mapped: **N / N**
- Total endpoint/action ledger rows: **M**
- Coverage status: **Complete X** (list) · **Partial Y** · Incomplete Z
- Phase 2 priority: **High A** · Medium B · Low C
- Rows at "Deep Complete": **K** (where)

---

## `source_inventory_coverage_matrix.md`

Header: `# Source Inventory Coverage Matrix`. Reconciles the 9 inventories against the feature
mapping. **Include the honesty statement** — if item-by-item reconciliation of every raw
inventory line into the 5 categories was NOT performed, say so explicitly; the "Covered by
≥1 feature ledger" figures are honest estimates, not verified counts, and the missing
reconciliation is carried forward as blocker INV-1 in the completion gate.

```markdown
| Inventory | Total Items | Reconciled item-by-item | Covered by ≥1 feature ledger (est.) | Coverage basis | Status |
|---|---:|---|---|---|---|
| Routes (`01`) | <N> decls | No/Yes | <High/Medium/Low + note> | keyword/path scoped | Partial / not item-reconciled |
| REST API (`02`) | ... | ... | ... | ... | ... |
| ... one row per inventory 01–09 ... |
```

Then `## What IS solid` (bullets: every feature has a complete map; M ledger rows exist;
leads are class-grouped in the review queue) and `## What is NOT yet done (the denominator
gap)` (no artifact tags every raw inventory line into the 5 categories → cannot prove nothing
disappeared silently; closing it is a per-inventory reconciliation follow-up).

---

## `same_functionality_cross_feature_map.md`

Header: `# Same-Functionality Cross-Feature Map`, then the purpose statement (Phase 2 must
compare every implementation of a shared pattern so a check verified in one caller is NOT
assumed for the others).

```markdown
## Shared service / finder / concern clusters

| Shared infrastructure | Re-used by (features) | Phase 2 concern |
|---|---|---|
| `<SharedClass/concern/finder>` | <feature-a, feature-b, …> | <what must be verified per-caller> |
```

End with `## How Phase 2 should use this`: for each cluster, verify the shared code's
authorization **once**, then for **every** consuming feature confirm the caller does not
weaken or skip it (alternate entry point, different actor, bypassed object lookup). A check
confirmed safe in one feature does NOT clear the siblings — the no-sampling rule is per-caller.

---

## `phase2_review_queue.md`

Header: `# Phase 2 <Access-Control / general> Review Queue`, then: ranked, evidence-backed
targets aggregated from the feature maps' top-risks + gaps; each points back to
`features/<slug>.md`; these are **leads, not findings** — Phase 2 must verify each by reading
the full code path.

### `## Recurring <access-control> patterns (review as classes, not one-offs)`

Enumerate the cross-cutting patterns, each with the list of features exhibiting it. These are
the security-review lenses; adapt the set to the app, but the default class taxonomy is:

- **A. Parent-only authorization on child/relationship/list endpoints** (IDOR / cross-tenant leak)
- **B. Declared route/token permission ≠ enforced ability** (authz divergence REST vs Web vs GraphQL)
- **C. Service-delegated authorization** (endpoint has no authorize!, trusts the service)
- **D. Unauthenticated / token-equality / shared-secret entry points** (non-constant-time compare, replay)
- **E. Bulk/mass mutations without per-object authz**
- **F. SSRF / path-traversal / open-redirect via user-controlled URL/path**
- **G. Privileged actor substitution in workers / bots** (no re-authorization at execution)
- **H. Token scope / actor confusion** (granular tokens, job tokens, deploy tokens)

Each pattern is a `### <Letter>. <Name>` subsection with a short definition and a bullet list
of the affected features (with the specific lead in parentheses).

### `## Top single-target leads (start here)`

```markdown
| Rank | Feature | Lead | Pattern | Map |
|---:|---|---|---|---|
| 1 | <feature> | <one-line specific lead> | <A–H> | <slug>.md |
```

### `## Phase 2 ordering recommendation`

1. Resolve the Phase 1 blockers in `phase1_completion_gate.md` that gate authoritative checks.
2. Sweep patterns A → H as classes (compare siblings in `same_functionality_cross_feature_map.md`).
3. Drill the top single-target leads.

---

## `phase1_completion_gate.md`

Header: `# Phase 1 Completion Gate — Honest Verdict`, then the integrity rule: *completion
requires evidence, not confidence.*

### `## Verdict`
One honest paragraph: is Phase 1 substantially complete for feature mapping? Is the Inventory
Gate satisfied? State where coverage is incomplete.

### `## Gate checklist`
```markdown
| Requirement | Status | Evidence |
|---|---|---|
| Every feature has a Phase 1 feature map | ✅ Met / ⚠️ Partial / ❌ Not met | N/N files in features/ |
| Every feature has files mapped | ... | ... |
| Every feature has entry points mapped | ... | ... |
| Every feature has authorization points mapped | ... | ... |
| Every feature has same-functionality mapped | ... | ... |
| Every feature has Phase 2 priority assigned | ... | ... |
| Endpoint/Action ledger per route/method/mutation/worker | ... | M rows exist; ... |
| Every ledger row ≥ AuthZ Verified | ... | ... |
| High-risk rows Deep Complete | ... | ... |
| Every inventory item reconciled into 5 categories | ... | blocker INV-1 |
| Shared service/finder/serializer caller coverage | ... | ... |
| Relationship/list/count endpoints flagged for child authz | ... | pattern A |
| Role/actor catalog complete (anon → non-member → tiers → owner → admin → custom → bot/token) | ... | `roles/role-structure.md` |
| Role ladder documented, non-hierarchical roles flagged | ... | `roles/role-structure.md` |
| Ability alphabet enumerated + grouped by prefix | ... | N distinct abilities |
| Role→ability wiring pinned for every ability cited by a ledger row | ... | blocker ROLE-1; X/Y resolved |
| Token/non-human actors mapped to scopes + effective role | ... | pattern H |
```
(✅ Met / ⚠️ Partial / ❌ Not met — use honestly; most first passes have several ⚠️/❌.)

### `## Carried-forward Phase 1 blockers`
Bullet the named blockers that must close before Phase 2 fully relies on the maps, e.g.:
- **INV-1 — item-by-item inventory reconciliation not done** (cannot prove nothing dropped)
- **AUTHZ-1 — authoritative <VCS/native> authz untraced**
- **ROLE-1 — role→ability wiring not traced** (name the unresolved abilities; closes only when
  `roles/role-ability-matrix.md` has no `?` cells for abilities cited by ledger rows)
- **FINDER-1 — sole-boundary finder visibility SQL unverified**
- **EE-1 — large paid/EE surfaces discovered-only**
- **SERVICE-1 — service internals treated as post-authorization**
- **SERIALIZER-1 — field-level exposure largely unverified**

(Invent blockers from the actual gaps found; the codes are `<AREA>-N`.)

### `## Recommended next steps`
One workflow each: inventory-reconciliation pass; blocker-closing deep passes; paid/EE
deep-mapping pass; then Phase 2 driven by `phase2_review_queue.md`.

---

## The 5 reconciliation categories (used across the gate and inventory matrix)

Every inventory item must land in exactly one:
1. Mapped to a feature + ledger row
2. Shared infrastructure mapped to all consuming features
3. Not security-relevant (with reason)
4. Unclear → Phase 1 gap
5. Dead / not reachable (with evidence)

No inventory item may disappear silently. If a full item-by-item pass was not run, that is
blocker INV-1 — record it, do not pretend coverage.
