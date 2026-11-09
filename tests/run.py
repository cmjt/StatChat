#!/usr/bin/env python3
"""Run StatChat's tests locally, without Google:   python3 tests/run.py

Needs a JavaScript engine: Node.js (`node`) or GNOME's `gjs`.
  1. Syntax-checks every src/*.gs file, every <script> in src/*.html, and all .gs files
     together (Apps Script shares one global scope, so a name defined twice is an error).
  2. Runs each tests/test_*.js against fake Sheets/Cache/Lock/Utilities services
     (tests/harness.js) with all src/*.gs loaded.
"""
import glob, json, os, re, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = shutil.which('node') or shutil.which('gjs')
if not ENGINE:
    sys.exit('Need node or gjs to run the tests.')

# print() in gjs, console.log() in node
PRELUDE = "const out = (typeof print === 'function') ? print : (...a) => console.log(...a);\n"

def read(p): return open(p, encoding='utf-8').read()
def rel(p): return os.path.relpath(p, ROOT)

def run_js(code):
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as f:
        f.write(PRELUDE + code); path = f.name
    try:
        r = subprocess.run([ENGINE, path], capture_output=True, text=True)
        return r.returncode, (r.stdout + r.stderr).rstrip()
    finally:
        os.unlink(path)

gs_files = sorted(glob.glob(os.path.join(ROOT, 'src', '*.gs')))
html_files = sorted(glob.glob(os.path.join(ROOT, 'src', '*.html')))
bundle = '\n'.join(read(f) for f in gs_files)

# ---- 1. syntax ----
checks = [(rel(f), read(f)) for f in gs_files]
checks.append(('all src/*.gs together', bundle))
for f in html_files:
    for i, s in enumerate(re.findall(r'<script>(.*?)</script>', read(f), re.S), 1):
        checks.append((f'{rel(f)} <script #{i}>', s))
code, output = run_js(
    'const checks = ' + json.dumps(checks) + ';\nlet bad = 0;\n'
    'for (const [n, s] of checks) { try { new Function(s); out("  ok   " + n); }'
    ' catch (e) { bad++; out("  FAIL " + n + ": " + e.message); } }\n'
    'out(bad ? "RESULT: FAIL" : "RESULT: PASS");\n')
print('Syntax'); print(output)
failed = code != 0 or 'RESULT: PASS' not in output

# Included files are inserted as plain text (createHtmlOutputFromFile), so <? ?> tags in
# them reach the browser unevaluated. Template tags belong in the page shells only.
included = set(re.findall(r"include\('([\w]+)'\)", ''.join(read(f) for f in html_files)))
for n in sorted(included):
    if '<?' in read(os.path.join(ROOT, 'src', n + '.html')):
        print(f'  FAIL src/{n}.html is included, so its <? ?> tags are never evaluated')
        failed = True

# ---- 2. behaviour tests ----
harness = read(os.path.join(ROOT, 'tests', 'harness.js'))
page_harness = read(os.path.join(ROOT, 'tests', 'page_harness.js'))
server_fns = sorted(set(re.findall(r'^\s*function\s+([A-Za-z_$][\w$]*)\s*\(', bundle, re.M)))

def page_scripts(page):
    """The <script> code of src/<page>_*.html includes, in include order, as one string."""
    # Inline the includes as Apps Script does, then take every <script> in page order
    shell = read(os.path.join(ROOT, 'src', page + '.html'))
    html = re.sub(r"<\?!=\s*include\('([\w]+)'\)\s*\?>",
                  lambda m: read(os.path.join(ROOT, 'src', m.group(1) + '.html')), shell)
    # The shell's own <script>init();</script> is left out: tests call init() once their fake
    # sheets are set up
    code = [c for c in re.findall(r'<script>(.*?)</script>', html, re.S) if c.strip() != 'init();']
    return '\n'.join(code).replace("'<?= inst ?>'", "''")

for t in sorted(glob.glob(os.path.join(ROOT, 'tests', 'test_*.js'))):
    test = read(t)
    m = re.match(r'\s*// @page (\w+)', test)
    if m:
        # Page test: the page runs in its own scope (it may reuse server function names) and
        # reaches the server only through the fake google.script.run, as in production.
        server = 'const __SERVER = {' + ', '.join(f'{n}: {n}' for n in server_fns) + '};\n'
        body = (harness + '\n' + bundle + '\n' + server + '(function () {\n' + page_harness + '\n'
                + page_scripts(m.group(1)) + '\n' + test + '\n})();\nfinish();\n')
    else:
        body = harness + '\n' + bundle + '\n' + test + '\nfinish();\n'
    code, output = run_js(body)
    print('\n' + rel(t)); print(output)
    if code != 0 or 'RESULT: PASS' not in output:
        failed = True

print('\n' + ('SOME TESTS FAILED' if failed else 'ALL TESTS PASSED') + f'  (engine: {os.path.basename(ENGINE)})')
sys.exit(1 if failed else 0)
