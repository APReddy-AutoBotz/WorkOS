#!/usr/bin/env bash
set -uo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <controller-root> <target-root> <current-main-root>" >&2
  exit 64
fi

CONTROLLER_ROOT="$(cd "$1" && pwd)"
TARGET_ROOT="$(cd "$2" && pwd)"
MAIN_ROOT="$(cd "$3" && pwd)"
EVIDENCE_DIR="$TARGET_ROOT/.acceptance-evidence"
mkdir -p "$EVIDENCE_DIR"

: "${CONTROLLER_HEAD:?CONTROLLER_HEAD is required}"
: "${TARGET_PR:?TARGET_PR is required}"
: "${TARGET_BRANCH:?TARGET_BRANCH is required}"
: "${TARGET_HEAD:?TARGET_HEAD is required}"
: "${PARENT_PR:?PARENT_PR is required}"
: "${PARENT_BRANCH:?PARENT_BRANCH is required}"
: "${PARENT_HEAD:?PARENT_HEAD is required}"
: "${EXPECTED_MAIN_HEAD:?EXPECTED_MAIN_HEAD is required}"
: "${ACCEPTED_WOS00_BASE:?ACCEPTED_WOS00_BASE is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${PGHOST:?PGHOST is required}"
: "${PGPORT:?PGPORT is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"

export PGPASSWORD

declare -A GATE_STATUS=()
GATE_ORDER=()
FAILED=0

require_gate() {
  local name="$1"
  if [[ "${GATE_STATUS[$name]:-NOT_RUN}" != "PASS" ]]; then
    echo "Prerequisite gate $name is ${GATE_STATUS[$name]:-NOT_RUN}" >&2
    return 1
  fi
}

run_gate() {
  local name="$1"
  shift
  local log="$EVIDENCE_DIR/${name}.log"
  GATE_ORDER+=("$name")
  echo "===== START $name ====="
  set +e
  ( "$@" ) 2>&1 | tee "$log"
  local rc=${PIPESTATUS[0]}
  set -e
  if [[ $rc -eq 0 ]]; then
    GATE_STATUS[$name]="PASS"
    echo "===== PASS $name ====="
  else
    GATE_STATUS[$name]="FAIL"
    FAILED=1
    echo "===== FAIL $name rc=$rc =====" >&2
  fi
}

repository_boundary() {
  set -euo pipefail
  test "$(git -C "$CONTROLLER_ROOT" rev-parse HEAD)" = "$CONTROLLER_HEAD"
  test "$(git -C "$TARGET_ROOT" rev-parse HEAD)" = "$TARGET_HEAD"
  test "$(git -C "$MAIN_ROOT" rev-parse HEAD)" = "$EXPECTED_MAIN_HEAD"
  git -C "$TARGET_ROOT" cat-file -e "$PARENT_HEAD^{commit}"
  test "$(git -C "$TARGET_ROOT" merge-base "$TARGET_HEAD" "$PARENT_HEAD")" = "$PARENT_HEAD"
  test "$(git -C "$MAIN_ROOT" merge-base "$TARGET_HEAD" HEAD)" = "$ACCEPTED_WOS00_BASE"
  local drift
  drift="$(git -C "$MAIN_ROOT" diff --name-only "$ACCEPTED_WOS00_BASE..HEAD" | grep -Ev '^\.github/' || true)"
  test -z "$drift"
  test -z "$(git -C "$CONTROLLER_ROOT" status --porcelain)"
  test -z "$(git -C "$TARGET_ROOT" status --porcelain)"
  test -z "$(git -C "$MAIN_ROOT" status --porcelain)"
  if git -C "$TARGET_ROOT" ls-files | grep -Eq '(^|/)\.git(/|$)'; then
    echo "Imported Git-history path detected" >&2
    return 1
  fi
  printf 'controller=%s\ntarget_pr=%s\ntarget=%s\nparent_pr=%s\nparent=%s\nmain=%s\nwos00=%s\n' \
    "$CONTROLLER_HEAD" "$TARGET_PR" "$TARGET_HEAD" "$PARENT_PR" "$PARENT_HEAD" \
    "$EXPECTED_MAIN_HEAD" "$ACCEPTED_WOS00_BASE" > "$EVIDENCE_DIR/exact-inputs.txt"
}

controller_regression() {
  set -euo pipefail
  cd "$CONTROLLER_ROOT"
  node .github/scripts/verify-wos01a-controller-v2.mjs
}

