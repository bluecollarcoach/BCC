#!/usr/bin/env bash
# Smoke test for the deployed BCC Internal app.
#
# Hits every known route and checks the HTTP status against the expected one.
# This catches dead routes and obvious 5xx after a deploy. It does NOT catch
# behind-auth render bugs — for those you'd need a Playwright session.
#
# Usage:
#   ./scripts/smoke.sh                       # default URL = prod
#   BASE_URL=http://localhost:3000 ./scripts/smoke.sh   # against local dev
#
# Exits 0 if all checks pass, 1 if any fail.

set -uo pipefail

BASE_URL="${BASE_URL:-https://bccinternal-web-cmos6krt7roia.azurewebsites.net}"
TIMEOUT="${TIMEOUT:-15}"

# Format: METHOD|PATH|EXPECTED
ROUTES=(
  # Public
  "GET|/|307"
  "GET|/sign-in|200"
  "GET|/api/health|200"
  "GET|/api/auth/providers|200"
  "GET|/api/auth/csrf|200"
  "GET|/api/auth/session|200"

  # Authenticated workspace (307 for unauthed probe = route exists, redirects to /sign-in)
  "GET|/dashboard|307"
  "GET|/crm|307"
  "GET|/crm/contacts/new|307"
  "GET|/crm/contacts/import|307"
  "GET|/crm/deals|307"
  "GET|/crm/deals/new|307"
  "GET|/crm/companies|307"
  "GET|/crm/companies/new|307"
  "GET|/api/crm/contacts/export|307"

  # Documents (POST-only endpoint returns 405 for GET, which is correct + alive)
  "GET|/api/documents|405"

  "GET|/time|307"
  "GET|/chat|307"
  "GET|/calendar|307"
  "GET|/calendar?week=2026-06-01|307"
  "GET|/calendar/new|307"
  "GET|/marketing|307"
  "GET|/marketing/new|307"
  "GET|/events|307"
  "GET|/events/new|307"
  "GET|/bookkeeping|307"
  "GET|/documents|307"
  "GET|/training|307"
  "GET|/settings|307"

  # Admin
  "GET|/admin|307"
  "GET|/admin/users|307"
  "GET|/admin/audit|307"
  "GET|/admin/integrations|307"
  "GET|/admin/settings|307"
  "GET|/admin/kb|307"

  # Integration connect endpoints (307 — they redirect to provider or back to admin)
  "GET|/api/integrations/qbo/connect|307"
  "GET|/api/integrations/google-ads/connect|307"
  "GET|/api/integrations/linkedin/connect|307"
  "GET|/api/integrations/meta/connect|307"

  # Static brand assets
  "GET|/bcc-icon.png|200"
  "GET|/bcc-logo-full.png|200"
  "GET|/bcc-icon.svg|200"
)

pass=0
fail=0
failures=()

echo "Smoke testing: $BASE_URL"
echo "─────────────────────────────────────────────────"

for r in "${ROUTES[@]}"; do
  IFS='|' read -r method path expected <<< "$r"
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    -X "$method" --max-time "$TIMEOUT" "$BASE_URL$path")
  if [[ "$code" == "$expected" ]]; then
    pass=$((pass + 1))
    printf "  ✓ %-44s  %s\n" "$path" "$code"
  else
    fail=$((fail + 1))
    failures+=("$path -- got $code, expected $expected")
    printf "  ✗ %-44s  got %s, expected %s\n" "$path" "$code" "$expected"
  fi
done

echo "─────────────────────────────────────────────────"
echo "RESULT: $pass passed, $fail failed"

if [[ $fail -gt 0 ]]; then
  echo ""
  echo "Failures:"
  for f in "${failures[@]}"; do
    echo "  - $f"
  done
  exit 1
fi
