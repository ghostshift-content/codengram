# Codengram — Build Blueprint (v2)

> Understand a codebase once. Remember it forever.
> A local-first, open-source tool that reads any repo and builds a persistent, visual, exportable **second brain** — **recon only, never vulnerability detection.**

Authoritative "how we build it" doc. v2 resolves the architecture review (frozen source, milestone order, session persistence, worker staging, state machines, canonical contracts, plugin timing, security). Companion docs: [SPEC.md](SPEC.md), [ROADMAP.md](ROADMAP.md).

**Foundational decision:** the **entire AI runtime is the Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — the Lead session, every worker session, and every ask session run as Agent-SDK sessions with tools, streaming, and resume. **Codengram runs locally through the Agent SDK using the user's existing official Claude Code subscription authentication. Codengram does not implement authentication or handle credentials** (see §2a). We never hand-roll the agent loop.

---

## 0. Design — LOCKED

- **System:** **Organic** (the user's Claude Design system) — cream `#f5ead8` / surface `#ebddc5` / ink `#201e1d`, terracotta `#c67139`, sage `#7a8a5e`, full ramps; Caprasimo/Figtree; pill radii; `styles.css` tokens + classes (`.btn/.card/.tag/.input/.table/.seg/.nav`). Never recreate its parts. Lucide @2.75.
- **Semantic layer (ours):** `--ok` sage, `--active` accent, `--gap` amber `#c98a2f`, `--stale` neutral. **Color = node family; ring/line-style = status.** Light + warm-espresso dark; `data-theme` wins over `prefers-color-scheme`.
- **Frozen prototype:** `design/codengram.html` (artifact `b7b91c46…`). Screens: Projects (+empty), New project (source → snapshot → deterministic Profile & plan), Live recon (graph builds, Lead + workers, 6 phases, coverage, completion gate), project shell (top bar · left nav · main · activity strip), Brain (radial graph + node inspector w/ citations + Ask Claude), and the 8 nav views. **Left nav exists only inside a project.** UI state comes from **backend task state, never logs.**

---

## 1. Architecture in one picture

Claude is used in **two modes** — the core idea:

```
  RECON-TIME (expensive, WRITE — once per snapshot)          ASK-TIME (cheap, READ — every view / question)
  repo → FROZEN snapshot → profile + inventories             bounded neighbourhood query → context packer →
       → Lead (Agent SDK) plans → validated plan                 short Agent-SDK Q&A session (read-only tools) →
       → workers (Agent SDK, 2–4 of N) map slices                cited answer.  Export = the SAME packer, portable.
       → STAGING claims → validate → reconcile →
         transactional MERGE → completion gate → SEAL
       → knowledge graph (SQLite) + generated Markdown/JSONL
                         │ persists (immutable, sealed)
                         ▼
              THE BRAIN — index.sqlite (canonical) + JSONL/Markdown (generated)
                         ▲ bounded reads
```

Recon **writes once**; every view and every "Ask Claude" is a **cheap grounded read**. That is why a 100k-node brain answers about one feature instantly, and why an exported bundle works in a fresh Claude session with no UI.

---

## 2. Tech stack (decided)

| Concern | Choice | Notes |
|---|---|---|
| Language | **TypeScript** (Node ≥18, ESM) | one language across server, packages, web |
| Monorepo | pnpm workspaces | `apps/*`, `packages/*` |
| **AI runtime** | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) | **all** Claude use — Lead, workers, ask. Tools, streaming, `resume`. **Inherits the local Claude Code subscription auth — no credential handling** (see §2a). |
| Store | **SQLite** (`better-sqlite3`) + generated **JSONL/Markdown** | `index.sqlite` = canonical; JSONL/Markdown generated for portability |
| Frozen source | git worktree (pinned commit) or content-addressed copy | see §4 — immutability of provenance depends on this |
| Server | Node HTTP + **SSE** (tiny router) | local-first; streams mission + ask events |
| Web | **React + Vite + TS** on **Organic** | rebuilds the locked screens 1:1 |
| Graph render | **Sigma.js (WebGL)** behind a `BrainCanvas` adapter | 100k-node scale, bounded neighbourhoods, swappable |
| Parsing | tree-sitter per language + regex inventories | symbols/imports where available; grep-grade elsewhere |
| Tests | `node --test` + Playwright (web smoke) | dependency-light |

---

## 2a. Authentication — local Claude subscription only

Codengram runs locally through the Claude Agent SDK using the user's **existing official Claude Code subscription authentication**. **Codengram does not implement authentication or handle credentials.**

**Prerequisites (the user sets these up once, outside Codengram):**
- Claude Code installed.
- Authenticated via the official `claude` → `/login` flow.
- A Pro, Max, Team, or Enterprise subscription.

**Codengram:**
- Uses `@anthropic-ai/claude-agent-sdk`.
- **Inherits** the official local Claude Code credentials (the SDK resolves them; e.g. `CLAUDE_CODE_OAUTH_TOKEN` / the Claude Code login).
- **Never** implements its own OAuth / "Sign in with Claude" login.
- **Never** reads, copies, exports, logs, or stores OAuth tokens.
- **Never** inspects the macOS Keychain or `~/.claude/.credentials.json`.
- **Never** asks the user for an API key.
- **Never** passes credentials between users or machines.
- Runs entirely on the authenticated user's **local** machine.

Let the Agent SDK and Claude Code **own authentication end to end.**

**UI — connection state (read-only, no login button).** The app surfaces only whether the SDK can reach a working local session:
```
Claude connection
✓ Connected through local Claude subscription
```
or
```
Claude login required
Run `claude`, then `/login`, and retry.
```
Detection is a lightweight SDK capability check — never by reading a credential file.

