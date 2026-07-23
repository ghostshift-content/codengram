# Methodology — recon discipline & the phase→pipeline mapping

The output (`phase1-maps/`) is produced by a 3-stage pipeline. The 6 recon phases feed it.
This file is the *how*: the operating rules, how features are discovered, how work is
parallelized, and how the consolidation is synthesized.

## Operating rules (non-negotiable — they are the value)

1. **Numerical-first.** Counts before prose. "903 controllers, 2,290 models, 3,118 services"
   *before* "large Rails monolith." Exact numbers, never "many"/"approximately".
2. **Cite `file:line` for every claim.** Never paraphrase what the code does without pointing
   at where. Quote it or cite its location.
3. **Read, don't run.** Static only. No `bundle install`, `npm install`, booting servers, or
   live `routes`. If a fact needs runtime, mark it "runtime-only" and move on.
4. **Stop expanding when patterns repeat.** After ~40 files in a directory you've seen the
   pattern — sample, give the count, move on. Enumerate surfaces, not every instance.
5. **Honest depth, never inflated.** Use the depth ladder (Discovered→Mapped→Traced→AuthZ
   Verified→Deep Complete). Most first-pass rows are Traced or below. Say so. "GAP"/"not read"
   is a required, respected value.
6. **No inventory item disappears silently.** Everything reconciles into one of the 5
   categories or is recorded as blocker INV-1.
7. **No-sampling on shared code.** A check verified in one caller does NOT clear its siblings.
   Every consumer of a shared service/finder/policy is verified per-caller.
8. **Mapping, not vulnerability hunting.** Phase 1 produces leads, never findings. No exploit
   work. Downstream Phase 2 verifies each lead against source.

## The 3-stage pipeline (what actually gets written)

```
Stage A — Detect & Scale        →  README.md skeleton (recon phases 1–2)
Stage B — Inventories           →  inventories/*.txt + 00_MANIFEST.md (recon phase 5 enum)
                                   [OBJECT axis: what surfaces exist]
Stage C — Roles & features      →  roles/* (role model, ladder, role→ability matrix, tokens)
                                   + the feature queue (recon phase 4 auth + phase 3 domain map)
                                   [SUBJECT axis: who can act]
Stage D — Per-feature mapping   →  features/<slug>.md ×N (one agent per feature)
                                   [the intersection: subject × object]
Stage E — Consolidation         →  consolidated/*.md + completion gate (recon phase 6)
```

### Stage A — Detect & Scale (recon phases 1–2; always inline, ≤5 min)
Detect stack, count files/dirs/language-mix, find entrypoints, read `docker-compose.yml` +
init files, map processes / IPC / datastores / external services / edition overlay. This
produces the scale headline and the `README.md` (`enumeration-by-language.md` Step 0).

### Stage B — Inventories (recon phase 5, generalized)
Run the stack block from `enumeration-by-language.md` + the cross-stack meaning-based greps to
produce the 9 `inventories/*.txt` and `00_MANIFEST.md` (`inventory-manifest.md`).

### Stage C — Roles & feature discovery (recon phases 4 + 3)

**Roles first (the subject axis).** Build `roles/` in full per
[`role-model.md`](role-model.md): the actor catalog (anonymous → non-member → each membership
tier → owner → instance admin → custom role → bot/token actors → impersonated), the role ladder
with hierarchical/non-hierarchical marked, the ability/permission alphabet grouped by prefix, the
**role→ability matrix with wiring cited**, token actors + scopes, sudo/admin mode, impersonation
and 2FA. Do this **once, before feature mapping**, so all N feature maps cite it instead of
re-deriving roles N times — and so blocker ROLE-1 can actually close.

**Domain map → feature queue.** Some projects encode their domain map as data (feature-category
YAML, bounded-context dirs, feature docs). If present, read it — it's the official feature list.
If absent, **the top-level controller/service/route directories ARE the feature list**. Each
becomes one `features/<slug>.md`. Aim for ≥10 features on any non-trivial app; GitLab-scale had 43.

### Stage D — Per-feature mapping (the bulk)
One pass (or one subagent) per feature. It greps the inventories scoped to the feature's
keywords/paths, reads the live code, and fills `feature-map-template.md` end to end: entry
points (web/REST/GraphQL/workers/other), Files Reviewed, the Endpoint/Action Ledger (one row
per route+method / mutation / worker / action with honest depth), full code-path traces for
the highest-value flows, authorization map, auth/actor map, data-exposure map, background-job
map, same-functionality map, ranked Phase-2 leads, and coverage notes.

