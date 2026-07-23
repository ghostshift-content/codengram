#!/usr/bin/env bash
# build-inventories.sh — scaffold phase1-maps/ and run the universal (cross-stack) inventories.
# Usage: build-inventories.sh <repo-root> [out-dir]
#   out-dir defaults to <repo-root>/phase1-maps
# Read-only against the source. Stack-specific inventories (01–06) are per-language — see
# references/enumeration-by-language.md and run the matching block; this script does Step-0
# scale + the meaning-based inventories (07/08/09) that work on ANY stack, and scaffolds dirs.
# ponytail: universal parts only; per-stack 01–06 are intentionally left to the language block.
set -euo pipefail

ROOT="${1:-.}"
OUT="${2:-$ROOT/phase1-maps}"
EXCL='!{node_modules,vendor,dist,build,target,.git,__pycache__,coverage,bin,obj,.next,.nuxt}/**'
cd "$ROOT"
mkdir -p "$OUT/inventories" "$OUT/features" "$OUT/consolidated"

command -v rg >/dev/null || { echo "ripgrep (rg) is required" >&2; exit 1; }

echo "== scale =="
echo "-- files per top-level dir --"
for d in */; do printf "%-32s %7d\n" "$(basename "$d")" "$(find "$d" -type f 2>/dev/null | wc -l)"; done
echo "-- language mix --"
find . -type f \( -name '*.rb' -o -name '*.py' -o -name '*.js' -o -name '*.ts' -o -name '*.go' \
  -o -name '*.java' -o -name '*.kt' -o -name '*.rs' -o -name '*.cs' -o -name '*.php' -o -name '*.ex' \) \
  -not -path '*/node_modules/*' -not -path '*/vendor/*' -not -path '*/.git/*' \
  | sed 's/.*\.//' | sort | uniq -c | sort -rn

echo "== universal inventories (07/08/09) =="
{ echo "# Download/export/archive/signed-url/object-storage sites"
  rg -n --glob "$EXCL" 'send_file|send_data|X-Sendfile|X-Accel-Redirect|presigned|signed_url|generate_presigned|StreamingResponse|FileResponse|res\.download|ServeFile|to_csv|export|archive|\.zip|\.tar' . 2>/dev/null || true
} > "$OUT/inventories/07_downloads_exports.txt"

{ echo "# Search/count/aggregate/badge sites"
  rg -n --glob "$EXCL" '\.count\b|\.exists\?|aggregate|group_by|\bsearch\b|elasticsearch|badge' . 2>/dev/null || true
} > "$OUT/inventories/08_search_count.txt"

{ echo "# Token/actor/principal selection sites"
  rg -n --glob "$EXCL" 'current_user|current_actor|req\.user|principal|Authorization|Bearer|access_token|api_key|deploy_token|job_token|\bjwt\b|session\[' . 2>/dev/null || true
} > "$OUT/inventories/09_tokens_actors.txt"

echo "== counts (minus header line) =="
for f in "$OUT"/inventories/0[789]_*.txt; do
  printf "%-40s %7d\n" "$(basename "$f")" "$(( $(wc -l < "$f") - 1 ))"
done

echo "Scaffold ready at: $OUT"
echo "Next: run the stack-specific block from references/enumeration-by-language.md for 01–06,"
echo "then map features into $OUT/features/ and consolidate into $OUT/consolidated/."
