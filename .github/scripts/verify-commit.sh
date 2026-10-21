#!/usr/bin/env bash
# Smoke test after a roll: /healthz must answer 200 AND report the commit we
# just deployed.
#
#   verify-commit.sh <base-url> <expected-sha>
#
# Why the commit and not just the 200: rolloutState=COMPLETED says ECS is
# happy, not that the floating tag it pulled is the image this run built. A
# 200 from the previous release looks exactly like success; the commit
# (Dockerfile ARG APP_COMMIT) is what tells them apart.
#
# Polls for a minute: the load balancer can still hand a request or two to a
# draining task just after the service goes stable.
set -euo pipefail

url="${1%/}/healthz"
want="$2"

for _ in $(seq 1 12); do
  body=$(curl -s --max-time 20 -w '\n%{http_code}' "$url" || true)
  code=$(tail -n1 <<<"$body")
  got=$(head -n -1 <<<"$body" | jq -r '.commit // empty' 2>/dev/null || true)
  echo "healthz -> $code, commit=${got:-?}"
  if [ "$code" = "200" ] && [ "$got" = "$want" ]; then
    exit 0
  fi
  sleep 5
done

echo "::error::$url never reported commit $want (last: HTTP $code, commit '${got:-?}')."
exit 1
