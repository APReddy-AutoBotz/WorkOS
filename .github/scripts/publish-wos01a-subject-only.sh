#!/usr/bin/env bash
set -euo pipefail

: "${OLD_TARGET_HEAD:?OLD_TARGET_HEAD is required}"
: "${TARGET_BRANCH:?TARGET_BRANCH is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

SERVER_PATH='server/index.mjs'
TEST_PATH='tests/production-identity-smoke.mjs'
EVIDENCE_PATH='docs/evidence/v0.2.0/DOC-WOS-01-001-SOURCE-BOOTSTRAP.md'

test "$(git rev-parse HEAD)" = "$OLD_TARGET_HEAD"

python3 - <<'PY'
from pathlib import Path

server_path = Path('server/index.mjs')
test_path = Path('tests/production-identity-smoke.mjs')
evidence_path = Path('docs/evidence/v0.2.0/DOC-WOS-01-001-SOURCE-BOOTSTRAP.md')

server = server_path.read_text()
subject_gate = "    if (!providerSubject && !upn) {\n"
if server.count(subject_gate) != 1:
    raise SystemExit(f'provider subject requirement: expected one match, found {server.count(subject_gate)}')
server = server.replace(subject_gate, "    if (!providerSubject) {\n", 1)

fallback_start_marker = "    if (!user && upn) {\n"
active_user_marker = "    if (!user || user.status !== 'Active') {\n"
if server.count(fallback_start_marker) != 1:
    raise SystemExit(f'email fallback start: expected one match, found {server.count(fallback_start_marker)}')
fallback_start = server.index(fallback_start_marker)
fallback_end = server.index(active_user_marker, fallback_start)
fallback = server[fallback_start:fallback_end]
for fragment in ['fetchUserAuthRowByWhere', 'lower(u.email)', 'lower(ipl.provider_upn)', 'lower(e.email)', '[upn]']:
    if fragment not in fallback:
        raise SystemExit(f'email fallback structure mismatch: missing {fragment}')
server = server[:fallback_start] + server[fallback_end:]
if fallback_start_marker in server or 'where lower(u.email) = lower($1)' in server:
    raise SystemExit('email fallback remained after structural removal')
server_path.write_text(server)

test = test_path.read_text()
insertion_marker = "  const afterRejectedUsers = Number((await pool.query('select count(*)::int as count from users')).rows[0].count);\n"
if test.count(insertion_marker) != 1:
    raise SystemExit(f'email-only fixture insertion point: expected one match, found {test.count(insertion_marker)}')
if "name: 'email-only-unlinked-identity'" in test:
    raise SystemExit('email-only fixture already exists')
fixture = """  const emailOnlyAddress = 'email-only.user@example.test';
  const emailOnlySubject = 'email-only-provider-subject';
  const emailOnlyUser = await pool.query(`
    insert into users (username, email, status)
    values ('email-only-user', $1, 'Active')
    returning id
  `, [emailOnlyAddress]);
  await pool.query(
    'insert into user_roles (user_id, role_id) select $1, id from roles order by name limit 1',
    [emailOnlyUser.rows[0].id],
  );

  await assertCallbackRejected({
    name: 'email-only-unlinked-identity',
    claimOverrides: {
      oid: emailOnlySubject,
      preferred_username: emailOnlyAddress,
    },
    expectedLocation: '/login?error=entra_unlinked_user',
  });

  const emailOnlyUserState = await pool.query(
    'select entra_object_id from users where id = $1',
    [emailOnlyUser.rows[0].id],
  );
  const emailOnlyLinks = await pool.query(`
    select count(*)::int as count
    from identity_provider_links
    where provider = 'entra'
      and (provider_subject = $1 or lower(provider_upn) = lower($2))
  `, [emailOnlySubject, emailOnlyAddress]);
  assert.equal(emailOnlyUserState.rows[0]?.entra_object_id, null, 'email-only rejection must not link the user');
  assert.equal(Number(emailOnlyLinks.rows[0]?.count || 0), 0, 'email-only rejection must not create an identity-provider link');
  await pool.query('delete from users where id = $1', [emailOnlyUser.rows[0].id]);

"""
test = test.replace(insertion_marker, fixture + insertion_marker, 1)
test_path.write_text(test)

evidence = evidence_path.read_text().rstrip()
heading = '## WOS-01A Entra subject-only account-linking closure'
if heading in evidence:
    raise SystemExit('subject-only evidence section already exists')
evidence_path.write_text(evidence + """

## WOS-01A Entra subject-only account-linking closure

Interactive Entra login resolves only a pre-provisioned Entra provider subject or object identifier. A token UPN or email address is audit context only and cannot select an otherwise unlinked WorkOS user, create an identity-provider link, or authorize a session.

The retained production identity fixture provisions an active user whose email matches a valid signed Entra token but whose provider subject is not linked. The callback must return `entra_unlinked_user`, emit no WorkOS session cookie, leave the user Entra object identifier empty, create no `identity_provider_links` row, and leave user/employee counts unchanged after fixture cleanup. The separate linked-subject case remains the only successful callback path.
""" + '\n')
PY

node --check "$SERVER_PATH"
node --check "$TEST_PATH"
node scripts/verify-baseline.mjs
node scripts/scan-bootstrap.mjs --self-test
node scripts/scan-bootstrap.mjs
git diff --check
mapfile -t changed < <(git status --porcelain | sed 's/^...//' | sort)
printf '%s\n' "${changed[@]}"
test "${#changed[@]}" -eq 3
test "${changed[0]}" = "$EVIDENCE_PATH"
test "${changed[1]}" = "$SERVER_PATH"
test "${changed[2]}" = "$TEST_PATH"

trusted_origin="https://github.com/${GITHUB_REPOSITORY}.git"
git remote set-url origin "$trusted_origin"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
git config --local core.hooksPath /dev/null
git config user.name "WorkOS Implementation Controller"
git config user.email "actions@users.noreply.github.com"
auth_header="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)"
remote_head="$(git -c http.https://github.com/.extraheader="$auth_header" ls-remote origin "refs/heads/$TARGET_BRANCH" | cut -f1)"
test "$remote_head" = "$OLD_TARGET_HEAD"
git checkout -B "$TARGET_BRANCH" "$OLD_TARGET_HEAD"
git add "$SERVER_PATH" "$TEST_PATH" "$EVIDENCE_PATH"
git diff --cached --check
git commit --no-verify -m "fix: require subject-linked Entra identities"
new_head="$(git rev-parse HEAD)"
git -c core.hooksPath=/dev/null -c http.https://github.com/.extraheader="$auth_header" push --no-verify \
  --force-with-lease="refs/heads/$TARGET_BRANCH:$OLD_TARGET_HEAD" \
  origin "HEAD:refs/heads/$TARGET_BRANCH"
echo "Published subject-only identity closure: $new_head"
