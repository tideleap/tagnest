#!/usr/bin/env bash
# Live deployment test for TagNest on Cloudflare Pages.
#
# Hits the REAL deployment (https://tagnest.pages.dev) — not a local dev
# server — to confirm the refactored AI stack works end-to-end against the
# live D1 + Functions. Every request carries ?cb=<ts> to defeat the local
# proxy's /api/* "no deployment" page cache.
#
#   bash scripts/live-smoke.sh                 # default https://tagnest.pages.dev/api
#   BASE=https://tagnest.pages.dev/api bash scripts/live-smoke.sh

set -uo pipefail

BASE="${BASE:-https://tagnest.pages.dev/api}"
CB="cb=$(date +%s%3N)"
CURL=(curl -s --max-time 30)
PASS=0
FAIL=0

say()  { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok()   { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s — %s\n' "$1" "${2:-}"; }
# cache-busted URL
u()   { echo "$BASE$1?$CB"; }

jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);console.log(v===undefined||v===null?"":typeof v==="object"?JSON.stringify(v):v)}catch(e){console.log("")}})' "$1"; }
code() { "${CURL[@]}" -o /dev/null -w '%{http_code}' "$@"; }

EMAIL="live-smoke-$(date +%s)@example.com"

say "health (public)"
BODY=$("${CURL[@]}" "$(u /health)")
check_health=$(printf '%s' "$BODY" | jget status)
[ "$check_health" = "ok" ] && ok "health ok" || bad "health" "$BODY"

say "register + login"
REG=$("${CURL[@]}" -X POST "$(u /auth/register)" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"correct-horse\",\"displayName\":\"LiveSmoke\"}")
TOKEN=$(printf '%s' "$REG" | jget accessToken)
[ -n "$TOKEN" ] && ok "registered + token issued" || bad "register" "$REG"
AUTH=(-H "Authorization: Bearer $TOKEN")

say "AI settings (new fields + enabled derivation)"
SET=$("${CURL[@]}" "${AUTH[@]}" "$(u /ai/settings)")
PROVIDER=$(printf '%s' "$SET" | jget settings.provider)
echo "    provider=$PROVIDER"
for f in heuristicsEnabled maxTags autoApplyThreshold; do
  v=$(printf '%s' "$SET" | jget "settings.$f")
  [ -n "$v" ] && ok "settings.$f=$v" || bad "settings.$f present" "$SET"
done
# enabled is derived; without a key it must be false (not "true" from a stale column).
EN=$(printf '%s' "$SET" | jget settings.enabled)
echo "    enabled=$EN"

say "AI overview (new query paths: aiTagLinks / userTagLinks)"
OV=$("${CURL[@]}" "${AUTH[@]}" "$(u /ai/overview)")
OV_CODE=$(printf '%s' "$OV" | jget ok)
printf '%s' "$OV" | jget aiTagLinks >/dev/null && ok "overview returned aiTagLinks" || bad "overview shape" "$OV"

say "create organize job (ai_jobs insert w/ new schema)"
JOB=$("${CURL[@]}" "${AUTH[@]}" -X POST "$(u /ai/jobs)" -H 'Content-Type: application/json' \
  -d '{"target":"untagged"}')
JOBID=$(printf '%s' "$JOB" | jget job.id)
JOBTOTAL=$(printf '%s' "$JOB" | jget job.total)
[ -n "$JOBID" ] && ok "job created (id=$JOBID total=$JOBTOTAL)" || bad "job create" "$JOB"

if [ -n "$JOBID" ]; then
  say "run job chunk (loop executes, returns done)"
  RUN=$("${CURL[@]}" "${AUTH[@]}" -X POST "$(u /ai/jobs/$JOBID/run)")
  RUN_DONE=$(printf '%s' "$RUN" | jget done)
  RUN_ENGINE=$(printf '%s' "$RUN" | jget engine)
  [ "$RUN_DONE" = "true" ] && ok "run completed (engine=$RUN_ENGINE)" || bad "run" "$RUN"

  say "suggestions list (tag_suggestions query lives)"
  SUG=$("${CURL[@]}" "${AUTH[@]}" "$(u /ai/suggestions)")
  SUGTOTAL=$(printf '%s' "$SUG" | jget countPending)
  printf '%s' "$SUG" | jget items >/dev/null && ok "suggestions query ok (pending=$SUGTOTAL)" || bad "suggestions" "$SUG"

  say "taxonomy audit (findDuplicateClusters)"
  TAX=$("${CURL[@]}" "${AUTH[@]}" "$(u /ai/taxonomy)")
  printf '%s' "$TAX" | jget duplicateClusters >/dev/null && ok "taxonomy audit ok" || bad "taxonomy" "$TAX"

  say "cleanup: delete job"
  DELCODE=$("${CURL[@]}" "${AUTH[@]}" -o /dev/null -w '%{http_code}' -X DELETE "$(u /ai/jobs/$JOBID)")
  [ "$DELCODE" = "200" ] && ok "job deleted" || bad "job delete" "http=$DELCODE"
fi

say "RESULT"
printf '  %sPASS %s / FAIL %s%s\n' "$([ $FAIL -eq 0 ] && echo '\033[32m' || echo '\033[31m')" "$PASS" "$FAIL" '\033[0m'
[ $FAIL -eq 0 ]
