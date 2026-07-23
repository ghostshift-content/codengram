# Per-Feature Map Template (`features/<slug>.md`)

One file per feature. **Every section below is mandatory** and appears in this order.
A section is never dropped — if a feature genuinely lacks a surface (e.g. no REST API),
keep the heading and write `None — <reason>` under it. This template is a *superset*;
producing fewer sections than this is a bug.

Reproduce headings and table column headers **verbatim**. Downstream consolidation and
Phase 2 read these by exact shape.

---

## Depth-status ladder (used in the Endpoint/Action Ledger `Status` column)

| Status | Meaning | Phase 2 can rely on it? |
|---|---|---|
| **Discovered** | The route/mutation/worker exists; file known; nothing traced | No |
| **Mapped** | Entry point + controller/class identified; purpose known | No |
| **Traced** | Object lookup + auth check located but not fully read | Partial |
| **AuthZ Verified** | The authorization path was read to source and confirmed | Yes |
| **Deep Complete** | Full code path read line-by-line incl. service/finder internals | Yes |

Record the honest per-row status. Do **not** inflate. Most rows on a first pass are
Traced/Mapped/Discovered; only a subset reach AuthZ Verified. State that plainly.

---

## Template (copy verbatim, fill every cell)

```markdown
# Phase 1 Feature Map: <Feature Name>

## Feature Identity
- **Name:** <human name>
- **Slug:** <kebab-slug matching the filename>
- **Domain:** <business domain; note framework category tag if the stack has one, e.g. `feature_category :x`>
- **Edition/Tier:** <Core/CE vs paid/EE, OSS vs commercial, or "single edition"; cite the dir split, e.g. `app/…` vs `ee/…`>
- **Main business objects:** <primary models/entities with file paths>
- **Roles / permissions (abilities seen):** <every ability/permission string observed + the policy class it derives from. For each, cite the enabling role by linking the row in `../roles/role-ability-matrix.md` — do not re-derive the role model here. Any ability whose enabling role is unresolved is a `?` that carries into blocker ROLE-1.>
- **Actors that can reach this feature:** <which rows of the actor catalog in `../roles/role-structure.md` apply — anonymous / non-member / each tier / admin / custom role / bot-token — and via which entry point>

## Feature Purpose
<2–5 sentences: what the feature does, what the security-relevant surfaces are (Web/REST/GraphQL/workers/other), and which abilities gate visibility vs mutation.>

## Entry Points

### Web Routes / Controllers
<route source file(s); base controller and its before_action auth chain, cited by file:line>

| Route/Action | Controller | Method | Purpose | Auth/Authz Notes |
|---|---|---|---|---|
| ... | ... | GET/POST/PUT/DELETE | ... | <object lookup + ability check, or GAP> |

### REST API
<API/router file(s); global auth filter; object-lookup helpers cited by file:line>

| Endpoint | API Class | Method | Purpose | Auth/Authz Notes |
|---|---|---|---|---|
| ... | ... | ... | ... | ... |

### GraphQL
<resolver/mutation locations; type-level authorize; mutation base authorize>

| Query/Mutation/Resolver | File | Purpose | Auth/Authz Notes |
|---|---|---|---|
| ... | ... | ... | ... |

### Workers / Async
<worker file locations; general re-authorization pattern (do workers re-load actor + re-check?)>

| Worker | Enqueued From | Inputs | Purpose | Auth/Authz Notes |
|---|---|---|---|---|
| ... | ... | ... | ... | <re-auth? system-context? trusts caller?> |

### Other Entry Points
<email handlers, push options, MCP/AI tool scopes, internal/IPC APIs, import/export, rake, CSV export, webhooks — anything not covered above>

| Entry | File | Purpose | Auth Notes |
|---|---|---|---|
| ... | ... | ... | ... |

## Files Reviewed
| File Path | Type | Role | Important Methods | Notes |
|---|---|---|---|---|
| ... | Controller/API/GraphQL/Service/Policy/Finder/Model/Worker/Serializer | ... | ... | ... |

## Endpoint / Action Ledger
Columns: Entry Point | Trigger | File | Class/Method | Object Lookup | Auth Check | Obj Authz | Response/State | Serializer/Worker | Siblings | Status | P2 | Gaps

| Entry Point | Trigger | File | Class/Method | Object Lookup | Auth Check | Obj Authz | Response/State | Serializer/Worker | Siblings | Status | P2 | Gaps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ... | GET/POST/… or async | ... | `#method` | <how the object is found> | <ability checked> | Yes/parent/collection/partial/No | <what changes> | <serializer or worker> | <same-func siblings> | <depth status> | High/Med/Low | <what wasn't read> |

