#!/usr/bin/env bash
# End-to-end smoke test against a running `wrangler pages dev`.
#
# Exercises the full happy path plus the failure modes that are easy to get
# wrong: duplicate detection, tenant isolation, soft delete, trash-only purge,
# and CJK search.
#
#   npm run dev:api        # terminal 1
#   bash scripts/smoke.sh  # terminal 2

set -uo pipefail

BASE="${BASE:-http://127.0.0.1:8788/api}"
CURL=(curl -s --noproxy '*')
JAR="$(mktemp)"
PASS=0
FAIL=0

say()  { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok()   { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s — %s\n' "$1" "${2:-}"; }

check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3], got [$2]"; fi
}

jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);console.log(v===undefined||v===null?"":typeof v==="object"?JSON.stringify(v):v)}catch(e){console.log("")}})' "$1"; }

EMAIL="smoke-$(date +%s)@example.com"

say "health"
BODY=$("${CURL[@]}" "$BASE/health")
check "database reachable" "$(printf '%s' "$BODY" | jget status)" "ok"

say "register"
BODY=$("${CURL[@]}" -c "$JAR" -X POST "$BASE/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"correct-horse\",\"displayName\":\"冒烟测试\"}")
TOKEN=$(printf '%s' "$BODY" | jget accessToken)
[ -n "$TOKEN" ] && ok "access token issued" || bad "access token issued" "$BODY"
check "display name stored" "$(printf '%s' "$BODY" | jget user.displayName)" "冒烟测试"

AUTH=(-H "Authorization: Bearer $TOKEN")

say "auth guards"
CODE=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/bookmarks")
check "unauthenticated list rejected" "$CODE" "401"

CODE=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/register" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"correct-horse\"}")
check "duplicate email rejected" "$CODE" "409"

CODE=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"wrong-password\"}")
check "wrong password rejected" "$CODE" "401"

CODE=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/register" \
  -H 'Content-Type: application/json' -d '{"email":"not-an-email","password":"short"}')
check "invalid credentials rejected" "$CODE" "400"

say "create bookmarks"
BODY=$("${CURL[@]}" "${AUTH[@]}" -X POST "$BASE/bookmarks" -H 'Content-Type: application/json' \
  -d '{"url":"https://developer.mozilla.org/zh-CN/docs/Web/CSS","title":"MDN CSS 参考手册","tagNames":["前端","文档"]}')
BM1=$(printf '%s' "$BODY" | jget id)
[ -n "$BM1" ] && ok "bookmark created" || bad "bookmark created" "$BODY"
check "favicon derived" "$(printf '%s' "$BODY" | jget faviconUrl | grep -c 'developer.mozilla.org')" "1"
check "two tags attached" "$(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tags.length))')" "2"

# Same page, different tracking parameters — must collapse to one bookmark.
CODE=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST "$BASE/bookmarks" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://developer.mozilla.org/zh-CN/docs/Web/CSS?utm_source=newsletter"}')
check "tracking-param duplicate rejected" "$CODE" "409"

CODE=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST "$BASE/bookmarks" \
  -H 'Content-Type: application/json' -d '{"url":"javascript:alert(1)"}')
check "javascript: URL rejected" "$CODE" "400"

"${CURL[@]}" "${AUTH[@]}" -X POST "$BASE/bookmarks" -H 'Content-Type: application/json' \
  -d '{"url":"https://www.rust-lang.org/learn","title":"Rust 学习资源","tagNames":["rust"]}' > /dev/null
"${CURL[@]}" "${AUTH[@]}" -X POST "$BASE/bookmarks" -H 'Content-Type: application/json' \
  -d '{"url":"https://vitejs.dev/guide/","title":"Vite Guide","isFavorite":true}' > /dev/null

say "list & scopes"
BODY=$("${CURL[@]}" "${AUTH[@]}" "$BASE/bookmarks?scope=all")
check "three bookmarks listed" "$(printf '%s' "$BODY" | jget total)" "3"

BODY=$("${CURL[@]}" "${AUTH[@]}" "$BASE/bookmarks?scope=favorites")
check "favorites scope" "$(printf '%s' "$BODY" | jget total)" "1"

# Inbox = live, unarchived, untagged. Only the Vite entry qualifies.
BODY=$("${CURL[@]}" "${AUTH[@]}" "$BASE/bookmarks?scope=inbox")
check "inbox scope (untagged only)" "$(printf '%s' "$BODY" | jget total)" "1"

say "search"
BODY=$("${CURL[@]}" "${AUTH[@]}" "$BASE/bookmarks?q=rust")
check "latin search" "$(printf '%s' "$BODY" | jget total)" "1"

