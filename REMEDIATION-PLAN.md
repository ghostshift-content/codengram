# Semantic Mapping Pipeline — Remediation Plan (local, uncommitted)

Root regression: `c296239` deleted the semantic layer (`RULES` taxonomy + `semanticFeatureForRow`→null)
and rewrote roles into a generic string scraper. With `lead_session_id: null`, large repos fall to
`moduleCluster` directory clustering → implementation-noun "features" (Asset/Concern/Authz) + junk roles.

Strict rule: **code extracts facts; only Claude derives repository meaning.** Fail-closed: no Claude ⇒ no
business features (technical inventories + architecture only), never publish folder clusters as MAPPED.

Reference authority: `phase1-maps 3` = section structure/columns/depth; the recon-skill = methodology/tests;
the user SPEC overrides both for: 8 entry channels, the 4 empty-state tokens, extended manifest/fingerprint,
fail-closed states, the separated identity model, and the agentic Lead/worker/reconciler execution.

## Stages (each shippable + tested; do NOT commit)

### S1 — Contract layer (`packages/schemas`)  [foundation]
- Versions: PLANNER_VERSION, PROMPT_VERSION, IDENTITY_SCHEMA_VERSION, RENDERER_SCHEMA_VERSION, SEMANTIC_VALIDATION_VERSION.
- PUBLICATION_STATES += `SEMANTIC_PLANNING_BLOCKED`.
- FOLLOWUP_CLASSES = NEW_FEATURE, RELATED_FEATURE, SHARED_INFRASTRUCTURE, MISSING_DEPENDENCY, COVERAGE_GAP, DUPLICATE.
- ENTRY_CHANNELS = WEB, REST, GRAPHQL, RPC, WEBSOCKET, CLI, WORKER, EVENT.
- EMPTY_STATES = VERIFIED_NONE, NOT_APPLICABLE, EXTRACTOR_UNSUPPORTED, COVERAGE_GAP.
- Identity node types: ACTOR, ROLE, PERMISSION, AUTH_MECHANISM, AUTHZ_CHECK, RESOURCE, OPERATION, TRUST_BOUNDARY.
- Ontology + evidence JSON schemas (Lead output contract) with {file,line,symbol,reason}.

### S2 — Fail-closed planning (`packages/recon/index.js`)  [fixes the regression]
- Remove silent `if(!featurePlan) featurePlan = deterministicSemanticPlan(...)`.
- requested_planner vs executed_planner; bounded retry/backoff on Lead.
- Lead ok → validate ontology (evidence) → semantic featurePlan.
- Lead fail → preserve inventories + technical clusters as ARCHITECTURE (never FEATURES/MAPPED);
  state=SEMANTIC_PLANNING_BLOCKED; persist failure_reason/fallback_reason; never claim 100%.
- Expanded plan fingerprint (all versions + inventories) gates sealed-plan reuse.

### S3 — Expanded Claude Lead + agentic execution (`packages/claude-runtime`, new `packages/orchestrator`)
- PLAN_SCHEMA → full ontology (domains/features/actors/roles/permissions/relationships/matching_rules/evidence/confidence/gaps).
- Full context to Lead (routes/REST/GraphQL/RPC/WS/CLI/events, controllers/services/models/policies/jobs, UI, authz, deps).
- Persistent Lead session + shared task board + feature workers (non-overlapping) + followup-features.jsonl.
- Lead classifies discoveries (FOLLOWUP_CLASSES); reconciler validates evidence, merges aliases, proves coverage.
- Context-budget planning: small repo → 1 holistic session; large → N coherent sessions.

### S4 — Evidence validation (new `packages/recon/evidence-validator.js`)
- Verify every cited file:line/symbol exists in the snapshot; reject/drop hallucinated references.

### S5 — Identity normalization (new `packages/identity`)
- Separate Actor/Role/Permission/AuthMechanism/AuthzCheck/Resource/Operation/TrustBoundary.
- Roles ONLY from authoritative production evidence; permissions from policy/ability/authz/constants/config.
- Exclude specs/tests/fixtures/docs/assets/translations/generated from PRIMARY identity discovery.
- Never classify permission/method/string/UI-label/variable as a role. Replaces `accessTokensFrom` garbage.

### S6 — Gate + versioning + provenance (`packages/recon`, manifest)
- Never COMPLETE without Lead + reconciliation success. semantic vs technical coverage separated.
- Persist: requested/executed planner, lead_session_id, model, failure/fallback reason, snapshot,
  prompt/planner/identity/renderer/semantic-validation versions, validation_result.

### S7 — Renderer (`packages/markdown-renderer`)
- 13 sections byte-aligned to target; 8 entry channels; 4 empty-state tokens; roles/ matrices
  (role-structure.md, role-ability-matrix.md); Architecture view for blocked state; extended manifest.

### S8 — UI + export (`apps/server`)
- Progress: profiling/inventory/Lead/workstream/reconciliation; sessions active/queued/completed/failed;
  executed planner + Lead session; semantic vs technical coverage; gaps/blocked; real actor/role/perm matrices.
- Kill false `cov = features>0?100:0`. Self-contained export bundle.

### S9 — Tests (recon-skill → automated) + fixtures
- Stacks: Rails, Express/FastAPI, GraphQL-only, React, Spring Boot, Django, Go, PHP, CLI/lib, unknown-lang, large polyglot.
- Adversarial: dirs admin/issues/payments/roles WITHOUT capability ⇒ never a feature/role by name.
- Fail-closed: Claude off ⇒ SEMANTIC_PLANNING_BLOCKED, no MAPPED features, no 100%.

### S10 — GitLab acceptance (real Lead run) vs phase1-maps 3.

Progress log:
- [x] S1 — contract layer (fail-closed states, identity model, versions, evidence authority). 85 tests.
- [x] S2 — fail-closed planning: no silent deterministic-features fallback; blocked → ARCH_CLUSTER architecture;
      SEMANTIC_PLANNING_BLOCKED gate; semantic vs technical coverage; expanded fingerprint; provenance persisted.
- [x] S5 (slice) — identity gated to authoritative production/config evidence (kills roles-from-specs).
- [x] S7 (slice) — renderer honest for blocked: architecture.md (clusters ≠ features), blocked banners in
      README/AI_CONTEXT/gate, extended manifest fingerprint (planner/session/model/versions/coverage).
- [x] S3 — expanded Lead ontology (features+actors+roles+permissions+relationships+gaps, evidence-cited) → graph.
- [x] S4 — evidence validation: reject hallucinated file:line/symbol + spec-only identity; rejection ledger persisted.
- [ ] S5 (full) — identity normalization package (separate Actor/Role/Permission/…); Lead-derived roles.
- [ ] S6 — gate never COMPLETE without Lead+reconciliation; full provenance surfaces.
- [ ] S7 (full) — 8 entry channels, 4 empty-state tokens, roles/ matrices, byte-align to phase1-maps 3.
- [ ] S8 — UI: sessions, semantic vs technical coverage, blocked state, real matrices; kill false cov=100.
- [ ] S9 — stack matrix (Rails/Express/FastAPI/GraphQL/React/Spring/Django/Go/PHP/CLI/unknown/polyglot) + adversarial.
- [ ] S10 — GitLab acceptance vs phase1-maps 3.
