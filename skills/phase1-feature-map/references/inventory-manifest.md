# Inventories — the source-of-truth denominator

Before mapping features, build **scripted inventories** of every security-relevant surface.
These are the denominator: the coverage matrix measures per-feature ledgers against them, and
the reconciliation rule guarantees nothing disappears silently. Feature agents grep these
(scoped to their keywords/paths) instead of re-scanning the whole tree.

Each inventory is a plain `.txt` of `rg -n` output (`file:line:match`), one `#`-comment header
line at the top. Build them once, at the repo root, into `phase1-maps/inventories/`.

## The 9 inventory categories (stack-independent meaning)

| # | File | Enumerates (any stack) |
|---|---|---|
| 1 | `01_rails_routes.txt` → `01_routes.txt` | Framework route declarations (all route files) |
| 2 | `02_rest_api.txt` | REST/HTTP endpoint + namespace declarations |
| 3a | `03a_graphql_files.txt` | All GraphQL source files (types/mutations/resolvers) |
| 3b | `03b_graphql_decls.txt` | GraphQL field/mutation/resolver/authorize/argument declarations |
| 4a | `04a_worker_files.txt` | All background-worker / job files |
| 4b | `04b_worker_enqueues.txt` | Worker enqueue call sites (perform_async/enqueue/delay/dispatch) |
| 5a | `05a_services.txt` | Service / business-logic files |
| 5b | `05b_finders.txt` | Finder / query-object / repository files |
| 5c | `05c_policies.txt` | Authorization policy / guard / permission files |
| 6 | `06_response_shaping.txt` | Serializers / presenters / entities / DTOs |
| 7 | `07_downloads_exports.txt` | Download / export / archive / signed-URL / object-storage sites |
| 8 | `08_search_count.txt` | Search / count / aggregate / badge sites |
| 9 | `09_tokens_actors.txt` | Token / actor / principal selection sites |

Keep the numbering even when a category is thin for the stack (write the file with just its
header if the stack genuinely has no such surface, and note it). The **exact** grep patterns
per stack are in `enumeration-by-language.md`. For stacks where a dimension has no idiomatic
grep (e.g. GraphQL/serializers/tokens outside Rails), derive it from the layout directories
and record in the manifest that the inventory is directory-derived, not pattern-derived.

## `00_MANIFEST.md` template

```markdown
# Phase 1 — Source-of-Truth Inventory Manifest

Target: `<absolute repo root>`
Version: **<version string if found>**
Method: source-parsed with ripgrep <version>. <Note if the app could not boot — e.g. "routes
are parsed from route source files because `bin/rails routes` was unavailable (no bundle/DB)".>

## Raw inventory files

| # | File | Description | Count |
|---|---|---|---|
| 1 | `01_routes.txt` | Route declarations | <N> |
| 2 | `02_rest_api.txt` | REST endpoint + namespace declarations | <N> |
| 3a | `03a_graphql_files.txt` | GraphQL source files | <N> |
| 3b | `03b_graphql_decls.txt` | GraphQL declarations | <N> |
| 4a | `04a_worker_files.txt` | Worker files | <N> |
| 4b | `04b_worker_enqueues.txt` | Worker enqueue sites | <N> |
| 5a | `05a_services.txt` | Service files | <N> |
| 5b | `05b_finders.txt` | Finder / repository files | <N> |
| 5c | `05c_policies.txt` | Policy / guard files | <N> |
| 6 | `06_response_shaping.txt` | Serializers / presenters / DTOs | <N> |
| 7 | `07_downloads_exports.txt` | Download / export / object-storage sites | <N> |
| 8 | `08_search_count.txt` | Search / count / aggregate sites | <N> |
| 9 | `09_tokens_actors.txt` | Token / actor / principal sites | <N> |

## Reconciliation rule

Every inventory item must be placed into exactly one of:
1. Mapped to a feature + ledger row
2. Shared infrastructure mapped to all consuming features
3. Not security-relevant (with reason)
4. Unclear → Phase 1 gap
5. Dead / not reachable (with evidence)

No inventory item may disappear silently. Reconciliation is performed per-feature in
`../features/<slug>.md` and aggregated in `../consolidated/source_inventory_coverage_matrix.md`.

## How feature agents use these

Each feature agent greps these files (and the live code) scoped to its feature's keywords /
paths, then builds its Endpoint/Action Ledger and traces. The inventories are the denominator
for the coverage matrix; the per-feature ledgers are the numerator.
```

## Counting

`Count` = `wc -l` of the file minus the header line. Report exact numbers, never "many". The
sum of these counts is the scale headline in `README.md` and the coverage-matrix denominators.

## Read, don't run

Inventories are static. Do **not** `bundle install`, `npm install`, boot the app, or run
`routes`/`route:list` live. If a live command would be the normal way to enumerate (e.g. Rails
`bin/rails routes`), parse the route **source files** instead and note the substitution in the
manifest.
