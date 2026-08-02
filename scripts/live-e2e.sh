#!/usr/bin/env bash
# End-to-end deployment test on the LIVE Cloudflare Pages deployment.
#
# Exercises the full refactored AI organise pipeline against real D1:
#   register -> create bookmarks -> AI settings -> create job (by id)
#   -> run job (heuristic engine, no key) -> suggestions generated
#   -> accept a suggestion -> bookmark gets a tag -> cleanup.
#
# Every request carries ?cb=<ts> to defeat the local proxy's /api/* cache.
#   BASE=https://tagnest.pages.dev/api bash scripts/live-e2e.sh

set -uo pipefail

BASE="${BASE:-https://tagnest.pages.dev/api}"
CB="cb=$(date +%s%3N)"
CURL=(curl -s --max-time 30)
PASS=0
FAIL=0

say()  { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok()   { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s — %s\n' "$1" "${2:-}"; }
u()    { echo "$BASE$1?$CB"; }

jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);console.log(v===undefined||v===null?"":typeof v==="object"?JSON.stringify(v):v)}catch(e){console.log("")}})' "$1"; }
jlen() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(Array.isArray(JSON.parse(s))?JSON.parse(s).length:0)}catch(e){console.log(0)}})'; }

EMAIL="e2e-$(date +%s)@example.com"

say "register"
REG=$("${CURL[@]}" -X POST "$(u /auth/register)" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"correct-horse\",\"displayName\":\"E2E\"}")
TOKEN=$(printf '%s' "$REG" | jget accessToken)
[ -n "$TOKEN" ] && ok "registered" || { bad "register" "$REG"; exit 1; }
AUTH=(-H "Authorization: Bearer $TOKEN")

say "create 2 bookmarks"
B1=$("${CURL[@]}" "${AUTH[@]}" -X POST "$(u /bookmarks)" -H 'Content-Type: application/json' \
  -d '{"url":"https://react.dev/learn","title":"React 学习","description":"React 官方教程，讲解组件与 hooks 用法"}')
B1ID=$(printf '%s' "$B1" | jget id)
B2=$("${CURL[@]}" "${AUTH[@]}" -X POST "$(u /bookmarks)" -H 'Content-Type: application/json' \
  -d '{"url":"https://tailwindcss.com/docs","title":"Tailwind 文档","description":"Tailwind CSS 工具类框架文档站点"}')
B2ID=$(printf '%s' "$B2" | jget id)
[ -n "$B1ID" ] && [ -n "$B2ID" ] && ok "bookmarks created ($B1ID, $B2ID)" || bad "bookmark create" "$B1 / $B2"

say "AI settings (new fields present on live deploy)"
SET=$("${CURL[@]}" "${AUTH[@]}" "$(u /ai/settings)")
HE=$("${CURL[@]}" "${AUTH[@]}" "$(u /ai/settings)" | jget heuristicsEnabled)
MT=$("${CURL[@]}" "${AUTH[@]}" "$(u /ai/settings)" | jget maxTags)
AT=$("${CURL[@]}" "${AUTH[@]}" "$(u /ai/settings)" | jget autoApplyThreshold)
echo "    heuristicsEnabled=$HE maxTags=$MT autoApplyThreshold=$AT"
[ "$HE" = "true" ] && [ -n "$MT" ] && [ -n "$AT" ] && ok "settings exposes new workflow fields" || bad "settings fields" "$SET"

say "create organize job (target=ids)"
JOB=$("${CURL[@]}" "${AUTH[@]}" -X POST "$(u /ai/jobs)" -H 'Content-Type: application/json' \
  -d "{\"target\":\"ids\",\"bookmarkIds\":[\"$B1ID\",\"$B2ID\"]}")
JOBID=$(printf '%s' "$JOB" | jget job.id)
JOBTOTAL=$(printf '%s' "$JOB" | jget job.total)
[ -n "$JOBID" ] && [ "${JOBTOTAL:-0}" -ge 1 ] && ok "job created (total=$JOBTOTAL)" || bad "job create" "$JOB"

if [ -n "$JOBID" ]; then
  say "run job chunk (heuristic engine, no API key)"
  RUN=$("${CURL[@]}" "${AUTH[@]}" -X POST "$(u /ai/jobs/$JOBID/run)")
  RUN_DONE=$(printf '%s' "$RUN" | jget done)
  RUN_ENGINE=$(printf '%s' "$RUN" | jget engine)
  RUN_SUG=$(printf '%s' "$RUN" | jget suggested)
  [ "$RUN_DONE" = "true" ] && ok "run completed (engine=$RUN_ENGINE, suggested=$RUN_SUG)" || bad "run" "$RUN"

  say "suggestions list (tag_suggestions live query)"
  SUG=$("${CURL[@]}" "${AUTH[@]}" "$(u /ai/suggestions)")
  N=$(printf '%s' "$SUG" | jget suggestions | jlen)
  [ "$N" -ge 1 ] && ok "suggestions generated ($N)" || bad "suggestions" "$SUG"

  say "accept first suggestion -> bookmark gets a tag"
  FIRSTID=$(printf '%s' "$SUG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).suggestions[0].id)}catch(e){console.log("")}})')
  if [ -n "$FIRSTID" ]; then
    APPLY=$("${CURL[@]}" "${AUTH[@]}" -X POST "$(u /ai/suggestions/apply)" -H 'Content-Type: application/json' \
      -d "{\"ids\":[\"$FIRSTID\"],\"action\":\"accept\"}")
    AACC=$(printf '%s' "$APPLY" | jget accepted)
    [ "$AACC" = "1" ] && ok "suggestion accepted (accepted=$AACC)" || bad "accept" "$APPLY"
    # The accepted suggestion's bookmark should now carry at least one tag.
    TGT=$(printf '%s' "$SUG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).suggestions[0].bookmarkId)}catch(e){console.log("")}})')
    BM=$("${CURL[@]}" "${AUTH[@]}" "$(u /bookmarks/$TGT)")
    BMTAGS=$(printf '%s' "$BM" | jget tags | jlen)
    [ "$BMTAGS" -ge 1 ] && ok "accepted tag landed on bookmark ($BMTAGS tag(s))" || bad "bookmark tags after accept" "$BM"
  fi

  say "taxonomy audit (findDuplicateClusters live)"
  TAX=$("${CURL[@]}" "${AUTH[@]}" "$(u /ai/taxonomy)")
  printf '%s' "$TAX" | jget duplicateClusters >/dev/null && ok "taxonomy audit ok" || bad "taxonomy" "$TAX"

  say "cleanup"
  "${CURL[@]}" -o /dev/null -X DELETE "$(u /ai/jobs/$JOBID)"
  "${CURL[@]}" -o /dev/null -X DELETE "$(u /bookmarks/$B1ID)"
  "${CURL[@]}" -o /dev/null -X DELETE "$(u /bookmarks/$B2ID)"
fi

say "RESULT"
printf '  %sPASS %s / FAIL %s%s\n' "$([ $FAIL -eq 0 ] && echo '\033[32m' || echo '\033[31m')" "$PASS" "$FAIL" '\033[0m'
[ $FAIL -eq 0 ]
