# Codengram — Specification

> **`docs/BLUEPRINT.md` is authoritative** for architecture and algorithms; this SPEC is the product-level summary.

Standalone, local-first, open-source app that reads any source repository and creates a persistent, visual, exportable **second brain** of the entire codebase. **Recon only — never vulnerability detection.**

Reuse:
- Recon methodology: `codebase-recon` (6-phase mapping).
- Output compatibility: `phase1-maps` artifact shape.
- Existing synchronized Claude Design React system for all UI.

## Product flow

Create project → **Snapshot repo with frozen source** (git-worktree pinned to SHA, or content-addressed copy for dirty/non-git) → Deterministic profiling + inventories → one persistent **Lead** Claude session → recon plan → deterministic plan validation → Lead spawns scoped **workers** → workers map non-overlapping workstreams into **`staging.sqlite`** (per attempt) → reconcile inventories + follow-ups → transactional merge into canonical **`index.sqlite`** → generate + integrity-validate `phase1-maps` on a temp path → **atomic seal** → publish visual brain → export for another AI session. Published snapshots are immutable; a re-scan makes a new one.

## Agent architecture

One persistent **Lead** session owns each mission and calls explicit backend tools:
`create_recon_plan, spawn_worker, list_workers, get_worker_status, send_worker_message, retry_workstream, cancel_worker, submit_followup, get_coverage, finalize_recon`.

`spawn_worker` is a **backend tool** — it validates scope, acquires a task lease, creates a separate Claude SDK session, and records its lifecycle. NOT native subagents. A project may have 30 planned workstreams but only 2–4 active workers; completed workers release slots.

## Recon planning

Lead receives deterministic repo facts (languages/frameworks, file/byte counts, est. source tokens, manifests/configs, entry points, top dirs, import graph, inventory counts, model context, quota/concurrency). It writes `phase1-maps/recon-plan.json` + `.md` (workstreams, owned files, shared context, inventory ownership, context estimates, session count, active concurrency, completion conditions).

**Reject** plans with: overlapping primary files, unowned source areas, missing inventory owners, paths outside the repo, duplicate IDs, or over-budget workstreams.

## Context-budgeted workers

`usable_context = model_context − prompt reserve − reasoning reserve − output reserve − shared-context reserve`. Session count is driven by **context size, not feature count**: `N = ceil(reviewable_tokens / usable_context)`.
**Repo fits in one usable context → `N = 1`: a single holistic worker maps the whole codebase, regardless of how many features were discovered.** Only an over-budget repo is sliced into several domain workers (GitLab-scale → many queued workstreams, controlled concurrency). Shared auth/policy/middleware/config replicated as **read-only shared context**. Oversized files → explicit **coverage blockers**, never silently truncated. Context budgets follow Anthropic's documented windows (200K default; 1M is a Sonnet-4 beta opt-in — never assumed).

## Six recon phases (from codebase-recon)

1. Scale & shape. 2. Architecture/processes/startup/IPC/stores/external services. 3. Domains/features/integrations/importers/subsystems. 4. AuthN/actors/roles/permissions/policies/tokens/OAuth/admin/2FA. 5. REST/GraphQL/gRPC/WebSocket/queues/webhooks/uploads/downloads/internal APIs/CLI. 6. Feature synthesis/data flows/trust boundaries/shared infra/gaps/future priorities.

## Canonical output

```
data/projects/<project-id>/snapshots/<snapshot-id>/
  snapshot.json
  source/            (frozen tree — git-worktree@SHA or content-addressed copy; provenance resolves here)
  source-manifest.jsonl
  index.sqlite       (canonical; staging.sqlite is transient, not part of the sealed set)
  phase1-maps/
    README.md  AI_CONTEXT.md  manifest.json  app-blueprint.md
    feature-queue.json  followup-features.jsonl  recon-plan.json
    inventories/  (00_MANIFEST.md, 01_routes_endpoints.txt, 02_rest_api.txt,
      03_graphql.txt, 04_workers_jobs.txt, 05_services_finders_policies.txt,
      06_response_shaping.txt, 07_downloads_uploads_exports.txt,
      08_search_aggregation.txt, 09_tokens_actors.txt, 10_processes_ipc.txt,
      11_datastores_integrations.txt)
    features/<feature-slug>.md
    graph/  (nodes.jsonl, edges.jsonl, aliases.json)
    consolidated/  (00_INDEX.md, feature_coverage_matrix.md,
      source_inventory_coverage_matrix.md, same_functionality_cross_feature_map.md,
      phase1_completion_gate.md, phase1_crosscheck_verification.md, phase2_review_queue.md)
```

`phase2_review_queue.md` contains review context + unverified leads only. It must **never** claim vulnerabilities.

## Feature document contract

