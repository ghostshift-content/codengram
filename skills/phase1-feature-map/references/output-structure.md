# Output Structure — `phase1-maps/`

The skill materializes a **directory**, not a single report. This exact layout is the
contract downstream Phase 2 review depends on. Reproduce it verbatim for any codebase.

```
phase1-maps/
├── README.md                     <- target, version, method, depth-status meaning, feature queue
├── inventories/                  <- OBJECT axis: source-of-truth inventories (scripted enumeration)
│   ├── 00_MANIFEST.md            <- index + counts + 5-category reconciliation rule
│   └── 01..09_*.txt              <- raw `rg -n` inventory data (file:line:content, one `# header` per file)
├── roles/                        <- SUBJECT axis: who can act (see references/role-model.md)
│   ├── role-structure.md         <- actor catalog, ladder, ability alphabet, tokens, sudo/2FA, source of truth
│   ├── role-ability-matrix.md    <- role → ability matrix (closes blocker ROLE-1)
│   ├── role_authz_source_files.txt
│   └── role_structure_hints.txt
├── features/                     <- one Phase 1 feature map per feature
│   └── <slug>.md                 <- see references/feature-map-template.md
└── consolidated/                 <- cross-feature matrices + Phase 1 completion gate
    ├── 00_INDEX.md
    ├── feature_coverage_matrix.md
    ├── source_inventory_coverage_matrix.md
    ├── same_functionality_cross_feature_map.md
    ├── phase2_review_queue.md
    └── phase1_completion_gate.md
```

Default output location: `<repo-root>/phase1-maps/` (or a path the user names).

---

## README.md contents (write this file first, update at the end)

1. Title: `# <Project> White-Box Security Assessment — Phase 1 Artifacts`
2. `Target:` absolute path + version string (from manifest/CHANGELOG if present).
3. One line: *"This is **mapping, not vulnerability hunting**. No exploit work occurs in Phase 1."*
4. `## Directory layout` — the tree above.
5. `## Method` — 3 steps: **Inventories** (scripted enumeration; note if the app could not
   boot so routes are source-parsed), **Feature mapping** (one pass/agent per feature builds
   its Endpoint/Action Ledger and traces auth/actor/object-lookup/serializer/worker),
   **Consolidation** (matrices + completion gate aggregated from the feature maps).
6. `## Depth-status meaning` — the ladder table (Discovered→Deep Complete + "Phase 2 can rely?").
7. `## Feature queue (N)` — the full flat list of every feature slug discovered.

---

## The 21 required consolidated outputs (`consolidated/00_INDEX.md`)

Every one of these must be produced or explicitly accounted for. `00_INDEX.md` maps each to
its artifact so nothing is silently missing:

| # | Required output | Where it lives |
|---|---|---|
| 1 | Application architecture overview | `../README.md` + per-feature "Feature Purpose/Identity" |
| 2 | Feature coverage matrix | `feature_coverage_matrix.md` |
| 3 | File-to-feature map | per-feature "Files Reviewed" tables |
| 4 | Entry-point-to-feature map | per-feature "Entry Points" tables |
| 5 | Authorization map | per-feature "Authorization Map" + queue pattern B |
| 6 | Authentication/actor map | per-feature "Authentication / Actor Context Map" + queue patterns D,G,H |
| 7 | API map | inventory `02_rest_api.txt` + per-feature REST tables |
| 8 | GraphQL map | inventory `03a/03b` + per-feature GraphQL tables |
| 9 | Worker/background job map | inventory `04a/04b` + per-feature "Background Job Map" |
| 10 | Serializer/entity/presenter map | inventory `06` + per-feature "Data Exposure Map" |
| 11 | Search/export/download map | inventories `07`,`08` + queue pattern F |
| 12 | Token flow map | inventory `09` + queue pattern H |
| 13 | Same-functionality cross-feature map | `same_functionality_cross_feature_map.md` |
| 14 | Shared infrastructure map | `same_functionality_cross_feature_map.md` (clusters table) |
| 15 | Unmapped files/directories | `phase1_completion_gate.md` blockers + per-feature Coverage Notes |
| 16 | Phase 2 review queue | `phase2_review_queue.md` |
| 17 | Source inventory coverage matrix | `source_inventory_coverage_matrix.md` |
| 18 | Endpoint/action ledger (all routes/methods/mutations/workers) | per-feature "Endpoint / Action Ledger" tables (report total row count) |
| 19 | Role / actor catalog + role ladder | `../roles/role-structure.md` |
| 20 | Role → ability matrix (which role enables which permission, with wiring) | `../roles/role-ability-matrix.md` |
| 21 | Token / non-human actor map (scopes → actor) | `../roles/role-structure.md` (token actors table) + queue pattern H |

## Reading order for Phase 2 (put this at the bottom of 00_INDEX.md)

1. `phase1_completion_gate.md` — what's solid, what's a blocker.
2. `phase2_review_queue.md` — ranked leads + access-control patterns A–H.
3. `same_functionality_cross_feature_map.md` — review siblings as classes.
4. `../features/<slug>.md` — the trace + Endpoint/Action Ledger for any lead.
