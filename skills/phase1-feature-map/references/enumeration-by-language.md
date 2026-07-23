# Enumeration by Language — building the inventories for any stack

How to produce the 9 inventories (and the scale/architecture numbers) for whatever stack the
target uses. Detect the stack first, then run the matching block. Meaning-based inventories
(#4b enqueues, #7 downloads/exports, #8 search/count, #9 tokens/actors) use **cross-stack**
patterns that work regardless of language.

All commands are `rg`/`find` and read-only. Exclude vendored/build dirs:
`--glob '!{node_modules,vendor,dist,build,target,.git,__pycache__,coverage,bin,obj}/**'`.

---

## Step 0 — Detect stack & scale (recon phases 1–2, always inline, ≤5 min)

```bash
ROOT="${1:-.}"; cd "$ROOT"
ls -la; ls -d */ 2>/dev/null | head -50
# stack from manifests
ls -la | rg -i 'Gemfile|package\.json|pyproject|requirements|Pipfile|setup\.py|go\.mod|pom\.xml|build\.gradle|Cargo\.toml|composer\.json|mix\.exs|\.csproj|\.sln|Dockerfile|docker-compose|Procfile|nx\.json|turbo\.json'
# files per top-level dir (excludes build/vendor) — or scripts/build-inventories.sh does this
for d in */; do printf "%-32s %7d\n" "$(basename "$d")" "$(find "$d" -type f 2>/dev/null | wc -l)"; done
# language mix
find . -type f \( -name '*.rb' -o -name '*.py' -o -name '*.js' -o -name '*.ts' -o -name '*.go' \
  -o -name '*.java' -o -name '*.kt' -o -name '*.rs' -o -name '*.cs' -o -name '*.php' -o -name '*.ex' \) \
  -not -path '*/node_modules/*' -not -path '*/vendor/*' -not -path '*/.git/*' \
  | sed 's/.*\.//' | sort | uniq -c | sort -rn
```

**Manifest → stack** (for the block to run below): `Gemfile`→Ruby/Rails · `package.json`→Node
(check `express`/`@nestjs`/`fastify`) · `pyproject.toml`/`requirements.txt`→Python (Django/
Flask/FastAPI) · `go.mod`→Go · `pom.xml`/`build.gradle`→Java/Spring · `Cargo.toml`→Rust ·
`*.csproj`→.NET · `composer.json`→PHP/Laravel · `mix.exs`→Elixir/Phoenix. More than one
coexisting = polyglot; run each block, map per service, add a cross-service trust-boundary note.

Process/architecture: read `docker-compose.yml` first (cleanest service map), then Procfile,
init files (`config/initializers/*`, `Program.cs`, `main.ts`, `application.ex`), DB config, and
`.proto`/`cmd/*/main.go` for sidecars. For every internal edge ask: *what stops a process
pretending to be the legitimate caller?* — that's the auth mechanism; "none/loopback" is a lead.

---

## Ruby / Rails  (strongest coverage — the reference stack)

```bash
# 01 routes  (source-parsed; do NOT run bin/rails routes)
rg -n '^\s*(get|post|put|patch|delete|resources?|member|collection|namespace|scope|mount|match)\b' \
   config/routes.rb config/routes/ ee/config/routes/ 2>/dev/null > 01_routes.txt
# 02 REST (Grape)
rg -n '\b(resource|namespace|get|post|put|patch|delete)\b' lib/api/ ee/lib/api/ 2>/dev/null > 02_rest_api.txt
# 03a graphql files / 03b decls
rg -l --glob '**/graphql/**' '' app/ ee/app/ 2>/dev/null > 03a_graphql_files.txt
rg -n '\b(field|argument|mutation|def resolve|authorize|present_using)\b' app/graphql/ ee/app/graphql/ 2>/dev/null > 03b_graphql_decls.txt
# 04a worker files / 04b enqueues
rg -l 'include (Sidekiq::Worker|ApplicationWorker)|< ApplicationJob' app/ ee/app/ 2>/dev/null > 04a_worker_files.txt
rg -n '\.(perform_async|perform_in|perform_at|perform_later|bulk_perform_async)\b' app/ ee/app/ lib/ 2>/dev/null > 04b_worker_enqueues.txt
# 05a services / 05b finders / 05c policies
rg -l '' app/services/ ee/app/services/ 2>/dev/null > 05a_services.txt
rg -l '' app/finders/ ee/app/finders/ 2>/dev/null > 05b_finders.txt
rg -l '' app/policies/ ee/app/policies/ 2>/dev/null > 05c_policies.txt
# 06 response shaping
rg -l '' app/serializers/ app/presenters/ ee/app/serializers/ 2>/dev/null > 06_response_shaping.txt
rg -ln 'class \w+ < Grape::Entity|expose ' lib/api/entities* ee/lib/api/entities* 2>/dev/null >> 06_response_shaping.txt
```
Roles/abilities: `rg -n 'GUEST\s*=|REPORTER\s*=|DEVELOPER\s*=|MAINTAINER\s*=|OWNER\s*=' lib/`;
abilities alphabet: `rg -hn 'enable :|prevent :|can\? :|allowed\?\(' app/policies/ ee/app/policies/ | rg -oe ':[a-z_]+' | sort -u`.
Auth init: `config/initializers/{devise,doorkeeper,omniauth,content_security_policy}.rb`, `app/controllers/application_controller.rb`, `app/policies/base_policy.rb`.

## Python / Django

```bash
rg -n '\b(path|re_path|url)\(' -g 'urls.py' > 01_routes.txt
cp 01_routes.txt 02_rest_api.txt   # DRF routes live in the same urls.py; refine by viewset
rg -ln 'tasks\.py$|@shared_task|@app\.task' > 04a_worker_files.txt        # Celery
rg -n '\.delay\(|\.apply_async\(' -g '*.py' > 04b_worker_enqueues.txt
rg -ln 'serializers\.py$|serializers\.(Model)?Serializer' > 06_response_shaping.txt
rg -ln 'permissions\.py$|permission_classes|BasePermission' > 05c_policies.txt
rg -n 'AUTH_USER_MODEL|AUTHENTICATION_BACKENDS' -g 'settings*.py' > 09_tokens_actors.txt
```
Django has no service/finder convention — treat `views.py`/`selectors.py`/`services.py` as
05a if present; note directory-derived in the manifest. GraphQL (graphene) if present:
`rg -ln 'graphene|strawberry' `.

## Python / FastAPI

```bash
rg -n 'FastAPI\(|@app\.(get|post|put|patch|delete)|@router\.(get|post|put|patch|delete)' -g '*.py' > 01_routes.txt
cp 01_routes.txt 02_rest_api.txt
rg -n 'OAuth2PasswordBearer|HTTPBearer|APIKeyHeader|Depends\(.*(auth|user)' -g '*.py' > 09_tokens_actors.txt
rg -ln 'BaseModel' -g '*.py' > 06_response_shaping.txt   # Pydantic response models
```
Workers (if Celery/Arq): reuse the Django enqueue patterns. Authz lives in `dependencies/`,
`core/security.py` — directory-derived for 05c.

## Node / Express

```bash
rg -n '\b(app|router)\.(get|post|put|patch|delete|use)\(' -g '*.{js,ts}' > 01_routes.txt
cp 01_routes.txt 02_rest_api.txt
rg -n 'passport\.(use|authenticate)|jsonwebtoken|jwt\.(sign|verify)|req\.(user|session)' -g '*.{js,ts}' > 09_tokens_actors.txt
rg -ln 'new Queue\(|new Worker\(|\.add\(' -g '*.{js,ts}' > 04a_worker_files.txt   # BullMQ
```
Services/middleware/serializers are directory-derived (`services/`, `middlewares/`).

## Node / NestJS

```bash
rg -ln '@Controller\(' -g '*.ts' > 01_routes.txt; cp 01_routes.txt 02_rest_api.txt
rg -ln '@Resolver\(' -g '*.ts' > 03a_graphql_files.txt
rg -n '@(Query|Mutation|Subscription|ResolveField)\(' -g '*.ts' > 03b_graphql_decls.txt
rg -ln '\.guard\.ts$' > 05c_policies.txt
rg -n '@UseGuards|@SetMetadata' -g '*.ts' >> 05c_policies.txt
rg -ln '@Processor\(|@Injectable\(\).*Consumer' -g '*.ts' > 04a_worker_files.txt
rg -ln '\.service\.ts$' > 05a_services.txt
rg -ln '\.dto\.ts$|/dto/' > 06_response_shaping.txt
```

## Go (Gin/Echo/Chi/Fiber/stdlib)

```bash
rg -n '\.(GET|POST|PUT|PATCH|DELETE|HandleFunc)\(|http\.HandleFunc' -g '*.go' > 01_routes.txt
cp 01_routes.txt 02_rest_api.txt
rg -n 'grpc\.NewServer|Register\w+Server' -g '*.go' > 03b_graphql_decls.txt   # RPC surface (gRPC in place of GraphQL)
find . -name '*.proto' -not -path '*/vendor/*' > 03a_graphql_files.txt
rg -ln 'internal/service|Service\b' -g '*.go' > 05a_services.txt   # directory-derived
rg -n 'jwt|Bearer|context\.Value|r\.Header\.Get\(.Authorization' -g '*.go' > 09_tokens_actors.txt
```
Workers/authz/serializers are usually directory-derived in Go — note it in the manifest.

## Java / Spring Boot

```bash
rg -n '@(RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)' -g '*.java' > 01_routes.txt
cp 01_routes.txt 02_rest_api.txt
rg -ln '@RestController|@Controller' -g '*.java' >> 02_rest_api.txt
rg -n '@PreAuthorize|@PostAuthorize|@Secured|hasRole|hasAuthority' -g '*.java' > 05c_policies.txt
rg -ln '@Service\b' -g '*.java' > 05a_services.txt
rg -ln '@Repository\b' -g '*.java' > 05b_finders.txt
rg -ln 'class \w+DTO|/dto/' -g '*.java' > 06_response_shaping.txt
rg -n '@Async|@Scheduled|@EnableAsync' -g '*.java' > 04a_worker_files.txt
rg -n 'AddAuthentication|SecurityFilterChain|jwt|Bearer' -g '*.java' > 09_tokens_actors.txt
```

## Rust (Axum/Actix/Rocket)

```bash
rg -n 'Router::new|App::new\(\)|rocket::build|HttpServer::new' -g '*.rs' > 01_routes.txt
rg -n '\.route\(|\.service\(|#\[(get|post|put|patch|delete|route)\(' -g '*.rs' >> 01_routes.txt
cp 01_routes.txt 02_rest_api.txt
rg -n 'jsonwebtoken|Bearer|extract::(State|Extension)|middleware' -g '*.rs' > 09_tokens_actors.txt
```
Services/authz/serializers directory-derived (`handlers/`, `middleware/`, `serde` derives).

## .NET / ASP.NET Core

```bash
rg -ln '\w+Controller\.cs$' > 01_routes.txt; cp 01_routes.txt 02_rest_api.txt
rg -n '\[Authorize|\[AllowAnonymous|AddAuthentication|AddAuthorization' -g '*.cs' > 05c_policies.txt
rg -ln '\w+Service\.cs$' > 05a_services.txt
rg -ln '/Models/|\w+Dto\.cs$' > 06_response_shaping.txt
rg -n 'IHostedService|BackgroundService|Hangfire|BackgroundJob\.' -g '*.cs' > 04a_worker_files.txt
```

## PHP / Laravel

```bash
rg -n 'Route::(get|post|put|patch|delete|resource|apiResource)' routes/ > 01_routes.txt
rg -n 'Route::(get|post|put|patch|delete|resource|apiResource)' routes/api.php > 02_rest_api.txt
rg -ln 'app/Policies/' > 05c_policies.txt; rg -n '->authorize\(|@can\b|Gate::' -g '*.php' >> 05c_policies.txt
rg -ln 'app/Services/' > 05a_services.txt
rg -ln 'app/Jobs/|ShouldQueue' -g '*.php' > 04a_worker_files.txt
rg -n 'dispatch\(|->onQueue\(' -g '*.php' > 04b_worker_enqueues.txt
rg -ln 'JsonResource|app/Http/Resources/' -g '*.php' > 06_response_shaping.txt
```

## Elixir / Phoenix

```bash
find lib -name 'router.ex' > 01_routes.txt
rg -n '\b(get|post|put|patch|delete|resources|scope|pipe_through|forward)\b' lib/*_web/router.ex >> 01_routes.txt
cp 01_routes.txt 02_rest_api.txt
find lib -name '*_channel.ex' > 03a_graphql_files.txt   # channels (or absinthe files if GraphQL)
rg -ln 'plug ' lib/*_web/ > 05c_policies.txt            # plugs = authz pipeline
rg -n 'Guardian|Pow|conn.assigns.current_user|get_session' -g '*.ex' > 09_tokens_actors.txt
```

---

## Cross-stack meaning-based inventories (run on ALL stacks, tune the file globs)

```bash
# 07 downloads / exports / archives / signed URLs / object storage
rg -n 'send_file|send_data|send_git|X-Sendfile|X-Accel-Redirect|presigned|signed_url|generate_presigned|StreamingResponse|FileResponse|res\.download|ServeFile|PhysicalFile|Storage::|to_csv|export|archive|\.zip|\.tar' \
   --glob '!{node_modules,vendor,dist,build,target,.git}/**' > 07_downloads_exports.txt
# 08 search / count / aggregate / badge
rg -n '\.count\b|\.size\b|\.sum\(|\.exists\?|aggregate|group_by|search|elasticsearch|\bquery\b|\bfilter\b|badge' \
   --glob '!{node_modules,vendor,dist,build,target,.git}/**' > 08_search_count.txt
# 09 tokens / actors / principals  (append stack-specific results from above)
rg -n 'current_user|current_actor|req\.user|principal|Authorization|Bearer|access_token|api_key|deploy_token|job_token|jwt|session\[' \
   --glob '!{node_modules,vendor,dist,build,target,.git}/**' >> 09_tokens_actors.txt
```

## Coverage honesty

The source methodology is strongest on **routes** (every stack) and **authz** (Rails, Nest,
Spring, .NET, Laravel). It is weak — directory-derived or absent — on **GraphQL, serializers,
and tokens/actors** outside Rails. When an inventory is directory-derived rather than
pattern-matched, say so in `00_MANIFEST.md`; do not present a thin inventory as exhaustive.
When you hit a stack not covered here, add a block in this same shape (manifest signals →
layout → the 9 inventory commands → notes) — the skill is meant to grow.