browser_lifecycle_regression() {
  set -euo pipefail
  cd "$CONTROLLER_ROOT"
  node .github/scripts/test-wos01a-browser-lifecycle-v2.mjs
}

locked_install() {
  set -euo pipefail
  cd "$TARGET_ROOT"
  npm ci
}

engineering_controls() {
  set -euo pipefail
  require_gate locked_install
  cd "$TARGET_ROOT"
  node scripts/verify-baseline.mjs
  node scripts/scan-bootstrap.mjs --self-test
  npm run test:bootstrap-scan
  npm run typecheck
  npm run lint
  env NODE_ENV=test APP_MODE=test VITE_APP_MODE=test ALLOW_TEST_FALLBACK=true VITE_ALLOW_TEST_FALLBACK=true npm test
}

dependency_classification() {
  set -euo pipefail
  require_gate locked_install
  cd "$TARGET_ROOT"
  local runtime_rc=0 full_rc=0
  npm audit --omit=dev --json > "$EVIDENCE_DIR/npm-audit-runtime.json" || runtime_rc=$?
  npm audit --json > "$EVIDENCE_DIR/npm-audit-full.json" || full_rc=$?
  RUNTIME_RC="$runtime_rc" FULL_RC="$full_rc" EVIDENCE_DIR="$EVIDENCE_DIR" node --input-type=module <<'NODE'
  import {readFileSync, writeFileSync} from 'node:fs';
  import path from 'node:path';

  const evidence = process.env.EVIDENCE_DIR;
  const parse = (name, exitCode) => {
    const report = JSON.parse(readFileSync(path.join(evidence, name), 'utf8'));
    const raw = report.metadata?.vulnerabilities;
    const levels = ['info', 'low', 'moderate', 'high', 'critical', 'total'];
    if (!raw || levels.some(level => !Number.isInteger(raw[level]) || raw[level] < 0)) {
      throw new Error(`${name} does not contain complete vulnerability metadata`);
    }
    return {
      exitCode,
      counts: Object.fromEntries(levels.map(level => [level, Number(raw[level])])),
      packages: Object.entries(report.vulnerabilities || {})
        .map(([packageName, value]) => ({
          name: packageName,
          severity: value.severity,
          direct: Boolean(value.isDirect),
          range: value.range,
          fixAvailable: value.fixAvailable,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  };

  const runtime = parse('npm-audit-runtime.json', Number(process.env.RUNTIME_RC));
  const full = parse('npm-audit-full.json', Number(process.env.FULL_RC));
  writeFileSync(path.join(evidence, 'npm-audit-summary.json'), `${JSON.stringify({runtime, full}, null, 2)}\n`);
  console.log(JSON.stringify({runtime, full}, null, 2));
  if (runtime.counts.high > 0 || runtime.counts.critical > 0) process.exit(1);
  if (runtime.exitCode !== 0 && runtime.counts.total === 0) process.exit(1);
  if (full.exitCode !== 0 && full.counts.total === 0) process.exit(1);
NODE
}

build_acceptance() {
  set -euo pipefail
  require_gate locked_install
  require_gate engineering_controls
  cd "$TARGET_ROOT"

  rm -rf dist
  env -u VITE_PRODUCT_NAME -u VITE_PRODUCT_LOGO_URL -u VITE_ORGANIZATION_NAME -u VITE_SUPPORT_NAME -u VITE_SUPPORT_EMAIL \
    npm run build 2>&1 | tee "$EVIDENCE_DIR/default-build.log"
  if grep -R -n -E '%VITE_[A-Z0-9_]+%' dist > "$EVIDENCE_DIR/default-build-unresolved-tokens.log"; then
    cat "$EVIDENCE_DIR/default-build-unresolved-tokens.log" >&2
    return 1
  fi
  : > "$EVIDENCE_DIR/default-build-unresolved-tokens.log"
  grep -q '<title>WorkOS</title>' dist/index.html
  grep -q 'href="/workos-mark.svg"' dist/index.html

  rm -rf dist
  VITE_APP_MODE=production \
  VITE_ALLOW_TEST_FALLBACK=false \
  VITE_PRODUCT_NAME='Configured WorkOS' \
  VITE_ORGANIZATION_NAME='Acceptance Organization' \
  VITE_PRODUCT_LOGO_URL='/configured-workos.svg' \
  VITE_SUPPORT_NAME='WorkOS Acceptance Support' \
  VITE_SUPPORT_EMAIL='support@example.test' \
    npm run build 2>&1 | tee "$EVIDENCE_DIR/configured-build.log"
  if grep -R -n -E '%VITE_[A-Z0-9_]+%' dist > "$EVIDENCE_DIR/configured-build-unresolved-tokens.log"; then
    cat "$EVIDENCE_DIR/configured-build-unresolved-tokens.log" >&2
    return 1
  fi
  : > "$EVIDENCE_DIR/configured-build-unresolved-tokens.log"
  grep -q '<title>Configured WorkOS</title>' dist/index.html
  grep -q 'href="/configured-workos.svg"' dist/index.html
  grep -R -F 'Configured WorkOS' dist/assets >/dev/null
  grep -R -F '/configured-workos.svg' dist/assets >/dev/null
}

postgres_client() {
  set -euo pipefail
  if ! command -v psql >/dev/null 2>&1; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq postgresql-client
  fi
  pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres
}

migration_acceptance() {
  set -euo pipefail
  require_gate locked_install
  require_gate postgres_client
  cd "$TARGET_ROOT"

  local db
  for db in workos_fresh workos_upgrade workos_prod; do
    dropdb --if-exists "$db"
    createdb "$db"
  done

  local fresh_url="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/workos_fresh"
  DATABASE_URL="$fresh_url" node server/migrate.mjs 2>&1 | tee "$EVIDENCE_DIR/migrate-fresh.log"
  local fresh_count
  fresh_count="$(psql "$fresh_url" -Atc 'select count(*) from schema_migrations')"
  DATABASE_URL="$fresh_url" node server/migrate.mjs 2>&1 | tee "$EVIDENCE_DIR/migrate-replay.log"
  local replay_count
  replay_count="$(psql "$fresh_url" -Atc 'select count(*) from schema_migrations')"
  test "$fresh_count" = "$replay_count"

  local upgrade_url="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/workos_upgrade"
  psql "$upgrade_url" -v ON_ERROR_STOP=1 -f server/schema.sql > "$EVIDENCE_DIR/upgrade-baseline-schema.log"
  psql "$upgrade_url" -v ON_ERROR_STOP=1 <<'SQL'
  create table if not exists schema_migrations (
    id text primary key,
    applied_at timestamptz not null default now()
  );
  insert into schema_migrations (id) values ('005_auth_lifecycle') on conflict do nothing;
SQL
  DATABASE_URL="$upgrade_url" node server/migrate.mjs 2>&1 | tee "$EVIDENCE_DIR/migrate-upgrade.log"
  DATABASE_URL="$upgrade_url" node server/migrate.mjs 2>&1 | tee "$EVIDENCE_DIR/migrate-upgrade-replay.log"

  local expected fresh_final upgrade_final
  expected="$((1 + $(find server/migrations -maxdepth 1 -type f -name '*.sql' | wc -l)))"
  fresh_final="$(psql "$fresh_url" -Atc 'select count(*) from schema_migrations')"
  upgrade_final="$(psql "$upgrade_url" -Atc 'select count(*) from schema_migrations')"
  printf 'expected=%s\nfresh=%s\nupgrade=%s\n' "$expected" "$fresh_final" "$upgrade_final" \
    | tee "$EVIDENCE_DIR/migration-counts.txt"
  test "$fresh_final" = "$expected"
  test "$upgrade_final" = "$expected"

  local prod_url="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/workos_prod"
  DATABASE_URL="$prod_url" node server/migrate.mjs 2>&1 | tee "$EVIDENCE_DIR/migrate-production-fixture.log"
}

production_acceptance() {
  set -euo pipefail
  require_gate build_acceptance
  require_gate migration_acceptance
  cd "$TARGET_ROOT"

  local prod_url="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/workos_prod"
  local before_users before_employees server_pid=''
  before_users="$(psql "$prod_url" -Atc 'select count(*) from users')"
  before_employees="$(psql "$prod_url" -Atc 'select count(*) from employees')"
  test "$before_users" = "0"
  test "$before_employees" = "0"

  cleanup_production() {
    if [[ -n "$server_pid" ]]; then
      kill "$server_pid" 2>/dev/null || true
      wait "$server_pid" 2>/dev/null || true
    fi
  }
  trap cleanup_production EXIT

  PORT=4010 \
  NODE_ENV=production \
  APP_MODE=production \
  APP_URL='http://127.0.0.1:4010' \
  AUTO_SEED_DEMO=false \
  RESET_DEMO_DATA=false \
  DATABASE_URL="$prod_url" \
  PGSSLMODE=disable \
  API_SESSION_SECRET='acceptance-only-session-secret-0123456789' \
  IDENTITY_PROVIDER=entra \
  ENTRA_TENANT_ID='00000000-0000-0000-0000-000000000001' \
  ENTRA_CLIENT_ID='00000000-0000-0000-0000-000000000002' \
  ENTRA_CLIENT_SECRET='acceptance-only-entra-secret' \
  ENTRA_REDIRECT_URI='http://127.0.0.1:4010/api/auth/entra/callback' \
  EMAIL_PROVIDER=mock \
  TEAMS_PROVIDER=mock \
    node server/start-production.mjs > "$EVIDENCE_DIR/production-server.log" 2>&1 &
  server_pid=$!
  echo "$server_pid" > "$EVIDENCE_DIR/production-server.pid"

  local ready=false attempt
  for attempt in $(seq 1 60); do
    if curl --silent --fail http://127.0.0.1:4010/api/health > "$EVIDENCE_DIR/health.json"; then
      ready=true
      break
    fi
    kill -0 "$server_pid"
    sleep 1
  done
  test "$ready" = true
  test "$(jq -r .status "$EVIDENCE_DIR/health.json")" = ok
  test "$(jq -r .database "$EVIDENCE_DIR/health.json")" = connected

  local login_status protected_status after_users after_employees
  login_status="$(curl --silent --output "$EVIDENCE_DIR/local-login.json" --write-out '%{http_code}' \
    -H 'Content-Type: application/json' -X POST \
    --data '{"username":"acceptance","password":"acceptance"}' \
    http://127.0.0.1:4010/api/auth/login)"
  test "$login_status" = 404

  protected_status="$(curl --silent --output "$EVIDENCE_DIR/protected-api.json" --write-out '%{http_code}' \
    http://127.0.0.1:4010/api/employees)"
  test "$protected_status" = 401

  after_users="$(psql "$prod_url" -Atc 'select count(*) from users')"
  after_employees="$(psql "$prod_url" -Atc 'select count(*) from employees')"
  printf 'users_before=%s\nusers_after=%s\nemployees_before=%s\nemployees_after=%s\n' \
    "$before_users" "$after_users" "$before_employees" "$after_employees" \
    | tee "$EVIDENCE_DIR/no-seed-counts.txt"
  test "$after_users" = "$before_users"
  test "$after_employees" = "$before_employees"
  cleanup_production
  server_pid=''
  trap - EXIT
}

browser_acceptance() {
  set -euo pipefail
  require_gate engineering_controls
  cd "$TARGET_ROOT"

  local preview_pid=''
  cleanup_preview() {
    if [[ -n "$preview_pid" ]]; then
      kill "$preview_pid" 2>/dev/null || true
      wait "$preview_pid" 2>/dev/null || true
    fi
  }
  trap cleanup_preview EXIT

  rm -rf dist
  VITE_APP_MODE=test \
  VITE_ALLOW_TEST_FALLBACK=true \
  VITE_PRODUCT_NAME=WorkOS \
  VITE_ORGANIZATION_NAME='Acceptance Organization' \
  VITE_PRODUCT_LOGO_URL=/workos-mark.svg \
  VITE_SUPPORT_EMAIL=support@example.test \
    npm run build 2>&1 | tee "$EVIDENCE_DIR/browser-build.log"

  ./node_modules/.bin/vite preview --host 127.0.0.1 --port 4173 > "$EVIDENCE_DIR/browser-server.log" 2>&1 &
  preview_pid=$!
  echo "$preview_pid" > "$EVIDENCE_DIR/browser-server.pid"
  local ready=false attempt
  for attempt in $(seq 1 40); do
    if curl --silent --fail http://127.0.0.1:4173/login >/dev/null; then
      ready=true
      break
    fi
    kill -0 "$preview_pid"
    sleep 0.5
  done
  test "$ready" = true
  WOS_BROWSER_ORIGIN=http://127.0.0.1:4173 \
    node "$CONTROLLER_ROOT/.github/scripts/wos01a-browser-acceptance-v2.mjs" \
    2>&1 | tee "$EVIDENCE_DIR/browser-journeys.log"
  test -z "$(git status --porcelain --untracked-files=no)"
  cleanup_preview
  preview_pid=''
  trap - EXIT
}

final_authority() {
  set -euo pipefail
  local api="https://api.github.com/repos/${GITHUB_REPOSITORY}"
  local auth=(-H "Authorization: Bearer ${GH_TOKEN}" -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28')
  curl --fail --silent --show-error "${auth[@]}" "$api/pulls/26" > "$EVIDENCE_DIR/final-controller-pr.json"
  curl --fail --silent --show-error "${auth[@]}" "$api/pulls/${TARGET_PR}" > "$EVIDENCE_DIR/final-target-pr.json"
  curl --fail --silent --show-error "${auth[@]}" "$api/pulls/${PARENT_PR}" > "$EVIDENCE_DIR/final-parent-pr.json"
  curl --fail --silent --show-error "${auth[@]}" "$api/git/ref/heads/main" > "$EVIDENCE_DIR/final-main.json"

  test "$(jq -r .state "$EVIDENCE_DIR/final-controller-pr.json")" = open
  test "$(jq -r .draft "$EVIDENCE_DIR/final-controller-pr.json")" = true
  test "$(jq -r .head.sha "$EVIDENCE_DIR/final-controller-pr.json")" = "$CONTROLLER_HEAD"
  test "$(jq -r .base.ref "$EVIDENCE_DIR/final-controller-pr.json")" = main
  test "$(jq -r .base.sha "$EVIDENCE_DIR/final-controller-pr.json")" = "$EXPECTED_MAIN_HEAD"

  test "$(jq -r .state "$EVIDENCE_DIR/final-target-pr.json")" = open
  test "$(jq -r .draft "$EVIDENCE_DIR/final-target-pr.json")" = true
  test "$(jq -r .head.ref "$EVIDENCE_DIR/final-target-pr.json")" = "$TARGET_BRANCH"
  test "$(jq -r .head.sha "$EVIDENCE_DIR/final-target-pr.json")" = "$TARGET_HEAD"
  test "$(jq -r .base.ref "$EVIDENCE_DIR/final-target-pr.json")" = "$PARENT_BRANCH"
  test "$(jq -r .base.sha "$EVIDENCE_DIR/final-target-pr.json")" = "$PARENT_HEAD"

  test "$(jq -r .state "$EVIDENCE_DIR/final-parent-pr.json")" = open
  test "$(jq -r .draft "$EVIDENCE_DIR/final-parent-pr.json")" = true
  test "$(jq -r .head.ref "$EVIDENCE_DIR/final-parent-pr.json")" = "$PARENT_BRANCH"
  test "$(jq -r .head.sha "$EVIDENCE_DIR/final-parent-pr.json")" = "$PARENT_HEAD"
  test "$(jq -r .base.ref "$EVIDENCE_DIR/final-parent-pr.json")" = main
  test "$(jq -r .base.sha "$EVIDENCE_DIR/final-parent-pr.json")" = "$ACCEPTED_WOS00_BASE"

  test "$(jq -r .object.sha "$EVIDENCE_DIR/final-main.json")" = "$EXPECTED_MAIN_HEAD"
}

rm -rf "$TARGET_ROOT/dist" "$EVIDENCE_DIR"
mkdir -p "$EVIDENCE_DIR"

run_gate repository_boundary repository_boundary
run_gate controller_regression controller_regression
run_gate browser_lifecycle_regression browser_lifecycle_regression
run_gate locked_install locked_install
run_gate engineering_controls engineering_controls
run_gate dependency_classification dependency_classification
run_gate build_acceptance build_acceptance
run_gate postgres_client postgres_client
run_gate migration_acceptance migration_acceptance
run_gate production_acceptance production_acceptance
run_gate browser_acceptance browser_acceptance
run_gate final_authority final_authority

{
  for name in "${GATE_ORDER[@]}"; do
    printf '%s=%s\n' "$name" "${GATE_STATUS[$name]}"
  done
} | tee "$EVIDENCE_DIR/gate-outcomes.txt"

if [[ $FAILED -ne 0 ]]; then
  echo "WOS-01A exact-head acceptance failed closed." >&2
  exit 1
fi

echo "WOS-01A exact-head acceptance passed."