**Release risk / non-goal.** Anthropic's current legal guidance says third-party products should not offer Claude.ai login or route subscription credentials for users, even though the docs also describe subscription usage with the Agent SDK. Therefore Codengram **stays a local, user-operated, open-source tool — not a hosted service** — and we will **obtain confirmation from Anthropic before advertising subscription auth as an officially supported third-party integration.** Refs: [authentication](https://code.claude.com/docs/en/authentication) · [sessions](https://code.claude.com/docs/en/agent-sdk/sessions) · [agent-sdk overview](https://code.claude.com/docs/en/agent-sdk/overview) · [legal & compliance](https://code.claude.com/docs/en/legal-and-compliance).

---

## 3. Monorepo map

```
apps/
  web/                 React + Vite + Organic; SSE client; typed API client
  server/              local HTTP + SSE; API surface; owns the Claude Agent SDK integration (auth delegated, §2a)
packages/
  schemas/    ✅       canonical types, stable ids, provenance policy, 3 state machines, versions
  profiler/   ✅       deterministic repo facts + context budget
  ingestion/          projects + IMMUTABLE snapshots incl. a FROZEN source tree; source-manifest; delete
  plugins/            the plugin CONTRACT + registry (defined at M2, public SDK later)  ← §9
  parsers/            tree-sitter adapters → symbols, imports, dependency graph (plugin impls)
  inventories/        deterministic language-aware inventories (plugin impls)
  graph/              SQLite writer (migrations, stable ids), staging + transactional merge, neighbourhood/search
  markdown-renderer/  render phase1-maps/* FROM SQLite (Markdown is generated, never the store)
  planner/            recon-plan generation + deterministic validator + file-locality/context slicing (ex-ARCHON)
  task-board/         durable task lifecycle + leases (2–4 active of N), retry/resume, quota pause
  claude-runtime/     Lead/worker/ask Agent-SDK sessions; persisted mission/session/message/tool_call/event model;
                      the Lead's tool implementations. Auth is delegated end-to-end to the local Claude Code
                      subscription via the Agent SDK — no credential handling, no API-key path (§2a)
  recon/              six-phase orchestration + reconciliation + completion gate + seal
  retrieval/          context-bundle packer (Ask + export); read-only AI tools
fixtures/             sample repos (small → GitLab-scale)
```

Reuse from ARCHON (copy pure modules — both MIT, **never import across repos**): `profiler` (done), `planner` (slicing/oversized/budget), `task-board` (leases/terminal states), `graph` node/edge model, `recon` completion-gate discipline.

---

## 4. Data model + storage

### 4a. Snapshot = frozen facts **and** frozen source  ← review #1
A snapshot is immutable, so its **source must be frozen too** — provenance `file:line` is meaningless if the working tree moves under us. On snapshot:
- **Git repo, clean commit:** create a **git worktree pinned to the commit SHA** (or `git archive` extract) into the snapshot dir — read-only.
- **Dirty tree / non-Git:** **content-addressed copy** — hash every file (sha256), copy into `source/` keyed by hash, record the tree hash. Read-only.
Provenance always resolves against `snapshots/<id>/source/`, never the live repo. A snapshot never re-reads the working tree.

```
data/projects/<project-id>/
  project.json
  snapshots/<snapshot-id>/
    snapshot.json            # {git_sha|tree_hash, source_kind:'worktree'|'cas', created_at, profile, schema_version,
                             #  exporter_version, publication:'UNPUBLISHED'|'COMPLETE'|'COMPLETE_WITH_GAPS', sealed_at}
    source/                  # FROZEN, read-only source tree (worktree or content-addressed copy)
    source-manifest.jsonl    # { path, bytes, sha, lang }
    index.sqlite             # THE graph — canonical (nodes, edges, provenance/claims, inventory, tasks, mission…)
    staging.sqlite           # per-attempt worker output, pre-merge (auditable, never published)  ← review #4
    phase1-maps/             # GENERATED from index.sqlite AFTER seal (inventories/, features/*.md, graph/*.jsonl, consolidated/*, AI_CONTEXT.md, manifest.json)
```

### 4b. Canonical contracts (single source of truth)  ← review #6, #8
Defined in `packages/schemas` (implemented, tested). Everything — SQL, JSONL, API, TS — derives from it:
- **Edges are `{ from, to }`** everywhere; SQLite columns are `src`/`dst` (SQLite reserves `from`), mapped by `EDGE_SQL_MAP = {from→src, to→dst}` in the graph package only.
- **Confidence is `high | medium | low`** (never `med`).
- **Stable, deterministic ids:** `project:<slug>`, `snapshot:<hash>`, `file:<normPath>`, `symbol:<path>#<qname>`, `endpoint:<METHOD>:<normRoute>`, `feature:<domain-slug>`, `role:<slug>`. Same input ⇒ same id — the basis for incremental refresh and diff.
- **Versioning:** `SCHEMA_VERSION`, `EXPORTER_VERSION`; the graph package ships numbered SQLite **migrations**; exports carry both versions with compatibility rules.

### 4c. Provenance — grounded, per-field  ← review #7
`provenance()` + `claim()` in schemas. A **line-anchored** method (`grep`/`ast`/`symbol-index`) **must** carry a real line range; a **repo/generated** method (`manifest`/`config`/`repo-level`/`generated`) may omit it but must declare the method — **never a fabricated line number**. A `claim` record ties one provenance to the exact `node_id`/`edge_id` **and `field`** it substantiates, so "every claim" means every structured fact, not just the node.

### 4d. Three separate state machines  ← review #5
In schemas, guarded transitions:
- **Mission:** `QUEUED → PROFILING → PLANNING → RUNNING → RECONCILING → COMPLETED` (+ `PAUSED_QUOTA`, `CANCELLING/CANCELLED`, `FAILED`).
- **Task:** `QUEUED → CLAIMED → RUNNING → COMPLETED` (+ `RETRY_WAIT`, `PAUSED`, `FAILED`, `CANCELLED`, `BLOCKED`).
- **Publication (per snapshot):** `UNPUBLISHED → COMPLETE | COMPLETE_WITH_GAPS`.
`PAUSED_QUOTA` is a **mission** state, not a publication result.

