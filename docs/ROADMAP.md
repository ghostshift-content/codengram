# Codengram — Build Roadmap

> **`docs/BLUEPRINT.md` is authoritative.** This file is the milestone order in brief; BLUEPRINT §8 is the source of truth.

Build order (each milestone shippable; deterministic core → SQLite graph → renderer → AI → UI):

1. **Projects + immutable snapshots w/ frozen source** — create/select/switch; snapshot = git-worktree pinned to SHA (or content-addressed copy for dirty/non-git); delete removes only generated `data/`, never source; provenance resolves against the frozen `source/`. → `packages/ingestion`
2. **Inventories + parsers + the plugin contract** — languages/frameworks, file/byte counts, est. tokens, entry points, the 11 deterministic inventories — all via the plugin registry (nothing hardcoded). → `packages/profiler`, `packages/inventories`, `packages/parsers`, `packages/plugins`
3. **Minimal SQLite graph writer** — migrations, stable ids, `staging.sqlite` per-attempt + transactional merge into `index.sqlite`; re-run updates in place. → `packages/graph`
4. **`phase1-maps` renderer FROM SQLite** — the canonical artifact tree generated from the graph; Markdown↔graph counts must agree. → `packages/markdown-renderer`
5. **Lead session + validated recon plan** — persistent lead on the Agent SDK; `create_recon_plan`; paginated inventory tools (`get_inventory_page`/`get_domain_summary`/`search_inventory`); deterministic plan validator (reject overlap/unowned/over-budget); mission rehydrates after restart. → `packages/recon`, `packages/planner`, `packages/claude-runtime`
6. **Worker fanout, leases, resume, follow-ups + staging** — `spawn_worker` backend tool, task board, context budgeting, 2–4 active of N; a failed attempt stays in `staging.sqlite`, never contaminating `index.sqlite`. → `packages/task-board`, `packages/claude-runtime`
7. **Six-phase recon + reconciliation + completion gate + seal** — every inventory item terminal; generate+validate temp artifacts BEFORE the atomic seal; COMPLETE / COMPLETE_WITH_GAPS (mapping gaps only). → `packages/recon`
8. **Knowledge-graph search / retrieval** — bounded neighbourhood queries; `get_context_bundle`; read-only tools. → `packages/retrieval`
9. **React app shell (Organic / Claude Design).** → `apps/web`
10. **Brain canvas + inspector** (Sigma adapter; semantic zoom; ≤~1000 visible nodes; citations; Ask).
11. **Live session/task/coverage views** (SSE; state from backend task state, not logs).
12. **Export / import / AI context tools.**
13. **Incremental refresh + snapshot comparison** (new snapshot; updates only impacted nodes via stable ids).
14. **Public plugin SDK, fixtures, contributor docs.**
15. **GitLab-scale performance + recovery testing** (≥100k nodes navigable; resume after interruption; no state loss).

## Current turn: milestones 1–4 (deterministic foundation)

A working `codengram scan <repo>` that produces a real **frozen** snapshot + profile + 11 inventories written into `index.sqlite`, then rendered to a `phase1-maps` skeleton — no Claude, no UI. Everything downstream reasons over the sealed graph.

## Reuse from ARCHON (copy pure primitives, keep repos separate — both MIT)

- Profiler / context-budget math (`src/runtime/profiler.js`) → `packages/profiler`.
- Workstream planner + file-locality slicing (`src/runtime/workstream-planner.js`) → `packages/planner`.
- Task lifecycle + leases (`src/runtime/task-state.js`, mission-workspace) → `packages/task-board`.
- Knowledge-graph node/edge model (`src/intel/knowledge-graph.js`) → `packages/graph`.
- Mapping-ledger / completion-gate discipline → `packages/recon`.

**Never import across repos** — copy + adapt the pure modules so Codengram is standalone.

## Hard invariants

- Recon only. No vulnerability detection, ever (enforced in prompts + a lint check).
- **`index.sqlite` is canonical; Markdown + JSONL are generated FROM it**, never the store.
- Snapshots are immutable with **frozen source**; a re-scan makes a new snapshot.
- Artifacts are generated + integrity-validated on a temp path **before** the atomic seal; a bad generate never replaces a good snapshot.
- Every claim carries provenance (snapshot + file + line range + confidence + method).
- UI state derives from backend task state, never parsed from logs.
- Source code is read-only; deletion removes only generated `data/`.
