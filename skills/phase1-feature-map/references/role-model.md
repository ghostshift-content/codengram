# Role Model — the subject axis (`roles/`)

Access control = **subject × object**. The 9 inventories map the *object* axis (what surfaces
exist). This file maps the *subject* axis (who can act, and with what). The per-feature
Authorization Map is the intersection of the two.

Building this is **mandatory**, and it happens in Stage C — **before** feature mapping — so every
`features/<slug>.md` cites this model instead of re-deriving roles 40 times. Skipping it is what
leaves blocker **ROLE-1** (role→ability wiring untraced) open.

Output: `phase1-maps/roles/`

```
roles/
├── role-structure.md          actor catalog, ladder, ability alphabet, tokens, sudo/2FA, source of truth
├── role-ability-matrix.md     role → ability matrix (this is what closes ROLE-1)
├── role_authz_source_files.txt   every policy/guard/permission file (rg -l output)
└── role_structure_hints.txt      role constants + access levels + ability declarations (rg -n output)
```

---

## 1. The actor catalog (generalize to the app; keep every row that exists)

Every access-control test needs the full actor spectrum, not just "user vs admin". Default set —
drop rows the app genuinely lacks, add app-specific ones:

| Actor | Review notes |
|---|---|
| Anonymous | Unauthenticated access; public/internal visibility behavior |
| Authenticated non-member | Logged in, no membership on the target resource |
| Minimal / limited access | Lowest membership tier, if the app has one |
| Guest / read-only | Read + comment surfaces; confidential-resource restrictions |
| Planner / intermediate | Any planning-or-similar partial role where enabled |
| Reporter | Read/reporting surfaces |
| Developer | Write/code and content-mutation surfaces |
| Maintainer | Resource administration, elevated mutation |
| Owner | Ownership, destructive/admin paths |
| Instance admin | Instance-level bypasses; admin-mode considerations |
| Custom role | Fine-grained/custom permission sets |
| Bot / service / token actors | Access tokens, job tokens, deploy tokens, service accounts, OAuth/PAT scopes |
| Impersonated actor | Sudo/impersonation sessions, if supported |

Also record, per actor: how it is obtained, and whether it is **hierarchical** (inherits
everything below it) or **non-hierarchical**.

> **Non-hierarchical roles are a security concern.** A role that does *not* inherit transitively
> from the levels below breaks ladder reasoning — "Maintainer can do everything Developer can"
> stops holding. Flag every one of them explicitly; they are recurring bug sources.

## 2. The role ladder

```markdown
| Value | Role | Hierarchical? | Where defined | Notes |
|---:|---|:-:|---|---|
| 0 | NO_ACCESS | — | `<file:line>` | default for non-members |
| 10 | GUEST | Yes | `<file:line>` | read-only |
| ... | ... | ... | ... | ... |
```

Numeric ladders (`GUEST = 10`) and string roles (`ROLE_ADMIN`, `hasAuthority(...)`) both go here.
If the app has **scope-specific ladders** (project vs group vs namespace vs org), give one table
per scope and state how they compose.

## 3. The ability / permission alphabet

Every `enable :x` / `prevent :x` / `@PreAuthorize("...")` / `can('x')` / policy-guard name is one
letter of the app's permission alphabet. Enumerate the distinct set, then group by prefix:

```markdown
| Prefix | Count | Examples |
|---|---:|---|
| `read_*` | N | read_project, read_issue, … |
| `create_*` | N | … |
| `update_*` | N | … |
| `destroy_*`/`delete_*` | N | … |
| `admin_*` | N | … |
| `access_*` / other | N | … |
| **Total distinct** | **N** | |
```

## 4. Role → Ability matrix (the ROLE-1 closer)

This is the artifact that was missing. For each ability, pin **which role actually enables it**
and **where that wiring lives** — the policy rule, the role→permission YAML/table, or the
custom-role definition. Do not infer from the name.

```markdown
| Ability | Anon | Non-member | Guest | Reporter | Developer | Maintainer | Owner | Admin | Custom-role capable | Wiring (file:line) | Status |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|---|
| `read_issue` | ○ | ○ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | yes | `policies/issue_policy.rb:12` | Verified |
| `admin_issue` | ○ | ○ | ○ | ○ | ○ | ✓ | ✓ | ✓ | yes | `…` | Traced |
```
✓ = enabled · ○ = not enabled · ? = unresolved (a gap — carry it into ROLE-1).
`Status` uses the same depth ladder as the Endpoint/Action Ledger (Discovered → Mapped → Traced →
AuthZ Verified → Deep Complete).

For a large permission alphabet, cover **every ability reachable from a mapped endpoint** first
(the ones the ledgers actually cite), then the remainder; state the coverage fraction honestly.

## 5. Token / non-human actors

Machine actors frequently bypass the role ladder entirely — this table is where that shows up.

```markdown
| Token type | Prefix | Storage / hashing | Lifetime | Scopes | Maps to which role/actor | Revocation |
|---|---|---|---|---|---|---|
| Session cookie | — | server-side store | … | — | the user | logout |
| Personal access token | `<prefix>` | DB hashed | … | `api`, `read_api`, … | the user (or capped) | revoke |
| Deploy / job / agent token | … | … | … | … | often a *synthetic* actor | … |
| OAuth bearer | … | … | … | provider scopes | the user, scope-capped | … |
| Service account / bot | … | … | … | … | membership-derived | … |
```
For each: does the scope **cap** the user's abilities, or is it **additive**? Scope-vs-ability
mismatch is pattern **H**.