### 4e. Persisted Lead/mission model — rehydrate, don't keep-alive  ← review #3
"Persistent Lead session" ≠ one live process. It is **persisted state we can rehydrate** after any restart:
```sql
missions(id, project_id, snapshot_id, state, plan_version, last_event_seq, planning_cursor JSON, created_at, updated_at)
         -- planning_cursor = per-inventory-kind pagination offset, so a rehydrated Lead resumes mid-inventory (§14.2)
sessions(id, mission_id, kind ['lead'|'worker'|'ask'], sdk_session_id, workstream_id, state,
         compaction_checkpoint JSON, updated_at)              -- sdk_session_id = Agent SDK resume handle
messages(id, session_id, seq, role, content JSON, created_at) -- the transcript, for rehydration
tool_calls(id, session_id, name, input JSON, output JSON, idempotency_key, status, created_at)
mission_events(seq INTEGER PRIMARY KEY, mission_id, type, data JSON, created_at)  -- SSE + the resume log
```
On restart: read the mission, replay `mission_events` past `last_event_seq`, and **resume** each non-terminal session via its `sdk_session_id` (Agent SDK `resume`) from its `compaction_checkpoint`. `idempotency_key` on `tool_calls` makes replayed `spawn_worker`/writes safe.

### 4f. Worker staging → publication pipeline  ← review #4
Workers **never** write the canonical graph directly. Crucially, **all artifacts are generated and validated on a temporary path BEFORE the snapshot is atomically sealed** — the seal is the last step, and it either publishes a fully-verified, self-consistent set or nothing at all:
```
worker output → staging.sqlite (per attempt) → schema + provenance VALIDATE → reconcile (dedupe, resolve shared,
  follow-ups) → TRANSACTIONAL merge into index.sqlite.tmp → GENERATE phase1-maps/ Markdown + graph/*.jsonl into a
  temp publication dir → INTEGRITY VALIDATE (Markdown↔graph counts agree · every claim has provenance · export
  manifest+checksums verify) → [ATOMIC SEAL: rename temp dir + index.sqlite.tmp into the immutable snapshot,
  write sealed_at] → publication state = PUBLISHED
```
- **Integrity failure at the validate step → the snapshot is NOT sealed**: publication state = `UNPUBLISHED` + mission `FAILED`, temp dir discarded; the previously-published snapshot (if any) is untouched. A broken generate can never replace a good snapshot.
- **`COMPLETE_WITH_GAPS` is reserved for *mapping* gaps only** (unreconciled inventory items, blocked features, oversized coverage-blockers) — never for artifact/integrity failures, which are hard `FAILED`. A gapped-but-consistent set still seals and publishes; an *inconsistent* set never does.
A failed/partial worker leaves its attempt in `staging.sqlite` — **auditable, never contaminating** the published graph. Published snapshots are immutable; a re-scan makes a **new** snapshot.

---

## 5. Recon runtime (write the brain) — on the Claude Agent SDK

**Lead session** = one Agent-SDK session per mission, its transcript persisted (§4e). It plans, then drives via explicit tools the SDK exposes:
`get_inventory_page, get_domain_summary, search_inventory, create_recon_plan, spawn_worker, list_workers, get_worker_status, send_worker_message, retry_workstream, cancel_worker, submit_followup, get_coverage, finalize_recon`.

- **Paginated inventory tools — the Lead never gets the full inventory in its prompt.** A large repo's 11 inventories can be tens of thousands of rows; dumping them into the Lead's context would blow the budget before planning starts. Instead the raw inventories live in `staging.sqlite` and the Lead pulls them **on demand, bounded**:
  - `get_domain_summary()` → deterministic top-down rollup (domains → feature-seed clusters → per-kind counts) — a small, always-affordable overview computed by clustering code, not the model.
  - `get_inventory_page({kind, cursor, limit})` → one bounded page of a single inventory list, with a `next_cursor`. The Lead iterates pages; a **persisted planning cursor** (in `missions`) records how far it has clustered, so a rehydrated Lead resumes mid-inventory instead of restarting.
  - `search_inventory({query, kind?})` → targeted lookup (e.g. "all `*_worker.rb`", "routes under `/-/feature_flags`") returning a bounded hit list.
  Clustering (§14.2) is therefore **hierarchical**: summary → drill into a domain → page/search its items → emit feature seeds. The final **ownership validation is deterministic** (plan validator, below) — it re-checks the full inventory in code, so completeness never depends on the Lead having seen every row in-context.
- **`spawn_worker` is a backend tool** (not a native subagent): validate scope (no overlap, in-repo, in-budget) → acquire a **task lease** → **start a new Agent-SDK worker session** → persist `sessions`/`tasks`. Completed workers release slots (2–4 active of N). `idempotency_key` guards replays.
- **Budget + slicing** (`planner`, ex-ARCHON): `usable = model_context − prompt − reasoning − output − shared_context`. **If the whole reviewable repo fits one usable context, the plan is ONE holistic worker over the entire codebase — regardless of feature count** (§14.3); only an over-budget repo is sliced: pack files by directory/dependency locality; **replicate** shared auth/policy/middleware/config as read-only shared context; isolate **oversized files** as explicit coverage blockers (never truncate).
- **Plan validator (deterministic, rejects):** overlapping primary files · unowned areas · missing inventory owners · out-of-repo paths · duplicate ids · over-budget.
- **Six phases** (`recon`): scale&shape · architecture/IPC/stores · domain map · auth&roles · communication · synthesis. Workers emit staged claims with provenance.
- **Completion gate → seal:** all workstreams terminal · every feature mapped or blocked · every inventory item reconciled · every feature doc valid · every claim has provenance · follow-ups reconciled · no active lease · Markdown↔graph counts agree · cross-check passes · export manifest+checksums validate. Else **COMPLETE_WITH_GAPS** with exact missing coverage. Quota → mission **PAUSED_QUOTA** (resume later), never a silent drop.