> One row per **route+method / mutation / worker / distinct action**. This is the
> ground-truth denominator; every entry-point row above should have a ledger row.
> `Siblings` links this row to the same-functionality cluster it belongs to.
> `P2` = Phase 2 review priority for this specific row.

## Full Code Paths
<Prose traces of the highest-value flows (create / mutate / privileged / bulk / merge / approve / export).
For each: params → auth filter → object lookup → ability check → service/worker → state change → response entity → error handling. Cite file:line. One `### <Action name>` subsection per traced flow.>

### <Action 1>
<step-by-step trace>

### <Action 2>
<step-by-step trace>

## Authorization Map
| Action | Expected Permission | Actual Check Found | Object Authorized | File/Method | Notes |
|---|---|---|---|---|---|
| ... | <ability that *should* gate it> | <ability actually checked, cited> | Yes/parent/collection/No | file:line | <divergence, if any> |

## Authentication / Actor Context Map
- **Web:** <session/cookie strategy; when is current_user nil; anonymous read paths; sessionless (RSS/atom/feed token) auth>
- **REST:** <global auth filter; which verbs allow anonymous; job/deploy/PAT/impersonation token acceptance; token scopes>
- **GraphQL:** <how current_user is set; mutation vs subscription auth>
- **Workers:** <how the actor is re-derived (User.find(id)); which workers run in system context with no per-object re-auth>
- **Other (email/push/webhook/import):** <actor derivation per channel>

## Data Exposure Map
| Data Returned | Entry Point | Serializer/Entity/Type | Field-Level Checks | Notes |
|---|---|---|---|---|
| ... | ... | <serializer/entity/type name> | <field-level authorize / redaction, or none> | <secret/PII exposure risk> |

## Background Job Map
| Worker | Trigger | Inputs | User/Actor Used | Re-checks Authorization? | Notes |
|---|---|---|---|---|---|
| ... | ... | ... | <User.find(user_id) / system> | Yes/No (+ where) | ... |

## Same-Functionality Map
| Functionality Pattern | Similar Features/Files | Shared Services | Notes for Phase 2 |
|---|---|---|---|
| <e.g. Issuable CRUD, list filtering, blob streaming, token mint> | <features/files that share it> | <shared service/finder/concern> | <what must be verified per-caller> |

## Security-Sensitive Areas for Phase 2 (ranked)
1. **<lead>** — <why it's suspicious, cited> (High/Medium/Low)
2. ...

## Coverage Notes
- **Fully mapped (AuthZ Verified):** <what was read in full>
- **Mapped but not AuthZ-verified:** <what needs a second pass>
- **Discovered only (need follow-up):** <files/APIs enumerated but not read>
- **Assumptions:** <what was assumed, not line-verified — e.g. finder scoping behavior>
- **Required follow-up for Phase 2:** <the exact files/services to open next>
```

---

## Rules for filling the template

1. **Cite `file:line` for every non-trivial claim.** Never paraphrase what the code does
   without pointing at where. "GAP" / "(not read)" is an honest, required value — use it
   rather than guessing.
2. **The Endpoint/Action Ledger is the contract.** Every route+method, GraphQL
   mutation/resolver, and worker that the entry-point tables list must appear as a ledger
   row with an honest `Status`. The consolidated `feature_coverage_matrix.md` counts these
   rows per feature; nothing may vanish silently.
3. **Object-authorization column is the point.** For each row, answer: *is the specific
   object authorized, or only its parent/collection?* Parent-only authz on child/list/
   relationship endpoints is the #1 Phase 2 lead (pattern A).
4. **Record divergence.** When the route-declared permission differs from the ability
   actually enforced, or when Web/REST/GraphQL check different abilities for the same
   action, that goes in the Authorization Map notes and becomes a Phase 2 lead (pattern B).
5. **Same-Functionality is mandatory,** not optional. Every feature shares services/finders/
   concerns with siblings; identifying them lets Phase 2 review a shared gate once and check
   every caller doesn't weaken it.