## 6. Elevation & verification

- **Sudo / admin mode / step-up:** is "is admin?" separate from "currently acting as admin?" —
  re-auth window, what bypasses it, which endpoints skip it.
- **Impersonation:** who can impersonate, what is logged, what the impersonated actor can do.
- **2FA / WebAuthn / identity verification:** methods, enforcement points, fallback/recovery flow
  (recovery is the usual weak link), and any identity-verification add-ons.
- **Custom roles:** where defined, max per scope, which abilities they may grant, and whether they
  can exceed the base role.

## 7. Source of truth — record the files

List the authoritative files so Phase 2 can re-read them, e.g.:
access-level constants · the ability/permission registry · all policy/guard directories ·
role→permission config (YAML/JSON/table) · custom-role models · admin-mode/impersonation code.

Emit them as `role_authz_source_files.txt` (`rg -l`) and `role_structure_hints.txt` (`rg -n`).

## 8. Enumeration commands by stack

```bash
# --- role constants / access levels (numeric ladders) ---
rg -n 'NO_ACCESS|MINIMAL_ACCESS|GUEST|REPORTER|DEVELOPER|MAINTAINER|OWNER|ADMIN)\s*=\s*[0-9]+' \
   --glob '!{node_modules,vendor,dist,build,target,.git}/**' > roles/role_structure_hints.txt

# --- string roles / authorities ---
rg -n 'ROLE_[A-Z_]+|hasRole\(|hasAuthority\(|\[Authorize\(Roles|Roles\s*=' \
   --glob '!{node_modules,vendor,dist,build,target,.git}/**' >> roles/role_structure_hints.txt

# --- ability / permission declarations (the alphabet) ---
# Rails (declarative-policy / Pundit)
rg -n 'enable :|prevent :|can\? :|allowed\?\(' app/policies/ ee/app/policies/ >> roles/role_structure_hints.txt
# Spring
rg -n '@PreAuthorize|@PostAuthorize|@Secured' -g '*.java' >> roles/role_structure_hints.txt
# .NET
rg -n '\[Authorize|policy\.Require|AddPolicy\(' -g '*.cs' >> roles/role_structure_hints.txt
# Nest / Node
rg -n '@UseGuards|@SetMetadata|@Roles\(|CASL|defineAbility|can\(' -g '*.ts' >> roles/role_structure_hints.txt
# Django / DRF
rg -n 'permission_classes|BasePermission|has_object_permission|has_perm\(|@permission_required' -g '*.py' >> roles/role_structure_hints.txt
# Laravel
rg -n 'Gate::|->authorize\(|@can\b|class \w+Policy' -g '*.php' >> roles/role_structure_hints.txt
# Go / generic (casbin, custom middleware)
rg -n 'casbin|Enforce\(|RequireRole|middleware\.(Auth|RBAC)' -g '*.go' >> roles/role_structure_hints.txt

# --- policy / guard / permission source files ---
rg -l --glob '!{node_modules,vendor,dist,build,target,.git}/**' \
   'Policy\b|BasePermission|@PreAuthorize|\.guard\.|IAuthorizationHandler|Gate::|casbin' \
   > roles/role_authz_source_files.txt

# --- role→permission config as data (often the real wiring) ---
rg -ln --glob '**/{config,authz,permissions,roles}/**' 'permission|role' \
   --glob '!{node_modules,vendor,.git}/**' >> roles/role_authz_source_files.txt

# --- custom roles / sudo / impersonation / 2FA ---
rg -n 'member_role|custom_role|MemberRole|admin_mode|sudo|impersonat|step_up|reauthenticate' \
   --glob '!{node_modules,vendor,dist,build,target,.git}/**' | head -100
rg -n 'two_factor|2fa|webauthn|\botp\b|fido|passkey' \
   --glob '!{node_modules,vendor,dist,build,target,.git}/**' | head -50
```

Counts: distinct roles, distinct abilities, policy files, token types — exact numbers, into
`README.md` and the gate.

## 9. Access-control questions the model must answer

Carry these into every feature map's Authorization Map:

- Which policy method is the **authoritative** gate for the operation?
- Do the web route, REST endpoint, GraphQL resolver/mutation, service, and model callback all use
  the **same** gate? (divergence = pattern **B**)
- Does the feature key off resource role, group/namespace role, admin status, token scope, or a
  custom-role permission — and are those consistent?
- Are confidential / archived / moved / imported / cross-namespace resources handled separately?
- Do feature flags or licensed/paid tiers change the rule?
- Is there a negative expectation for **every lower role** and for the non-member boundary?

## 10. Honest grading

Fill the role→ability matrix with `?` where the wiring could not be pinned, count them, and
report the fraction resolved. If role→ability wiring is not fully traced, **ROLE-1 stays open** in
the completion gate with the specific unresolved abilities named — do not mark it closed on
inference.