---

## 6. Ask-time — retrieval + Ask Claude (read the brain)

```
POST /ask { project_id, snapshot_id, node_id, thread_id?, question } → SSE
  1. retrieval.getContextBundle(node_id, hops=2)   # bounded neighbourhood, NOT a repo scan
  2. context packer → AI_CONTEXT preamble + feature doc + subgraph facts + cited source (from snapshots/<id>/source/)
  3. Agent-SDK ask session (thread) with READ-ONLY tools:
       get_feature · get_endpoint · get_authentication_flow · get_data_flow · get_process_topology ·
       get_trust_boundaries · get_coverage_gaps · search_brain · get_context_bundle
     the SDK runs the tool loop; each tool = another bounded graph query → cited answer
  4. streams into the inspector; unmapped ⇒ "coverage gap", never a guess
```
One **thread = one Agent-SDK session** (first ask creates it, follow-ups `resume` it); ephemeral, read-only, scoped to project+snapshot. **In-app Ask and Export use the identical packer** — a fresh session with the exported `AI_CONTEXT.md` + `features/*` + `graph/*` answers the same way.

---

## 7. API surface (local server + SSE)

```
POST/GET/DELETE /api/projects[/:id]
POST /api/projects/:id/snapshots · POST …/refresh · GET …/diff
POST /api/projects/:id/recon → { missionId } · GET /api/missions/:id · POST …/cancel · GET …/events (SSE)
GET  /api/projects/:id/brain · …/brain/nodes/:nodeId · …/brain/neighbourhood · …/search · …/features · …/coverage
POST /api/projects/:id/ask → SSE · POST /api/projects/:id/context
POST /api/projects/:id/export · POST /api/projects/import
```
Every op requires `project_id` (+ `snapshot_id` where applicable). UI state comes from `/missions/:id` + `/events`, never logs.

---

## 8. Build milestones (reordered per review #2 — SQLite graph before the renderer)

| M | Deliverable | Acceptance |
|---|---|---|
| **M0** ✅ | Scaffold; schemas (ids, provenance, state machines, versions); profiler; blueprint | `npm test` green (real tests) |
| **M1** | Projects + **immutable snapshots w/ frozen source** (`ingestion`) | git-worktree/CAS frozen tree; delete removes only `data/`; provenance resolves against `source/` |
| **M2** | Inventories + parsers **+ the plugin contract** (§9) | `codengram scan` writes profile + 11 inventories via the plugin registry |
| **M3** | **Minimal SQLite graph writer** — migrations, stable ids, staging + transactional merge | inventories/parse results land in `index.sqlite`; re-run updates in place (stable ids) |
| **M4** | `phase1-maps` renderer **from SQLite** | full artifact tree generated from the graph; Markdown↔graph counts agree |
| **M5** | Lead session + validated plan (`claude-runtime` on Agent SDK, `planner`) | plan persisted; validator rejects overlap/unowned/over-budget; mission rehydrates after restart |
| **M6** | Worker fanout + leases + resume + staging (`task-board`) | 2–4 active of N; kill/restart resumes; failed attempt stays in staging, not index |
| **M7** | Six-phase recon + reconciliation + completion gate + seal | every inventory item terminal; COMPLETE / COMPLETE_WITH_GAPS; snapshot sealed |
| **M8** | Graph search / retrieval / neighbourhood (`retrieval`) | bounded queries; `get_context_bundle`; read-only tools |
| **M9** | React shell on Organic (`apps/web`) | Projects/New/Recon/project-shell rebuilt 1:1; SSE live |
| **M10** | Brain canvas + inspector | Sigma adapter; ≤~1000 visible; semantic zoom; citations; Ask |
| **M11** | Live session/task/coverage views | all state from backend task state |
| **M12** | Export / import / AI context tools | export opens in a fresh Claude session w/ zero prior context |
| **M13** | Incremental refresh + snapshot diff | new snapshot; updates only impacted nodes via stable ids |
| **M14** | Public plugin SDK + fixtures + contributor docs | the M2 contract published; fixture suite |
| **M15** | GitLab-scale performance + recovery | ≥100k nodes navigable; resume after interruption; no state loss |

---

## 9. Plugin contract (defined at M2, public SDK at M14)  ← review #9

Language/framework logic goes behind a plugin interface from the start, so nothing is hardcoded then rebuilt. `packages/plugins` defines the contract + registry; `parsers`/`inventories` ship the first implementations. A plugin provides:
`languageDetector · frameworkDetector · parserAdapter (symbols/imports) · inventoryExtractor · graphEmitter · featureMappingTemplate · validator · metadata { id, langs, schema_compat }`.
The recon engine calls plugins through the registry only; adding Rails/Django/Spring/etc. is a plugin, never a core edit.

---

## 10. Security & trust boundaries  ← review #10

The local server + repo ingestion run untrusted input, so before any public release:
- **Bind to loopback** by default; **validate browser origin**; **CSRF-protect** all mutation endpoints (token/double-submit).
- **Normalize** project ids + paths; **prevent symlink escapes** and **archive path traversal** on import; keep all writes under `data/`.
- **Never execute repository code** — no `bundle/npm install`, no git hooks, no submodule fetch, no build. Recon is read-only.
- **Size limits** on clone/archive/file; reject oversize inputs.
- **Redact secrets** from logs and from AI context where configured (`.env`, keys) — surface their presence, not their values.

---

## 11. Hard invariants (code + prompts + CI lint)

