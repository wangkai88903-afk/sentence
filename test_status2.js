// 用「万能 Proxy Mock」加载第二个内联脚本，直接调用真实的 mergeFromCloud，验证其返回结构正确
const fs = require('fs'), vm = require('vm');
const html = fs.readFileSync('index.html', 'utf8');
const re = /<script[^>]*>([\s\S]*?)<\/script>/g;
const scripts = []; let m;
while((m = re.exec(html))) scripts.push(m[1]);
const code = scripts[1].replace(/^\s*\(function\(\)\{/, '').replace(/\}\)\(\);\s*$/, '');

// 万能 mock：任何属性访问/调用都安全返回自身或空值
function makeMock() {
  const fn = function(){ return makeMock(); };
  return new Proxy(fn, {
    get(t, p) {
      if(p === 'classList') return { add(){}, remove(){}, toggle(){}, contains(){ return false; } };
      if(p === 'style') return {};
      if(p === Symbol.toPrimitive || p === 'toString') return function(){ return ''; };
      if(p === 'value') return '';
      if(p === 'textContent') return '';
      if(p === 'innerHTML') return '';
      return makeMock();
    },
    set() { return true; },
    apply() { return makeMock(); }
  });
}
const el = makeMock();
const _store = {};
const ctx = {
  console: console,
  addEventListener: function(){},
  removeEventListener: function(){},
  document: {
    getElementById: function(){ return el; },
    querySelectorAll: function(){ return []; },
    addEventListener: function(){},
    createElement: function(){ return el; },
    body: el
  },
  window: { addEventListener: function(){}, location: {}, navigator: {}, SENTENCES: [] },
  localStorage: { getItem(k){ return (k in _store) ? _store[k] : null; }, setItem(k,v){ _store[k] = v; }, removeItem(k){ delete _store[k]; } },
  location: {}, history: {}, navigator: {},
  setTimeout: function(fn){ return 0; }, clearTimeout: function(){},
  setInterval: function(){ return 0; }, clearInterval: function(){},
  alert: function(){}, fetch: function(){ return Promise.resolve(); },
  JSON: JSON, Date: Date, Object: Object, Array: Array, Math: Math, Promise: Promise,
  encodeURIComponent: encodeURIComponent
};
vm.createContext(ctx);
vm.runInContext(code, ctx, { filename: 'inline2.js' });

const mergeFromCloud = ctx.mergeFromCloud;
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } }

function payload(checkins) { return { ok: true, accounts: {}, checkins: checkins, extra: [], removed: [] }; }
const rec = { id: '7A-99', user: 'kid', sentence: '7A-99', photo: 'data:img', ts: 1,
  analysis: { trans: '译', struct: '结构', comp: '成分', grammar: '语法', words: '词' },
  comments: [], annotations: [], highlights: [], version: 3 };

// 1. 仅账号变更 → checkins=0
ctx.checkins = {};
const r1 = mergeFromCloud({ ok: true, accounts: { dad: { user: 'dad', pass: 'p', role: 'parent' } }, checkins: {}, extra: [], removed: [] });
ok('仅账号变更 → changed>0', r1.changed > 0);
ok('仅账号变更 → checkins=0', r1.checkins === 0);

// 2. 新增一条孩子打卡 → checkins=1
ctx.checkins = {};
const r2 = mergeFromCloud(payload({ '7A-99': rec }));
ok('新增打卡 → changed>0', r2.changed > 0);
ok('新增打卡 → checkins=1', r2.checkins === 1);

// 3. 本地已有完全相同打卡，云端再次推送 → 不应误报
ctx.checkins = { '7A-99': JSON.parse(JSON.stringify(rec)) };
const r3 = mergeFromCloud(payload({ '7A-99': JSON.parse(JSON.stringify(rec)) }));
ok('完全相同打卡 → changed=0', r3.changed === 0);
ok('完全相同打卡 → checkins=0', r3.checkins === 0);

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
