from pathlib import Path

script = Path('.github/scripts/wos02-mutation-lifecycle-acceptance.mjs')
source = script.read_text()
helper_anchor = "const assertUnchanged = (before, after) => assert.deepEqual(after, before);\n"
helper = "const toIsoDate = value => value instanceof Date ? value.toISOString().slice(0,10) : String(value ?? '').slice(0,10);\n"
if source.count(helper_anchor) != 1:
    raise SystemExit('date helper insertion anchor is not exact')
if helper in source:
    raise SystemExit('date helper already present')
source = source.replace(helper_anchor, helper_anchor + helper, 1)
old = "String(after.employee.exit_date).slice(0,10)"
if source.count(old) != 3:
    raise SystemExit(f'expected exactly 3 raw exit-date assertions, found {source.count(old)}')
source = source.replace(old, "toIsoDate(after.employee.exit_date)")
script.write_text(source)