1. **Recon only** — no vulnerability detection anywhere; `phase2_review_queue.md` = review context + unverified leads, never a finding. CI lint bans security-verdict vocabulary in outputs.
2. **Markdown generated from the graph**, never the sole store.
3. **Every claim carries provenance** — snapshot + file + line-range (or declared repo/generated method) + confidence + field.
4. **Bounded retrieval** — neighbourhood queries; ≤~1000 nodes rendered.
5. **UI state = backend task state**, never logs.
6. **Frozen, read-only source** per snapshot; deletion removes only generated `data/`.
7. **`spawn_worker` = validated, leased backend tool**; workers stage → merge, never write the published graph directly.
8. **Nothing disappears silently** — every inventory item terminal; gaps surfaced.
9. **All AI runs on the Claude Agent SDK using the user's local Claude Code subscription auth** — Codengram never implements login and never reads/copies/exports/logs/stores credentials (§2a); sessions are persisted + resumable, not process-bound.

---

## 13. Code recon in detail — the output contract ↔ the UI (no mismatch)

This section defines **exactly what recon produces per feature** and **which UI element renders it**, so the designed screens and the recon engine can never drift. It is modeled on the real 43-feature GitLab reference maps (`phase1-maps/features/*.md`, 1,931 ledger rows). **Recon-only reframing:** the reference maps were built for a security handoff; Codengram keeps every **structural/understanding** part verbatim and **renames the security-lead section to review context** (§13g) — it says *where to look and what's unclear*, never *a vulnerability exists*.

### 13a. The recon pipeline (deterministic → Lead → workers → graph → Markdown → UI)