### Stage E — Consolidation (recon phase 6; always inline / main thread)
Aggregate the feature maps into the 6 `consolidated/*.md` (`consolidated-templates.md`):
coverage matrix (Y-grid + ledger-row counts + priority + top gap), source-inventory coverage
matrix (with the honesty statement), same-functionality cross-feature clusters, the Phase 2
review queue (patterns A–H + top single-target leads), the completion gate (honest verdict +
checklist + carried-forward blockers), and `00_INDEX.md`.

## Parallelization (scale-driven)

| Codebase size | Strategy |
|---|---|
| < ~500 source files / < ~10 features | Inline: map each feature sequentially |
| 500–5,000 files | Fan out Stage D — one `Explore`/subagent per feature, dispatched together |
| > 5,000 files | Fan out + scope each agent to directories (e.g. `app/` vs `ee/`) |
| > 100,000 files | Recurse: pick top services, map each, then meta-consolidate |

Rules: **Stage A always inline** (its metrics decide whether to parallelize). **Stage E always
inline / main-thread** (only it has all feature outputs). Stages B and D parallelize. Each
subagent prompt is **self-contained** — include repo root, the feature's keywords/paths, the
inventories path, the `feature-map-template.md` shape, the `file:line` citation requirement,
and a target length. Never make one agent depend on another's output; never ask a subagent to
write the final consolidation. If a subagent result is large (>50KB) it is file-persisted —
pull it in with targeted `Read` offset/limit and quote the tables directly.

**With the Workflow tool** (preferred at scale): `pipeline(features, mapOneFeature)` for Stage
D, then synthesize Stage E on the main thread from the returned maps. One agent per feature;
cap and log any features dropped.

## Access-control pattern taxonomy (A–H) — the review lenses

Every feature map's ranked leads roll up into these classes in `phase2_review_queue.md`.
Watch for them while mapping; they are where the bugs live:

- **A** Parent-only authz on child/relationship/list endpoints (IDOR / cross-tenant leak)
- **B** Declared route/token permission ≠ enforced ability (REST vs Web vs GraphQL divergence)
- **C** Service-delegated authz (endpoint has no `authorize!`, trusts the service)
- **D** Unauthenticated / token-equality / shared-secret entry points (non-constant-time, replay)
- **E** Bulk / mass mutations without per-object authz
- **F** SSRF / path-traversal / open-redirect via user-controlled URL/path
- **G** Privileged actor substitution in workers/bots (no re-auth at execution)
- **H** Token scope / actor confusion (granular tokens, job tokens, deploy tokens)

## Trust-boundary synthesis (recon phase 6, embedded)

The consolidation is the phase1-maps analogue of the concentric trust-boundary map. The
same-functionality clusters + patterns A–H + the completion-gate blockers ARE the review map.
If the target is small or you also want the classic single-report artifact, the layered map
(outer→inner) is: 1 public web · 2 authed web UI · 3 REST/GraphQL API · 4 async/queue · 5 IPC
perimeter · 6 subprocess sinks · 7 importers/extraction · 8 crypto/token boundary ·
9 replication/multi-region (if any) · 10 multi-tenant boundary (if any). Each layer names its
components and its bug classes. Adjust layer count to what the project actually has.

## Completion integrity

Completion requires **evidence, not confidence**. Before declaring Phase 1 done, the gate
checklist in `phase1_completion_gate.md` must be filled honestly — most first passes show
several ⚠️/❌ (ledger rows below AuthZ Verified, inventory not item-reconciled, paid/EE
surfaces discovered-only). Record every gap as a named blocker (`<AREA>-N`) with a
closing-workflow recommendation. Never mark ✅ Met without the evidence to back it.

## Stop condition

Done when: README with scale numbers exists; all 9 inventories + manifest exist; `roles/` holds
the actor catalog, role ladder, ability alphabet and role→ability matrix; every discovered
feature has a complete `features/<slug>.md` with a populated Endpoint/Action Ledger; all 6
consolidated files exist; the 21 required outputs in `00_INDEX.md` are each produced or
explicitly accounted for; and the completion gate states an honest verdict with blockers. If a
section is genuinely empty (the app lacks that surface), say so explicitly — don't invent.
