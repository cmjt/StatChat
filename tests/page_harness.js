// A tiny fake browser for page tests (tests whose first line is `// @page <name>`).
// Elements are created on demand by id; google.script.run calls the real server code.

const __elements = {};
function FakeEl(id) {
  this.id = id; this.textContent = ''; this.innerHTML = ''; this.value = ''; this.placeholder = '';
  this.disabled = false; this.className = ''; this.dataset = {}; this.children = [];
  this.style = { setProperty: () => {} };
  const classes = new Set();
  this.classList = { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
                     toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); } };
}
FakeEl.prototype.addEventListener = function () {};
FakeEl.prototype.appendChild = function (c) { this.children.push(c); return c; };
FakeEl.prototype.closest = function () { return null; };
FakeEl.prototype.focus = function () {};
FakeEl.prototype.querySelector = function () { return null; };
FakeEl.prototype.querySelectorAll = function () { return []; };

const __docListeners = {};
const document = {
  hidden: false, activeElement: null,
  getElementById: id => (__elements[id] = __elements[id] || new FakeEl(id)),
  createElement: () => new FakeEl(''),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: (type, fn) => { (__docListeners[type] = __docListeners[type] || []).push(fn); },
};
const el = id => document.getElementById(id);
function fireDocEvent(type) { (__docListeners[type] || []).forEach(fn => fn()); }

const __store = {};
const localStorage = { getItem: k => (k in __store ? __store[k] : null), setItem: (k, v) => { __store[k] = String(v); } };
const location = { search: '?inst=i1', href: 'https://example.test/exec?inst=i1', origin: 'https://example.test', pathname: '/exec' };

// Timers never fire on their own: tests drive polling explicitly by calling pollView().
let __timers = 0;
function setTimeout() { return ++__timers; }
function clearTimeout() {}

// google.script.run: calls the real server function synchronously, with values passed
// through JSON like the real bridge (which can't carry Dates or functions).
let __serverCalls = [];
function makeRun() {
  let ok = null, fail = null;
  const runner = new Proxy({}, { get(_, name) {
    if (name === 'withSuccessHandler') return f => { ok = f; return runner; };
    if (name === 'withFailureHandler') return f => { fail = f; return runner; };
    return (...args) => {
      __serverCalls.push(name);
      const fn = __SERVER[name];
      if (!fn) throw new Error('google.script.run: no server function ' + name);
      let result;
      try { result = fn(...JSON.parse(JSON.stringify(args))); }
      catch (e) { if (fail) fail(e); return; }
      if (ok) ok(result === undefined ? undefined : JSON.parse(JSON.stringify(result)));
    };
  } });
  return runner;
}
const google = { script: { get run() { return makeRun(); } } };
const window = { google, addEventListener: () => {}, innerWidth: 1200, devicePixelRatio: 1 };
// gjs has no URLSearchParams (node does); a minimal stand-in for ?a=b&c=d
const URLSearchParams = (typeof globalThis.URLSearchParams === 'function') ? globalThis.URLSearchParams : function (q) {
  const map = {};
  String(q || '').replace(/^\?/, '').split('&').filter(Boolean).forEach(p => {
    const [k, v = ''] = p.split('=');
    map[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
  });
  this.get = k => (k in map ? map[k] : null);
};
