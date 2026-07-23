---
name: phase1-feature-map
description: |
  Deep white-box security mapping of any source tree, producing a fixed `phase1-maps/` artifact
  directory: scripted inventories, one Phase 1 feature map per feature (Endpoint/Action Ledger,
  authorization map, auth/actor map, data-exposure map, background-job map, same-functionality
  map, ranked Phase 2 leads, honest coverage/depth), and consolidated cross-feature matrices +
  a completion gate. This is MAPPING, not vulnerability hunting — it produces leads for a later
  access-control (Phase 2) review, in an identical shape every time regardless of language or
  size. Use when handed a codebase to review, or the user says "review this codebase", "map this
  project", "phase 1", "feature map", "recon before security review", "white-box map", "build the
  phase1-maps", "attack-surface map", or "prep for access-control review". Works for any stack —
  Ruby/Rails, Python (Django/Flask/FastAPI), Node (Express/Nest), Go, Java/Spring, Rust, .NET/C#,
  PHP/Laravel, Elixir/Phoenix. Output is byte-shape-compatible with the reference `phase1-maps/`.
license: MIT
---

# phase1-feature-map

The consistency is the point. For **any** source tree, this skill runs one methodology and emits
one output shape — the `phase1-maps/` directory — so every review starts from an identical,
exhaustive, honestly-graded map. Miss no feature; grade every claim honestly; cite `file:line`.

## One-prompt invocation (run it, don't interview)

Triggered by the `/recon` command or any natural-language ask ("map this codebase", "start the
recon", "build the phase1-maps"). On invocation, **just start** — do not ask clarifying questions
unless the source path does not exist:

1. Resolve the target: the path in the prompt, else the current working directory. If the prompt
   names an output dir (after `→` or "to"), use it; else `<source>/phase1-maps/`.
2. Run Stages A → E below to completion, parallelizing per the scale rules.
3. End with the `phase1-maps/` path + the one-paragraph summary.

The only stop is a missing/unreadable source path, or a genuine scope change. Everything else is
reversible, static, read-only work — proceed autonomously.

## Inputs

- **Source code root** — the tree to map. Default: current working directory.
- **Output directory** — default `<repo-root>/phase1-maps/`, or a path the user names.
- Optional scope hint ("only the API", "ignore frontend").

## Output — a fixed directory (never a single report)

```
phase1-maps/
├── README.md                     target, version, method, depth-status meaning, feature queue
├── inventories/                  OBJECT axis — 00_MANIFEST.md + 01..09_*.txt (scripted rg enumeration)
├── roles/                        SUBJECT axis — role-structure.md, role-ability-matrix.md,
│                                   role_authz_source_files.txt, role_structure_hints.txt
├── features/<slug>.md            one Phase 1 feature map per feature
└── consolidated/                 00_INDEX.md, feature_coverage_matrix.md,
                                   source_inventory_coverage_matrix.md,
                                   same_functionality_cross_feature_map.md,
                                   phase2_review_queue.md, phase1_completion_gate.md
```

Access control is **subject × object**: `inventories/` maps what surfaces exist, `roles/` maps who
can act, and each feature's Authorization Map is the intersection. Exact layout, the 21 required
outputs, and the README/INDEX templates: [`references/output-structure.md`](references/output-structure.md).

## Process — a 5-stage pipeline

Load each reference as you reach its stage (progressive disclosure). Full detail and the
phase→pipeline mapping: [`references/methodology.md`](references/methodology.md).

| Stage | Goal | Reference | Writes |
|---|---|---|---|
| **A. Detect & Scale** | Stack, counts, entrypoints, processes, IPC, datastores (recon phases 1–2; inline, ≤5 min) | [`enumeration-by-language.md`](references/enumeration-by-language.md) Step 0 | `README.md` skeleton |
| **B. Inventories** | 9 source-of-truth inventories for this stack | [`inventory-manifest.md`](references/inventory-manifest.md) + [`enumeration-by-language.md`](references/enumeration-by-language.md) | `inventories/*.txt` + `00_MANIFEST.md` |
| **C. Roles & feature discovery** | Build the full role/actor model + role→ability matrix; derive the feature queue (domain map) | [`role-model.md`](references/role-model.md) + [`methodology.md`](references/methodology.md) Stage C | `roles/*` + the feature list |
| **D. Per-feature mapping** | One complete feature map per feature | [`feature-map-template.md`](references/feature-map-template.md) | `features/<slug>.md` ×N |
| **E. Consolidation** | Cross-feature matrices, review queue, completion gate | [`consolidated-templates.md`](references/consolidated-templates.md) | `consolidated/*.md` |

Optional helper: [`scripts/build-inventories.sh <repo-root>`](scripts/build-inventories.sh)
scaffolds the tree and runs the universal (cross-stack) inventories 07/08/09; run the
stack-specific block for 01–06 from the enumeration reference.

## Critical operating rules (the value — do not skip)

- **Numerical-first, `file:line` everywhere, read-don't-run, static-only.** Exact counts, never
  "many". No `bundle install`/`npm install`/booting/live `routes`; parse route source instead.
- **Honest depth ladder** per Endpoint/Action Ledger row: Discovered → Mapped → Traced → AuthZ
  Verified → Deep Complete. Most first-pass rows are Traced or below — say so. "GAP" is required.
- **No inventory item disappears silently** — each reconciles into one of 5 categories or becomes
  blocker INV-1.
- **No-sampling on shared code** — a check verified in one caller does not clear its siblings.
- **Mapping, not hunting** — produce leads (patterns A–H), never findings; no exploit work.
- **Every discovered feature gets a complete map.** A section is never dropped; if a surface is
  absent, keep the heading and write `None — <reason>`.

## Parallelize at scale

< ~500 files / < ~10 features → inline. 500–5,000 → one subagent per feature for Stage D.
> 5,000 → scope each agent to directories. Stage A and Stage E are always main-thread. With the
Workflow tool: `pipeline(features, mapOneFeature)` then synthesize Stage E from the results. See
[`methodology.md`](references/methodology.md) → Parallelization.

## Completion gate (evidence, not confidence)

Done only when: README with exact scale numbers; all 9 inventories + manifest; `roles/` with the
actor catalog, role ladder, ability alphabet and role→ability matrix; every discovered feature has
a complete `features/<slug>.md` with a populated Endpoint/Action Ledger; all 6
consolidated files; the 21 outputs in `00_INDEX.md` each produced or accounted for; and
`phase1_completion_gate.md` states an honest verdict with every gap recorded as a named blocker.
Fill the gate checklist honestly — most first passes carry several ⚠️/❌.

## What this skill does NOT do

- Does not run vulnerability detection or exploits — it produces the Phase 2 lead queue.
- Does not modify the target code, run it, or install anything — read-only, static.
- Does not invent coverage — empty surfaces are stated as `None`/`N/A`, gaps as blockers.

## After it completes

Deliver the `phase1-maps/` path and a one-paragraph summary: N features mapped, M ledger rows,
coverage split, top blockers, and the first patterns/leads from `phase2_review_queue.md`. Then
Phase 2 (access-control review) can start from that queue — it is out of scope here.