BODY=$("${CURL[@]}" "${AUTH[@]}" "$BASE/bookmarks?q=%E5%8F%82%E8%80%83%E6%89%8B%E5%86%8C")
check "cjk search (4 chars, FTS path)" "$(printf '%s' "$BODY" | jget total)" "1"

BODY=$("${CURL[@]}" "${AUTH[@]}" "$BASE/bookmarks?q=%E5%AD%A6%E4%B9%A0")
check "cjk search (2 chars, LIKE fallback)" "$(printf '%s' "$BODY" | jget total)" "1"

BODY=$("${CURL[@]}" "${AUTH[@]}" "$BASE/bookmarks?q=%22OR%201%3D1")
check "punctuation in query is inert" "$(printf '%s' "$BODY" | jget total)" "0"

say "pagination"
BODY=$("${CURL[@]}" "${AUTH[@]}" "$BASE/bookmarks?scope=all&limit=2")
CURSOR=$(printf '%s' "$BODY" | jget nextCursor)
[ -n "$CURSOR" ] && ok "cursor returned" || bad "cursor returned" "$BODY"
BODY=$("${CURL[@]}" "${AUTH[@]}" "$BASE/bookmarks?scope=all&limit=2&cursor=$CURSOR")
check "second page has remainder" "$(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).items.length))')" "1"

say "tags"
BODY=$("${CURL[@]}" "${AUTH[@]}" "$BASE/tags")
check "three tags exist" "$(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length))')" "3"

TAG_FE=$(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).find(x=>x.name==="前端");console.log(t?t.id:"")})')
TAG_DOC=$(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).find(x=>x.name==="文档");console.log(t?t.id:"")})')

BODY=$("${CURL[@]}" "${AUTH[@]}" -X POST "$BASE/tags/merge" -H 'Content-Type: application/json' \
  -d "{\"sourceIds\":[\"$TAG_DOC\"],\"targetId\":\"$TAG_FE\"}")
check "tags merged" "$(printf '%s' "$BODY" | jget merged)" "1"

BODY=$("${CURL[@]}" "${AUTH[@]}" "$BASE/tags")
check "tag count after merge" "$(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length))')" "2"

say "trash lifecycle"
BODY=$("${CURL[@]}" "${AUTH[@]}" -X POST "$BASE/bookmarks/trash" -H 'Content-Type: application/json' -d "{\"ids\":[\"$BM1\"]}")
check "moved to trash" "$(printf '%s' "$BODY" | jget moved)" "1"

BODY=$("${CURL[@]}" "${AUTH[@]}" "$BASE/bookmarks?scope=all")
check "trashed row hidden from all" "$(printf '%s' "$BODY" | jget total)" "2"

BODY=$("${CURL[@]}" "${AUTH[@]}" "$BASE/bookmarks?scope=trash")
check "trash scope shows it" "$(printf '%s' "$BODY" | jget total)" "1"

BODY=$("${CURL[@]}" "${AUTH[@]}" -X POST "$BASE/bookmarks/restore" -H 'Content-Type: application/json' -d "{\"ids\":[\"$BM1\"]}")
check "restored" "$(printf '%s' "$BODY" | jget restored)" "1"

# A live bookmark must survive purge: only trashed rows may be destroyed.
BODY=$("${CURL[@]}" "${AUTH[@]}" -X POST "$BASE/bookmarks/purge" -H 'Content-Type: application/json' -d "{\"ids\":[\"$BM1\"]}")
check "purge refuses live rows" "$(printf '%s' "$BODY" | jget deleted)" "0"

say "bulk tagging"
BODY=$("${CURL[@]}" "${AUTH[@]}" "$BASE/bookmarks?scope=all")
ALL_IDS=$(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s).items.map(i=>i.id))))')
BODY=$("${CURL[@]}" "${AUTH[@]}" -X POST "$BASE/bookmarks/bulk-tag" -H 'Content-Type: application/json' \
  -d "{\"ids\":$ALL_IDS,\"addTagNames\":[\"批量\"]}")
check "bulk tag applied" "$(printf '%s' "$BODY" | jget updated)" "3"

say "import"
FIXTURE="$(mktemp).html"
cat > "$FIXTURE" <<'HTML'
<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000">技术</H3>
    <DL><p>
        <DT><A HREF="https://news.ycombinator.com/" ADD_DATE="1700000001">Hacker News</A>
        <DT><A HREF="https://github.com/" ADD_DATE="1700000002">GitHub &amp; Friends</A>
        <DT><A HREF="https://vitejs.dev/guide/">Vite Guide</A>
        <DT><A HREF="place:sort=8">Recently Bookmarked</A>
    </DL><p>
    <DT><H3>阅读</H3>
    <DL><p>
        <DT><A HREF="https://www.zhihu.com/">知乎</A>
    </DL><p>
