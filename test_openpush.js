// 验证「孩子端进入应用即强制全量推送」：开 App 前云端没有孩子的本地数据，
// 开 App（startSync 走 syncPush(true)）后即把全部本机打卡推到云端，家长登录手动同步可拉到。
const PORT = process.env.PORT || 8913;
const BASE = "http://127.0.0.1:" + PORT;
const BASE_URL = BASE;
const fam = { familyId: "F-openpush", familyKey: "K-openpush" };
const child = { user: "kid", pwd: "p", role: "child" };
const parent = { user: "dad", pwd: "p", role: "parent" };

function req(path, body, token) {
  const opts = { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  return fetch(BASE_URL + path, opts).then(r => r.json());
}
function nowCheckin(id) {
  return { id: id, user: child.user, sentence: id, photo: "data:img", ts: Date.now(),
    analysis: { trans: "译", struct: "结构", comp: "成分", grammar: "语法", words: "词" },
    comments: [], annotations: [], highlights: [], version: 3 };
}
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } }

// 模拟客户端 startSync：进入应用强制全量推送 + 拉取
function startSyncClient(who, checkinsLocal) {
  // force push = 推全部本机 checkins（不等 ts 过滤）
  return req("/api/sync/push", { familyId: fam.familyId, familyKey: fam.familyKey, byUser: who.user,
    payload: { accounts: [{ user: who.user, pwd: who.pwd, role: who.role }],
      checkins: checkinsLocal, extra: [], removed: [] } })
    .then(() => req("/api/sync/pull", { familyId: fam.familyId, familyKey: fam.familyKey, byUser: who.user }));
}
function manualSyncParent(who) {
  return req("/api/sync/push", { familyId: fam.familyId, familyKey: fam.familyKey, byUser: who.user,
    payload: { accounts: [{ user: who.user, pwd: who.pwd, role: who.role }], checkins: {}, extra: [], removed: [] },
    requestPull: true })
    .then(() => req("/api/sync/pull", { familyId: fam.familyId, familyKey: fam.familyKey, byUser: who.user }));
}

(async () => {
  // 1) 孩子本地有 2 条打卡，但【从未推过云端】（模拟刚开 App 前状态）
  const childLocal = {};
  childLocal["7A-20"] = nowCheckin("7A-20");
  childLocal["7A-21"] = nowCheckin("7A-21");

  // 2) 家长先登录并手动同步一次 —— 此时云端还没有孩子数据，应拉不到
  await startSyncClient(parent, {});
  let p0 = await manualSyncParent(parent);
  ok("开 App 前云端无孩子数据 → 家长拉不到", !(p0.checkins && p0.checkins["7A-20"]));

  // 3) 孩子【进入应用】(startSync 走 syncPush(true))：全量推到云端
  await startSyncClient(child, childLocal);

  // 4) 家长随后登录并手动同步 → 应拉到孩子的 2 条打卡
  let p1 = await manualSyncParent(parent);
  ok("孩子进入应用即推送 → 家长拉到 7A-20", !!(p1.checkins && p1.checkins["7A-20"] && p1.checkins["7A-20"].analysis));
  ok("孩子进入应用即推送 → 家长拉到 7A-21", !!(p1.checkins && p1.checkins["7A-21"]));
  ok("云端 cnt=2", p1.cnt === 2);
  ok("拉到的内容含完整分析(结构/成分)", p1.checkins["7A-20"].analysis.struct === "结构" && p1.checkins["7A-20"].analysis.comp === "成分");

  console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("测试异常:", e); process.exit(2); });
