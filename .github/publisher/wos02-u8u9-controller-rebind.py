from pathlib import Path

def once(text, old, new, label):
    count = text.count(old)
    assert count == 1, f"{label}: expected 1 occurrence, got {count}"
    return text.replace(old, new, 1)

workflow_path = Path('.github/workflows/wos02-final-review-acceptance.yml')
w = workflow_path.read_text()

w = once(w, '  TARGET_HEAD: ff278306c5394d3c43d0c860a736d783ad59d19c',
         '  TARGET_HEAD: 28edf2f1966e293c44ca4d173a2ad0a2857e6b2b', 'target head')
w = once(w, '  TARGET_TREE: d81d00223cc64d1db25695395bc0b696f82e34cd',
         '  TARGET_TREE: 23c9d49046e0af9a1540f71690825ef2845e5c07', 'target tree')
w = once(w, '- name: Verify exact product controller main and 43-file authority',
         '- name: Verify exact product controller main and 44-file authority', 'authority label')

trigger = "      - '.github/scripts/wos02-reporting-period-acceptance.mjs'\n"
assert w.count(trigger) == 1
w = w.replace(trigger, trigger + "      - '.github/scripts/wos02-reporting-period-u8u9-acceptance.mjs'\n", 1)

migration29 = "              'server/migrations/029_wos02_working_calendar_authority.sql',\n"
assert w.count(migration29) == 1
w = w.replace(migration29, migration29 + "              'server/migrations/030_wos02_reporting_period_frequency.sql',\n", 1)

syntax_marker = "          node --check ../controller/.github/scripts/wos02-mutation-lifecycle-acceptance.mjs\n"
assert w.count(syntax_marker) == 1
w = w.replace(
    syntax_marker,
    syntax_marker
    + "          node --check ../controller/.github/scripts/wos02-reporting-period-acceptance.mjs\n"
    + "          node --check ../controller/.github/scripts/wos02-reporting-period-u8u9-acceptance.mjs\n",
    1,
)

db_list = "wos02_mutation_lifecycle wos02_reporting_period wos02_readiness"
assert w.count(db_list) == 1
w = w.replace(db_list, "wos02_mutation_lifecycle wos02_reporting_period wos02_reporting_u8u9 wos02_readiness", 1)

w = once(w, '- name: Fresh install and replay migrations 022 through 029',
         '- name: Fresh install and replay migrations 022 through 030', 'fresh migration label')

old_ids = """ids="'022_organization_setup_foundation','023_wos02_scope_lifecycle_integrity','024_wos02_final_review_closure','025_wos02_timesheet_scope_integrity','025a_wos02_project_legal_scope_unique_prerequisite','026_wos02_canonical_legal_scope_integrity','027_wos02_reporting_period_authority','028_wos02_organization_legal_entity_profiles','029_wos02_working_calendar_authority'\""""
new_ids = """ids="'022_organization_setup_foundation','023_wos02_scope_lifecycle_integrity','024_wos02_final_review_closure','025_wos02_timesheet_scope_integrity','025a_wos02_project_legal_scope_unique_prerequisite','026_wos02_canonical_legal_scope_integrity','027_wos02_reporting_period_authority','028_wos02_organization_legal_entity_profiles','029_wos02_working_calendar_authority','030_wos02_reporting_period_frequency'\""""
w = once(w, old_ids, new_ids, 'fresh migration ids')

count_line = 'test "$(psql "$DATABASE_URL" -Atc "select count(*) from schema_migrations where id in ($ids)")" = 9'
assert w.count(count_line) == 2, f"migration count lines={w.count(count_line)}"
w = w.replace(count_line, count_line[:-1] + '10')

old_names = "const names=['025_wos02_timesheet_scope_integrity.sql','025a_wos02_project_legal_scope_unique_prerequisite.sql','026_wos02_canonical_legal_scope_integrity.sql','027_wos02_reporting_period_authority.sql','028_wos02_organization_legal_entity_profiles.sql','029_wos02_working_calendar_authority.sql'];"
new_names = "const names=['025_wos02_timesheet_scope_integrity.sql','025a_wos02_project_legal_scope_unique_prerequisite.sql','026_wos02_canonical_legal_scope_integrity.sql','027_wos02_reporting_period_authority.sql','028_wos02_organization_legal_entity_profiles.sql','029_wos02_working_calendar_authority.sql','030_wos02_reporting_period_frequency.sql'];"
w = once(w, old_names, new_names, 'migration lexical order')

old_constraint = """          test "$(psql "$DATABASE_URL" -Atc "select count(*) from pg_constraint where conname='reporting_period_ranges_no_overlap'")" = 1
"""
new_constraint = """          test "$(psql "$DATABASE_URL" -Atc "select count(*) from pg_constraint where conname='reporting_period_ranges_no_overlap'")" = 0
          test "$(psql "$DATABASE_URL" -Atc "select count(*) from pg_constraint where conname='reporting_period_frequency_ranges_no_overlap'")" = 1
          test "$(psql "$DATABASE_URL" -Atc "select count(*) from reporting_periods where frequency is null or frequency not in ('Weekly','Monthly','Fiscal')")" = 0
"""
w = once(w, old_constraint, new_constraint, 'frequency constraint evidence')