</DL><p>
HTML

BODY=$("${CURL[@]}" "${AUTH[@]}" -X POST "$BASE/import/preview" -F "file=@$FIXTURE;filename=bookmarks.html")
check "parsed 4 valid entries"    "$(printf '%s' "$BODY" | jget total)" "4"
check "1 duplicate detected"      "$(printf '%s' "$BODY" | jget duplicates)" "1"
check "1 invalid entry skipped"   "$(printf '%s' "$BODY" | jget invalid)" "1"
check "2 folders found"           "$(printf '%s' "$BODY" | jget folders)" '["技术","阅读"]'

IMPORT_TOKEN=$(printf '%s' "$BODY" | jget token)
BODY=$("${CURL[@]}" "${AUTH[@]}" -X POST "$BASE/import/commit" -H 'Content-Type: application/json' \
  -d "{\"token\":\"$IMPORT_TOKEN\",\"foldersAsTags\":true,\"skipDuplicates\":true,\"extraTagNames\":[\"导入\"]}")
check "3 imported"     "$(printf '%s' "$BODY" | jget imported)" "3"
check "1 skipped"      "$(printf '%s' "$BODY" | jget skipped)" "1"
check "0 failed"       "$(printf '%s' "$BODY" | jget failed)" "0"

CODE=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST "$BASE/import/commit" \
  -H 'Content-Type: application/json' -d "{\"token\":\"$IMPORT_TOKEN\"}")
check "staging token is single-use" "$CODE" "404"

say "export"
BODY=$("${CURL[@]}" "${AUTH[@]}" "$BASE/export?format=html")
check "html export is netscape format" "$(printf '%s' "$BODY" | grep -c 'NETSCAPE-Bookmark-file-1')" "1"
BODY=$("${CURL[@]}" "${AUTH[@]}" "$BASE/export?format=json")
check "json export round-trips" "$(printf '%s' "$BODY" | jget application)" "TagNest"
BODY=$("${CURL[@]}" "${AUTH[@]}" "$BASE/export?format=csv")
check "csv export has header" "$(printf '%s' "$BODY" | head -1 | grep -c 'url,title')" "1"

say "stats"
BODY=$("${CURL[@]}" "${AUTH[@]}" "$BASE/stats")
check "six live bookmarks" "$(printf '%s' "$BODY" | jget bookmarks)" "6"
check "one favorite"       "$(printf '%s' "$BODY" | jget favorites)" "1"

say "ai settings (stored, inert)"
BODY=$("${CURL[@]}" "${AUTH[@]}" -X PUT "$BASE/ai/settings" -H 'Content-Type: application/json' \
  -d '{"provider":"openai","model":"gpt-4o-mini","apiKey":"sk-secret-value","enabled":true}')
check "provider persisted" "$(printf '%s' "$BODY" | jget provider)" "openai"
check "hasApiKey flag set" "$(printf '%s' "$BODY" | jget hasApiKey)" "true"
check "raw key never returned" "$(printf '%s' "$BODY" | grep -c 'sk-secret-value')" "0"

# Saving unrelated fields must not wipe the stored key.
BODY=$("${CURL[@]}" "${AUTH[@]}" -X PUT "$BASE/ai/settings" -H 'Content-Type: application/json' -d '{"autoTag":true}')
check "key survives partial update" "$(printf '%s' "$BODY" | jget hasApiKey)" "true"

say "tenant isolation"
OTHER=$("${CURL[@]}" -X POST "$BASE/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"other-$(date +%s)@example.com\",\"password\":\"correct-horse\"}" | jget accessToken)
CODE=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $OTHER" "$BASE/bookmarks/$BM1")
check "cannot read another account's bookmark" "$CODE" "404"
BODY=$("${CURL[@]}" -H "Authorization: Bearer $OTHER" "$BASE/bookmarks?scope=all")
check "other account sees empty library" "$(printf '%s' "$BODY" | jget total)" "0"

say "session refresh"
BODY=$("${CURL[@]}" -b "$JAR" -c "$JAR" -X POST "$BASE/auth/refresh")
check "refresh issues new token" "$(printf '%s' "$BODY" | jget user.email)" "$EMAIL"
CODE=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -b "$JAR" -X POST "$BASE/auth/logout")
check "logout succeeds" "$CODE" "204"

rm -f "$JAR" "$FIXTURE"

printf '\n\033[1m%s passed, %s failed\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
