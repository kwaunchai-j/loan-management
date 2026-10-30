#!/usr/bin/env bash
# Checks a running deployment from the OUTSIDE (T-1001), the way the internet sees it.
#   deploy/scripts/verify-deploy.sh https://loan.example.co.th
#   CURL_OPTS=-k deploy/scripts/verify-deploy.sh https://localhost      # local test certificate
# Run it from a computer that is NOT the server, so the "closed ports" check means something.
# It sends no real credentials and changes no data (the throttle check uses a made-up user name).
set -uo pipefail
BASE="${1:?usage: verify-deploy.sh https://your-domain}"
BASE="${BASE%/}"
HOST="$(printf '%s' "$BASE" | sed -E 's#^[a-z]+://##; s#[:/].*$##')"
CURL_OPTS="${CURL_OPTS:-}"
fail=0
ok()  { printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; fail=1; }
# shellcheck disable=SC2086
get() { curl -sS $CURL_OPTS --max-time 15 "$@"; }

echo "HTTPS and routing — $BASE"
code="$(get -o /dev/null -w '%{http_code}' "$BASE/api/health")"; [ "$code" = 200 ] && ok "GET /api/health is 200" || bad "GET /api/health gave $code"
code="$(get -o /dev/null -w '%{http_code}' "$BASE/api/auth/me")"; [ "$code" = 401 ] && ok "GET /api/auth/me without a session is 401" || bad "GET /api/auth/me gave $code (want 401)"
code="$(get -o /dev/null -w '%{http_code}' "$BASE/login")"; [ "$code" = 200 ] && ok "GET /login is 200" || bad "GET /login gave $code"
for p in /api/admin/settings /api/admin/borrowers /api/admin/contracts /api/admin/reports/outstanding /api/admin/slips/x.png /api/admin/imports /api/me/contracts; do
  code="$(get -o /dev/null -w '%{http_code}' "$BASE$p")"
  [ "$code" = 401 ] && ok "$p refuses an anonymous visitor (401)" || bad "$p gave $code (want 401)"
done
if [ "${BASE#https://}" != "$BASE" ]; then
  code="$(get -o /dev/null -w '%{http_code}' "http://$HOST/login")"
  case "$code" in 301|302|307|308) ok "plain http redirects to https ($code)";; *) bad "plain http gave $code (want a redirect)";; esac
fi

echo "Security headers on a page"
headers="$(get -D - -o /dev/null "$BASE/login" | tr -d '\r')"
has() { printf '%s\n' "$headers" | grep -qi "^$1:" ; }
has strict-transport-security && ok "Strict-Transport-Security" || bad "Strict-Transport-Security missing"
has x-frame-options          && ok "X-Frame-Options" || bad "X-Frame-Options missing"
has x-content-type-options   && ok "X-Content-Type-Options" || bad "X-Content-Type-Options missing"
has content-security-policy  && ok "Content-Security-Policy" || bad "Content-Security-Policy missing"
has x-powered-by             && bad "X-Powered-By is exposed" || ok "no X-Powered-By"
has server                   && bad "Server header is exposed" || ok "no Server header"

echo "Installable app (PWA)"
sw="$(get -D - -o /dev/null "$BASE/sw.js" | tr -d '\r')"
printf '%s\n' "$sw" | head -1 | grep -q ' 200' && ok "/sw.js is served" || bad "/sw.js is not served"
printf '%s\n' "$sw" | grep -qi '^cache-control:.*no-store' && ok "/sw.js is never cached" || bad "/sw.js can be cached"
for p in /manifest.webmanifest /offline.html /icon-192.png /icon-512.png /apple-touch-icon.png; do
  code="$(get -o /dev/null -w '%{http_code}' "$BASE$p")"; [ "$code" = 200 ] && ok "$p" || bad "$p gave $code"
done

echo "Internal services are closed from outside ($HOST)"
for port in 5432 4000 3000; do
  if (exec 3<>"/dev/tcp/$HOST/$port") 2>/dev/null; then bad "port $port is open"; else ok "port $port is closed"; fi
done

echo "Login throttling cannot be dodged with a forged X-Forwarded-For"
user="nobody-$(date +%s)-$RANDOM"
last=""
for i in 1 2 3 4 5 6 7 8; do
  last="$(get -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "X-Forwarded-For: 203.0.113.$i" \
    -d "{\"username\":\"$user\",\"password\":\"wrong-password-$i\"}" "$BASE/api/auth/login")"
done
[ "$last" = 429 ] && ok "8 wrong logins from 'different' forged addresses are still locked out (429)" || bad "no lock-out after 8 wrong logins (last answer $last): the proxy may trust forged addresses"

echo
if [ "$fail" = 0 ]; then echo "ALL CHECKS PASSED"; else echo "SOME CHECKS FAILED"; fi
exit "$fail"