line29 = """          test "$(psql "$DATABASE_URL" -Atc "select count(*) from schema_migrations where id='029_wos02_working_calendar_authority'")" = 1
"""
occurrences = w.count(line29)
assert occurrences >= 3, f"migration 029 evidence occurrences={occurrences}"
line30 = """          test "$(psql "$DATABASE_URL" -Atc "select count(*) from schema_migrations where id='030_wos02_reporting_period_frequency'")" = 1
"""
w = w.replace(line29, line29 + line30)

w = once(w, '- name: Exact WOS-01A upgrade backfill reconciliation and replay through 029',
         '- name: Exact WOS-01A upgrade backfill reconciliation and replay through 030', 'upgrade label')

move29 = """          mv target/server/migrations/029_wos02_working_calendar_authority.sql "$RUNNER_TEMP/029_wos02_working_calendar_authority.sql"
"""
move30 = """          mv target/server/migrations/030_wos02_reporting_period_frequency.sql "$RUNNER_TEMP/030_wos02_reporting_period_frequency.sql"
"""
w = once(w, move29, move29 + move30, 'move migration 030')

restore29 = """          mv "$RUNNER_TEMP/029_wos02_working_calendar_authority.sql" target/server/migrations/029_wos02_working_calendar_authority.sql
"""
restore30 = """          mv "$RUNNER_TEMP/030_wos02_reporting_period_frequency.sql" target/server/migrations/030_wos02_reporting_period_frequency.sql
"""
w = once(w, restore29, restore29 + restore30, 'restore migration 030')

legacy_status = """          test "$(psql "$UPGRADE_URL" -Atc "select status from reporting_periods where code='RP-LEGACY-LOCKED' and organization_id='org-default' and legal_entity_id='legal-default'")" = 'Financially Locked'
"""
legacy_frequency = """          test "$(psql "$UPGRADE_URL" -Atc "select frequency from reporting_periods where code='RP-LEGACY-LOCKED' and organization_id='org-default' and legal_entity_id='legal-default'")" = 'Weekly'
"""
w = once(w, legacy_status, legacy_status + legacy_frequency, 'legacy frequency backfill')

readiness_marker = """      - name: Execute guided setup readiness completeness matrix
"""
u8u9_step = """      - name: Execute U8-U9 multi-frequency per-entry reporting acceptance matrix
        shell: bash
        working-directory: controller
        env:
          TARGET_ROOT: ${{ github.workspace }}/target
          DATABASE_URL: postgresql://workos:workos@127.0.0.1:5432/wos02_reporting_u8u9
        run: |
          set -euo pipefail
          (cd "$TARGET_ROOT" && DATABASE_URL="$DATABASE_URL" node server/migrate.mjs)
          node .github/scripts/wos02-reporting-period-u8u9-acceptance.mjs

"""
w = once(w, readiness_marker, u8u9_step + readiness_marker, 'U8/U9 live step')

assert 'ff278306c5394d3c43d0c860a736d783ad59d19c' not in w
assert 'd81d00223cc64d1db25695395bc0b696f82e34cd' not in w
assert '43-file authority' not in w
assert 'through 029' not in w
assert 'server/migrations/030_wos02_reporting_period_frequency.sql' in w
assert 'wos02-reporting-period-u8u9-acceptance.mjs' in w
workflow_path.write_text(w)

script_path = Path('.github/scripts/wos02-reporting-period-acceptance.mjs')
s = script_path.read_text()
s = once(
    s,
    "const periodBody = (code, startsOn, endsOn, status, name = code) => ({ code, name, startsOn, endsOn, status });",
    "const periodBody = (code, startsOn, endsOn, status, name = code, frequency = 'Weekly') => ({ code, name, frequency, startsOn, endsOn, status });",
    'frequency request model',
)
assert s.count('reporting_period_ranges_no_overlap') == 2, s.count('reporting_period_ranges_no_overlap')
s = s.replace('reporting_period_ranges_no_overlap', 'reporting_period_frequency_ranges_no_overlap')
s = once(
    s,
    "insert into reporting_periods(organization_id,legal_entity_id,code,name,starts_on,ends_on,status) values",
    "insert into reporting_periods(organization_id,legal_entity_id,code,name,frequency,starts_on,ends_on,status) values",
    'ambiguous raw columns',
)
s = once(
    s,
    "('org-rp','legal-rp','RP-AMB-A','Ambiguous A','2026-08-03','2026-08-09','Open')",
    "('org-rp','legal-rp','RP-AMB-A','Ambiguous A','Weekly','2026-08-03','2026-08-09','Open')",
    'ambiguous row A',
)
s = once(
    s,
    "('org-rp','legal-rp','RP-AMB-B','Ambiguous B','2026-08-03','2026-08-09','Open')",
    "('org-rp','legal-rp','RP-AMB-B','Ambiguous B','Weekly','2026-08-03','2026-08-09','Open')",
    'ambiguous row B',
)
s = once(
    s,
    "(organization_id with =, legal_entity_id with =, daterange(starts_on,ends_on + 1,'[)') with &&)",
    "(organization_id with =, legal_entity_id with =, frequency with =, daterange(starts_on,ends_on + 1,'[)') with &&)",
    'frequency exclusion restore',
)
assert "frequency = 'Weekly'" in s
assert 'reporting_period_frequency_ranges_no_overlap' in s
script_path.write_text(s)