```
1. PROFILE (deterministic, packages/profiler)  → languages, files, tokens, entry points, context budget
2. INVENTORIES (deterministic, packages/inventories, per-language plugin)  → the raw source-of-truth lists:
     01_routes_endpoints  02_rest_api  03_graphql  04_workers_jobs  05_services_finders_policies
     06_response_shaping   07_downloads_uploads_exports  08_search_aggregation  09_tokens_actors
     10_processes_ipc      11_datastores_integrations
   (grep/ast patterns per plugin — e.g. Rails: routes.rb, `Grape::API`, `*_worker.rb`, `app/policies/*`)
3. DISCOVER FEATURES (Lead)  → cluster inventory items into FEATURES (coherent capabilities); write feature-queue.json
4. PLAN (Lead, packages/planner)  → one workstream per feature/feature-cluster, file-locality sliced, budget-fit,
     shared infra (base controllers/policies/concerns) replicated as read-only shared context; validator rejects overlap
5. MAP (workers, Agent SDK — one per workstream)  → for each owned FEATURE, walk the 6 phases and emit:
     • ONE feature document with the 13 canonical sections (§13c)  → staged
     • GRAPH nodes+edges with provenance (§13e)                    → staged
6. RECONCILE (Lead)  → every inventory item → a terminal status (§13f); cluster same-functionality across features
     (§13d); resolve follow-ups
7. GATE + SEAL  → completion gate; transactional merge staging → index.sqlite; publication status
8. GENERATE  → phase1-maps/features/<slug>.md + consolidated/* + graph/*.jsonl  FROM index.sqlite
9. SERVE  → the UI reads the graph (Brain, Features, FeatureDetail, Coverage…) via bounded queries
```
Every worker claim is a `claim(node/edge, field, provenance)` — file + line-range (or declared repo/generated method) + confidence + discovery method. A feature is `mapped` / `mapping` / `coverage-gap` per its ledger-row depth, never a guess.

### 13b. The unit of truth — the **Endpoint/Action Ledger** (13 columns)

Every entry point a feature exposes is one ledger row. This is the atomic recon record; features, the Brain, Interfaces, and Coverage all roll up from it.

| Col | Meaning |
|---|---|
| Entry Point | route / REST path / GraphQL op / worker / other |
| Method/Trigger | GET/POST/… or async trigger |
| File | source file (frozen snapshot) |
| Class/Method | handler symbol |
| Object Lookup | how the target object is resolved (id/iid/finder) |
| Auth Check | the authentication/authorization check found (descriptive) |
| Object Authorized | project-level / object-level / none |
| Response/State Change | what it returns or mutates |
| Serializer/Worker | response shaper / async job |
| Same-Functionality Siblings | other features/files sharing this pattern |
| Phase1 Status | Discovered / Mapped / Traced / AuthZ-Verified / Deep-Complete |
| Review Priority | High / Medium / Low (attention, not severity) |
| Gaps | what's unresolved / needs a human |

`Phase1 Status` per row is the honest depth ladder; the feature's overall coverage = the roll-up.

### 13c. The Feature Document Contract — 13 sections ↔ FeatureDetail UI

When you open **Features → click a feature**, the FeatureDetail view renders these 13 sections (tabbed/accordion). Every feature doc has all 13; each maps to a concrete UI block and to graph data:

| # | Section | Content (from the real maps) | FeatureDetail UI block | Graph |
|---|---|---|---|---|
| 1 | **Feature Identity** | Name, Slug, Domain, edition/variant, Main business objects, Roles/Permissions (ability → role) | Header + Identity card (name, domain chip, objects, role chips) | `FEATURE` node; `REQUIRES_ROLE`→`ROLE`; `DEFINES`→`MODEL` |
| 2 | **Feature Purpose** | 1–2 paragraph plain-English purpose | Purpose paragraph under the header | `FEATURE.data.purpose` |
| 3 | **Entry Points** | 5 sub-tables: Web Routes/Controllers · REST API · GraphQL · Workers/Async · Other | Entry Points block — 5 grouped tables | `ROUTE/ENDPOINT/GRAPHQL_OPERATION/JOB` nodes, `EXPOSES`/`HANDLED_BY` |
| 4 | **Endpoint / Action Ledger** | the 13-column table (§13b) — the row-level spine | Ledger table (sortable, status-chipped) — the FeatureDetail's core | one `ENDPOINT` node + edges per row |
| 5 | **Full Code Paths** | per major action, the traced request→service→model→response path in prose | Code Paths accordion (one per action) w/ citations | `CALLS`/`READS`/`WRITES` edge chains |
| 6 | **Authorization Map** | Action · Expected permission · Actual check found · Object authorized · File/Method (descriptive) | Authorization table | `AUTHORIZED_BY`→`AUTH_CHECK`, `REQUIRES_ROLE` |
| 7 | **Authentication / Actor Context Map** | how current_user/actor/token is established per surface (session/PAT/OAuth/token/none) | Actors & auth card | `AUTHENTICATED_BY`, `TOKEN` nodes |
| 8 | **Data Exposure Map** | Data returned · Entry point · Serializer/Entity/Type · Field-level checks | Data exposure table | `RETURNS_DATA`→`MODEL`, `CROSSES_BOUNDARY` |
| 9 | **Background Job Map** | Worker · Trigger · Inputs · Actor · Re-checks authz? · Notes | Background jobs table | `JOB` nodes, `ENQUEUES` |
| 10 | **Same-Functionality Map** | Functionality pattern · Similar features/files · Shared services · Notes | "Shares implementation with" chips → links to sibling features | `SHARES_IMPLEMENTATION_WITH`, `USES_SERVICE` |
| 11 | **Review Context (ranked)** *(recon-only rename of "Security-Sensitive Areas")* | ranked areas worth human attention + the open questions/gaps — **leads, never findings** | Review-context list (ranked, amber) — explicitly labeled "unverified leads" | `COVERAGE_GAP` nodes for open items |
| 12 | **Files Reviewed** | File path · Type · Role · Important methods · Notes | Files-reviewed table (links open the frozen source) | `FILE`/`SYMBOL` nodes, `CONTAINS`/`DEFINES` |
| 13 | **Coverage Notes** | what depth was reached, what's estimated vs verified, honest gaps | Coverage note banner (estimated ≠ verified) | feeds Coverage view |

This table IS the FeatureDetail spec — the Features tab row opens a view with exactly these 13 blocks, each citation-backed.

### 13d. Same-functionality clustering → the Brain's feature↔feature connectivity

Recon aggregates every feature's §10 into a **cross-feature shared-infrastructure map**: one shared concern/service/finder/policy → the features that re-use it (e.g. `NotesActions/NotePolicy` reused by notes, issues, MRs, snippets, wikis, epics…; `Ci::CreatePipelineService` by pipelines, MRs, runners, security-policies). In the graph this is:
```
FEATURE ──SHARES_IMPLEMENTATION_WITH──▶ FEATURE      (via a shared SERVICE/AUTH_CHECK/MODEL both USE)
FEATURE ──USES_SERVICE──▶ SERVICE ◀──USES_SERVICE── FEATURE
```
These edges are the **high-level connectivity the Brain shows** — features are not islands; the graph reveals which capabilities share auth, services, models, and boundaries.

### 13e. The Brain graph model + semantic zoom (what connects to what)

The Brain renders the graph at bounded neighbourhoods (≤~1000 nodes), family=color, status=ring/line. Semantic zoom = which node layers are visible:

```
L1 Domains       PROJECT ─CONTAINS→ DOMAIN
L2 Features      DOMAIN ─CONTAINS→ FEATURE ; FEATURE ─SHARES_IMPLEMENTATION_WITH→ FEATURE   ← default; the "connectivity" view
L3 Interfaces    FEATURE ─EXPOSES→ ENDPOINT/ROUTE/GRAPHQL_OPERATION/JOB ; ─AUTHENTICATED_BY→ AUTH_CHECK
L4 Code          ENDPOINT ─HANDLED_BY→ SYMBOL ─CALLS→ SERVICE ─READS/WRITES→ MODEL ; ─AUTHORIZED_BY→ AUTH_CHECK ─REQUIRES_ROLE→ ROLE
L5 Evidence      SYMBOL/MODEL ─(provenance)→ FILE:line   (opens the frozen source)
```
Selecting a FEATURE highlights its neighbourhood: its endpoints, the roles/tokens that authenticate it, the services/models it touches, the trust boundaries it crosses, and — crucially — the **sibling features it shares implementation with**. Double-click expands one hop (another bounded query). Node inspector = the same facts + citations + "Ask Claude about this feature/endpoint."

**Canonical vocabulary mapping (no new node types beyond the schema's 22).** Recon prose names Rails-ish concepts — *domain, concern, policy, finder* — but the graph stores only the canonical `NODE_TYPES`/`EDGE_TYPES` (`packages/schemas`). The mapping is fixed and enforced by `isValidNode`:
- **domain** → a first-class `DOMAIN` node (`PROJECT ─CONTAINS→ DOMAIN ─CONTAINS→ FEATURE`).
- **concern**, **finder**, and any reusable service → a `SERVICE` node discriminated by `data.kind ∈ SERVICE_KINDS` (`service|concern|finder|module`); the reuse edge is `USES_SERVICE`.
- **policy** / any authZ check → an `AUTH_CHECK` node discriminated by `data.kind ∈ AUTH_CHECK_KINDS` (`policy|before_action|guard|middleware|token`); the edge is `AUTHORIZED_BY`.
There is no `CONCERN`/`POLICY`/`FINDER`/`USES` node or edge type — those words are `kind` discriminators on `SERVICE`/`AUTH_CHECK`, never types.

### 13f. Inventory reconciliation → the Coverage view

Every raw inventory item ends in exactly one terminal status: `MAPPED_TO_FEATURE`, `SHARED_INFRASTRUCTURE`, `NOT_RELEVANT_WITH_REASON`, `UNCLEAR_COVERAGE_GAP`, `DEAD_OR_UNREACHABLE_WITH_EVIDENCE` — **nothing disappears silently.** The **Coverage** view renders: (a) the **feature × inventory-kind matrix** (the heatmap) from these statuses, (b) per-feature ledger-row depth, (c) the **honesty rule** — estimated coverage is labelled estimated, never "verified" (the GitLab maps explicitly record where item-by-item reconciliation was incomplete). Unreconciled items → `UNCLEAR_COVERAGE_GAP` → `COVERAGE_GAP` nodes → surfaced, and the completion gate reports `COMPLETE_WITH_GAPS` with the exact list.

### 13g. Recon-only boundary (enforced)

Codengram maps **structure and understanding** — who exposes what, which auth checks/actors/roles exist, what data flows where, which features share code. It **never** asserts a vulnerability. The reference maps' "Security-Sensitive Areas for Phase 2" + `phase2_review_queue.md` become Codengram's **Review Context** — ranked *unverified leads and open questions* pointing back to `features/<slug>.md`, explicitly labelled "leads, not findings." A CI lint bans finding/verdict vocabulary ("vulnerable", "exploit", "CVE", severity claims) from all generated output.

---

## 14. Recon logic — how each step actually computes (algorithms)

The §13 pipeline says *what* happens; this section says *how the logic works*, step by step, so an engineer can implement each package without re-deciding.

### 14.1 Inventory extraction (deterministic, per language plugin)
`inventoryExtractor` builds the 11 lists with grep + tree-sitter — no AI. Rails example (other plugins mirror the intent):
- **01 routes/endpoints** ← parse `config/routes.rb` (+ engine routes): `resources/get/post/match` → `file:line · verb · path · controller#action`.
- **02 rest_api** ← `class * < Grape::API` + `get/post/put/delete '…'` blocks → path · handler.
- **03 graphql** ← `Types::/Resolvers::/Mutations::` + `field :x` → query/mutation/resolver decls.
- **04 workers_jobs** ← `*_worker.rb` / `include Sidekiq::Worker`; **enqueues** ← `.perform_async|perform_later` call sites.
- **05 services_finders_policies** ← `app/services/**/*_service.rb`, `app/finders/**`, `app/policies/**`.
- **06 response_shaping** ← serializers/entities + `render json:`. **07** ← `send_file|send_data|ActiveStorage|export`.
- **08 search** ← search services / `.search`. **09 tokens_actors** ← `TokenAuthenticatable`, token classes, `authenticate_*`, `current_user`.
- **10 processes_ipc** ← `Procfile`, puma/sidekiq/clockwork config. **11 datastores_integrations** ← `database.yml`, redis, external clients + initializers.
Output = raw `file:line` lists, the source of truth for reconciliation. Each item gets a stable id (`endpoint:…`, `symbol:…`).

### 14.2 Feature discovery + clustering (Lead) — hierarchical, paginated
The Lead **never loads the full inventory into its prompt** (§5). It works top-down over bounded tools: `get_domain_summary()` for the rollup → for each domain, `get_inventory_page`/`search_inventory` to drill in. Within a domain it clusters items into FEATUREs by, in order: (a) **controller/namespace cohesion** (`Projects::FeatureFlagsController` + `API::FeatureFlags` + `API::Unleash` → *Feature Flags*), (b) **shared domain module/model** (`Operations::FeatureFlag*`), (c) **route path prefix** (`/-/feature_flags`), (d) **naming affinity**. Each cluster → a feature `{slug, domain, seed_files, inventory_refs}`; ambiguous items → the Lead's follow-up queue. A **persisted planning cursor** (`missions`) records progress so a rehydrated Lead resumes mid-inventory. Output: `feature-queue.json`. **Final ownership is validated deterministically in code** (§14.7 reconciliation + the plan validator), not by trusting that the Lead saw every row.

### 14.3 Workstream planning + slicing (planner, ex-ARCHON)
Session count is driven by **context size, not feature count**: `N = ceil(reviewable_tokens / usable_context)`.
- **If the complete reviewable repo fits in one usable context (`reviewable_tokens ≤ usable_context`), `N = 1`: a single holistic worker maps the whole codebase in one session — regardless of how many features were discovered.** A 200-feature repo that fits in context is still one worker; feature count never forces a split. This is the common case for small/medium repos and the simplest, highest-fidelity path (the worker sees everything at once).
- Only when the repo exceeds one context does the planner slice: pack a feature's owned files by **directory/dependency locality** into budget-sized workstreams; **replicate** shared infra (base controllers, `ApplicationController`, policies, concerns) as read-only shared context; an **oversized file** → explicit coverage blocker (never truncated). Validator rejects primary-file overlap / unowned areas / over-budget.

### 14.4 Per-feature mapping — how a worker derives each of the 13 sections
A worker owns a feature, reads its owned files + shared context (frozen source), walks the 6 phases, and derives each section as `claim(node/edge, field, provenance)`:
1. **Identity** — name/slug/domain from the seed; **business objects** = models referenced; **roles/permissions** = grep ability names in `app/policies/*` × `config/authz/roles/*.yml` → ability→role map.
2. **Purpose** — 1–2-sentence synthesis over the read controllers/services (LLM reasons; cited).
3. **Entry points** — inventories filtered to this feature's files, grouped Web/REST/GraphQL/Workers/Other; auth from `before_action`/`authorize_*`/`route_setting`.
4. **Endpoint/Action Ledger** — one row per entry point; **trace each** to fill 13 cols: object lookup (`find/find_by/finder`), auth check (`authorize!`/policy), object-authorized (project vs object level), response/state, serializer/worker, siblings (deferred), depth status, gaps.
5. **Full code paths** — per major action, trace request→controller→service→model→response, quoting the chain `file:line`.
6. **Authorization map** — per action: expected permission (role YAML) vs **actual check found** (code) vs object authorized; divergence → a *gap* (descriptive, never a verdict).
7. **Auth/actor context** — per surface, how `current_user`/actor/token is established (session/PAT/OAuth/token/none).
8. **Data exposure** — per response, data + serializer/entity + field-level checks.
9. **Background jobs** — per worker: trigger/inputs/actor/re-checks-authz.
10. **Same-functionality** — patterns this feature shares (finalized in reconciliation, §14.6).
11. **Review context** — ranked areas + open questions found while tracing — **leads only**.
12. **Files reviewed** — every file read, role, key methods.
13. **Coverage notes** — honest depth reached; estimated vs verified.
Emits staged nodes/edges to `staging.sqlite`.

### 14.5 Ledger-row depth ladder (per row, deterministic roll-up)
`Discovered` (in inventory) → `Mapped` (entry point + handler) → `Traced` (full path read) → `AuthZ-Verified` (auth check confirmed vs role map) → `Deep-Complete` (all cols + gaps closed). A row's status = max depth reached; a **feature's coverage = the distribution** of its rows' depths (`mapped` if all ≥ Mapped, `coverage-gap` if any Discovered-only, etc.). This is exactly the honesty the reference maps record (most rows Traced/Mapped, few Deep-Complete).

### 14.6 Same-functionality clustering (Lead → Brain connectivity)
For each `SERVICE` node (`kind` = service/concern/finder/module) and `AUTH_CHECK` node (`kind` = policy/before_action/guard/middleware/token), list the FEATUREs whose files use it (from `CALLS`/`USES_SERVICE`/`AUTHORIZED_BY` edges). *(Concern/policy/finder are `kind` discriminators, not node types — see §13e.)* A node used by **≥2 features** → a cluster → emit `SHARES_IMPLEMENTATION_WITH` edges between those features + one row in `same_functionality_cross_feature_map.md`. These edges are the high-level connectivity the **Brain** renders (features that share auth/services/models).

### 14.7 Inventory reconciliation (Lead) — every item terminal
For each raw inventory item: referenced by a feature ledger → `MAPPED_TO_FEATURE`; a shared base/concern → `SHARED_INFRASTRUCTURE`; plugin-marked non-relevant with a reason (asset/pure-config) → `NOT_RELEVANT_WITH_REASON`; referenced but no owner resolved → `UNCLEAR_COVERAGE_GAP`; no inbound route/caller with evidence → `DEAD_OR_UNREACHABLE_WITH_EVIDENCE`. Where item-by-item wasn't exhaustive, mark **estimated** (never "verified"). Output: `source_inventory_coverage_matrix.md`.

### 14.8 Graph construction (staged claims → sealed `index.sqlite`)
Upsert nodes/edges by **stable id** (re-scan updates in place, no duplicates); attach provenance/claim rows; resolve a shared symbol referenced by many features to **one canonical node** (the merge point for §14.6). Transactional merge from `staging.sqlite` into `index.sqlite.tmp`, then **generate `graph/*.jsonl` + `features/*.md` + `consolidated/*` into a temp publication dir and integrity-validate them (§4f) BEFORE sealing.** Only on a clean integrity pass does the atomic seal (rename temp → immutable snapshot) run; an integrity failure discards the temp set and leaves the last good snapshot in place (publication `UNPUBLISHED`, mission `FAILED`).

### 14.9 Completion gate computation
Boolean AND over: all tasks terminal · every feature `mapped|blocked` · every inventory item has a terminal status · every feature doc validates against the 13-section schema · every claim has provenance · follow-ups reconciled · no active lease · `count(nodes/edges in Markdown) == count in graph` · cross-check passes · export manifest+checksums validate. All true → `COMPLETE`; else `COMPLETE_WITH_GAPS` with the exact gap list = `UNCLEAR_COVERAGE_GAP` items + `BLOCKED` features + oversized coverage-blockers. `COMPLETE_WITH_GAPS` covers **mapping gaps only** — it still seals and publishes. The integrity checks in this list (Markdown↔graph counts, provenance, manifest/checksums) are **not** gaps: a failure there is a hard `FAILED`/`UNPUBLISHED` (§4f), never a published-with-gaps state.

### 14.10 Ask-time retrieval + context packing
`neighbourhood(node, hops)` = BFS over edges up to `hops`, capped ~1000 nodes, preferring high-confidence + feature-local nodes. Packer output = AI_CONTEXT preamble + (if node is a FEATURE) its feature doc + the subgraph as facts + **cited source excerpts** pulled from `snapshots/<id>/source/` at each claim's line-range + the open gaps. Deterministic assembly; the Agent-SDK session only reasons over it, cites every claim, and says "coverage gap" when a fact isn't in the graph.

---

## 12. Status

**The deterministic pipeline runs end-to-end** — `codengram scan <repo>` → frozen snapshot → inventories → SQLite graph → `phase1-maps` → local UI + Ask. Zero dependencies (Node 22+ built-in SQLite). `npm test` green (**35 tests**).

- ✅ `packages/schemas` — canonical from/to edges, stable ids, provenance policy, 3 state machines, versions.
- ✅ `packages/profiler` — deterministic facts + context budget (200K default, 1M opt-in per Anthropic docs).
- ✅ **M1** `packages/ingestion` — projects + content-addressed frozen source, manifest, provenance resolution, data-only delete.
- ✅ **M2** `packages/plugins` + `packages/inventories` — plugin contract/registry + Rails inventory extractor (11 lists).
- ✅ **M3** `packages/graph` — SQLite graph, stable-id upserts, staging → transactional merge.
- ✅ **M4** `packages/markdown-renderer` — `phase1-maps` projected from SQLite + Markdown↔graph cross-check.
- ✅ **M5–M7 (deterministic)** `packages/recon` — feature clustering (§14.2), graph build, SHARES edges (§14.6), reconcile + gate, `scanSnapshot`.
- ✅ **M8** `packages/retrieval` — bounded, cited context bundles + deterministic Ask.
- ✅ `packages/claude-runtime` — optional Agent SDK adapter (auth delegated; offline-safe fallback).
- ✅ `apps/cli` (`scan`/`ls`/`ask`/`serve`) + `apps/server` (API + SSE + single-file Organic UI).
- ✅ Design locked (`design/codengram.html`, Organic).
- ▶ **Next:** AI enrichment via real Agent-SDK Lead/workers (M5–M7 full), the React/Vite/Sigma UI (M9–M11), incremental refresh + diff (M13), public plugin SDK (M14), GitLab-scale hardening (M15).
