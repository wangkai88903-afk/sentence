// 验证 mergeFromCloud 返回的 checkins 计数准确，且 deepEqual 能避免引用差异导致误报
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const re = /<script[^>]*>([\s\S]*?)<\/script>/g;
const scripts = [];
let m;
while((m = re.exec(html))) scripts.push(m[1]);
const code = scripts[1];

// 从第二个内联脚本中提取需要的函数定义
function extract(fnName) {
  const pattern = new RegExp('function\\s+' + fnName + '\\s*\\([\\s\\S]*?(?=\\n\\s*function\\s+|\\n\\s*//|\\n\\s*var\\s+|\\n\\s*let\\s+|\\n\\s*const\\s+|$)', 'm');
  const match = code.match(pattern);
  if(!match) throw new Error('未找到函数 ' + fnName);
  return match[0];
}
function extractVar(name) {
  const pattern = new RegExp('var\\s+' + name + '\\s*=', 'm');
  if(!pattern.test(code)) throw new Error('未找到变量 ' + name);
  return 'var ' + name + ' = {};'; // dummy
}

// 最小可运行代码
const helperCode = [
  'var LS = { get:function(k,d){ return (_ls[k]!==undefined)?_ls[k]:d; }, set:function(k,v){ _ls[k]=v; } };',
  'var S = [], TOTAL = 0;',
  'var checkins = {}, accounts = {}, removedList = [];',
  'function mergeRemoved(){}',
  'function inRemoved(){ return false; }',
  'function normalizeAccounts(a){ return a||{}; }',
  'function renderChild(){}',
  'function renderParent(){}',
  extract('deepEqual'),
  extract('betterRec'),
  extract('mergeCollabInto'),
  extract('mergeFromCloud')
].join('\n');

const vm = require('vm');
const ctx = { _ls: {}, console: console };
vm.createContext(ctx);
vm.runInContext(helperCode, ctx, { filename: 'mergeOnly.js' });

const mergeFromCloud = ctx.mergeFromCloud;
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } }

function payload(checkins) {
  return { ok: true, accounts: {}, checkins: checkins, extra: [], removed: [] };
}

// 1. 仅账号变更
ctx._ls = {}; ctx.checkins = {};
const r1 = mergeFromCloud({ ok: true, accounts: { dad: { user: 'dad', pass: 'p', role: 'parent' } }, checkins: {}, extra: [], removed: [] });
ok('仅账号变更 → changed>0', r1.changed > 0);
ok('仅账号变更 → checkins=0', r1.checkins === 0);

// 2. 新增一条孩子打卡
ctx._ls = {}; ctx.checkins = {};
const rec = { id: '7A-99', user: 'kid', sentence: '7A-99', photo: 'data:img', ts: 1,
  analysis: { trans: '译', struct: '结构', comp: '成分', grammar: '语法', words: '词' },
  comments: [], annotations: [], highlights: [], version: 3 };
const r2 = mergeFromCloud(payload({ '7A-99': rec }));
ok('新增打卡 → changed>0', r2.changed > 0);
ok('新增打卡 → checkins=1', r2.checkins === 1);

// 3. 本地已有完全相同打卡，云端再次推送 → 不应重复计为变更
ctx._ls = { lcs_checkins: { '7A-99': JSON.parse(JSON.stringify(rec)) } };
ctx.checkins = ctx._ls.lcs_checkins;
const r3 = mergeFromCloud(payload({ '7A-99': JSON.parse(JSON.stringify(rec)) }));
ok('完全相同打卡 → changed=0', r3.changed === 0);
ok('完全相同打卡 → checkins=0', r3.checkins === 0);

// 4. 云端打卡有新增评论 → 应计为变更
const recWithComment = JSON.parse(JSON.stringify(rec));
recWithComment.comments = [{ id: 'c1', by: 'dad', text: '好', ts: 2 }];
ctx._ls = { lcs_checkins: { '7A-99': JSON.parse(JSON.stringify(rec)) } };
ctx.checkins = ctx._ls.lcs_checkins;
const r4 = mergeFromCloud(payload({ '7A-99': recWithComment }));
ok('新增评论 → checkins=1', r4.checkins === 1);

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