Each feature Markdown has the **13 canonical sections** (BLUEPRINT §13c): Feature Identity, Feature Purpose, Entry Points, Endpoint/Action Ledger, Full Code Paths, Authorization Map, Authentication/Actor Context Map, Data Exposure Map, Background Job Map, Same-Functionality Map, **Review Context** *(recon-only rename of "Security-Sensitive Areas" — ranked unverified **leads**, never findings)*, Files Reviewed, Coverage Notes. **Every claim** carries snapshot, relative file, line range, confidence, and discovery method — resolved against the frozen `source/`.

## Knowledge graph

Nodes (22): `PROJECT, SNAPSHOT, DOMAIN, FILE, SYMBOL, PROCESS, FEATURE, ROUTE, ENDPOINT, GRAPHQL_OPERATION, JOB, SERVICE, MODEL, ROLE, PERMISSION, AUTH_CHECK, TOKEN, DATA_STORE, INTEGRATION, TRUST_BOUNDARY, DATA_FLOW, COVERAGE_GAP`. Rails-ish concepts map onto these, not new types: **concern/finder/module → `SERVICE` with `data.kind`**; **policy/before_action/guard/middleware/token → `AUTH_CHECK` with `data.kind`** (BLUEPRINT §13e; enforced in `packages/schemas`).
Edges (16): `CONTAINS, DEFINES, EXPOSES, HANDLED_BY, CALLS, READS, WRITES, ENQUEUES, AUTHENTICATED_BY, AUTHORIZED_BY, REQUIRES_ROLE, CROSSES_BOUNDARY, RETURNS_DATA, USES_SERVICE, USES_INTEGRATION, SHARES_IMPLEMENTATION_WITH`. Canonical direction is `{from, to}` (SQL columns `src`/`dst`).
**`index.sqlite` is the single canonical store; JSONL and Markdown are generated FROM it** — never the database. Workers write `staging.sqlite` per attempt; only a validated transactional merge reaches `index.sqlite`.

## Inventory reconciliation

Every inventory item ends terminal: `MAPPED_TO_FEATURE, SHARED_INFRASTRUCTURE, NOT_RELEVANT_WITH_REASON, UNCLEAR_COVERAGE_GAP, DEAD_OR_UNREACHABLE_WITH_EVIDENCE`. No item disappears silently. Estimated coverage is never labelled verified.

## Completion gate

Artifacts are generated + integrity-validated on a temp path **before** the atomic seal. Seal + publish (`PUBLISHED`) only when: all workstreams terminal · every feature mapped or explicitly blocked · every inventory item reconciled · every feature doc passes the 13-section schema · every graph claim has provenance · follow-ups reconciled · no active task lease · Markdown↔graph counts agree · cross-check passes · export manifest+checksums validate.
- **`COMPLETE_WITH_GAPS` = mapping gaps only** (unreconciled items, blocked features, oversized coverage-blockers) — it still seals and publishes, with the exact gap list.
- **An integrity failure is not a gap:** it never seals → `UNPUBLISHED` + mission `FAILED`, leaving the last good snapshot untouched. A broken generate can never replace a good snapshot.

## React UI (Claude Design)

Local-first React + TypeScript on the synchronized Claude Design system (reuse its components/tokens/icons; do not recreate). First screen is the working project interface (no marketing page). App shell: top bar (project switcher, snapshot selector, global brain search, recon status, refresh, export, settings), left nav (Brain, Features, Architecture, Identity, Interfaces, Data Flows, Coverage, Activity, Exports), main area (interactive **neural brain graph**), right inspector (node details/relationships/citations/actions), bottom activity strip. Semantic zoom L1–L5; query neighbourhoods on demand, ≤~1000 visible nodes; never render the full graph. UI state comes from **backend task state**, never inferred from logs.

## API surface (local server + SSE)

Projects/snapshots/refresh/diff · recon missions + `GET /events` (SSE) · brain nodes/neighbourhood/search · features/coverage/context · export/import. Every op requires `project_id` (+ `snapshot_id` where applicable).

## Portable export

Full / Portable / Feature-context. Always includes `AI_CONTEXT.md, README.md, manifest.json, features/*.md, graph/nodes.jsonl, graph/edges.jsonl, consolidated/*`. `AI_CONTEXT.md` lets a **fresh** Claude session understand the bundle with no conversation history and no UI.

## Acceptance criteria (headline)

Repo fits in context → one holistic worker (regardless of feature count). GitLab-scale → safe fanout + resume after interruption. Workers never overlap primary ownership. Rate limits pause/resume without state loss. Every inventory item terminal. Project switching never leaks context. Export works in a fresh Claude session. Incremental refresh updates only impacted knowledge. Deletion removes every generated artifact. Browser navigates ≥100k stored nodes via bounded neighbourhood queries. UI responsive + keyboard-accessible + fully on Claude Design. **Recon only — never vulnerability detection.**
