// 验证「孩子端自动推送云端，家长随时手动同步可拉到最新」
// 路径1（正常）：孩子打卡 -> 立即推 -> 家长登录手动同步(requestPull) -> 拉到
// 路径2（后台中断恢复）：孩子打卡 -> 立即推送被中断(未推) -> 回到前台强制全量补推 -> 家长拉到
const PORT = process.env.PORT || 8912;
const BASE = "http://127.0.0.1:" + PORT;
const http = require("http");
function post(path, body){
  return new Promise(function(res, rej){
    var data = JSON.stringify(body);
    var req = http.request(BASE + path, {method:"POST", headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(data)}}, function(r){
      var buf=""; r.on("data",function(c){buf+=c;}); r.on("end",function(){ try{ res(JSON.parse(buf)); }catch(e){ res({}); } });
    });
    req.on("error", rej); req.write(data); req.end();
  });
}
function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
let pass=0, fail=0;
function check(name, cond){ if(cond){ pass++; console.log("  ✓ "+name); } else { fail++; console.log("  ✗ "+name+"  <<< FAIL"); } }

(async function(){
  require("./server.js");
  await sleep(400);
  var c = await post("/api/family/create", {});
  check("创建家庭 ok", c.ok && c.familyId && c.familyKey);
  var fid = c.familyId, fk = c.familyKey;

  // 孩子账号
  var childAcc = { accounts:{child:{user:"child",pass:"y",role:"child"}}, checkins:{}, extra:[], removed:[] };

  // ---- 路径1：孩子打卡后【立即推送】（模拟 confirmBtn 的 syncPush）----
  var rec10 = { ts: Date.now(), date:"2026-08-31", photo:"data:image/png;base64,C10", file:"c10.jpg" };
  await post("/api/sync/push", { familyId: fid, familyKey: fk, byUser:"child",
    payload: Object.assign({}, childAcc, { checkins: { "7A-10": rec10 } }) });
  // 家长登录并手动同步（requestPull 触发 nudge，但孩子数据已在云端）
  await post("/api/sync/push", { familyId: fid, familyKey: fk, byUser:"parent", requestPull:true,
    payload: { accounts:{parent:{user:"parent",pass:"x",role:"parent"}}, checkins:{}, extra:[], removed:[] } });
  var p1 = await post("/api/sync/pull", { familyId: fid, familyKey: fk });
  check("路径1：家长手动同步拉到孩子刚打卡 7A-10", p1.checkins && p1.checkins["7A-10"] && p1.checkins["7A-10"].photo === "data:image/png;base64,C10");

  // ---- 路径2：孩子打卡后推送被中断（未推），回到前台强制补推 ----
  var rec11 = { ts: Date.now(), date:"2026-08-31", photo:"data:image/png;base64,C11", file:"c11.jpg" };
  // 模拟 dirtyPush：本地已存、但【没有】立即 push（被后台冻结中断）
  // 孩子回到前台 -> 强制全量补推（模拟 visibilitychange/startSync 的 syncPush(true)）
  await post("/api/sync/push", { familyId: fid, familyKey: fk, byUser:"child",
    payload: Object.assign({}, childAcc, { checkins: { "7A-10": rec10, "7A-11": rec11 } }) });
  // 家长再手动同步
  await post("/api/sync/push", { familyId: fid, familyKey: fk, byUser:"parent", requestPull:true,
    payload: { accounts:{parent:{user:"parent",pass:"x",role:"parent"}}, checkins:{}, extra:[], removed:[] } });
  var p2 = await post("/api/sync/pull", { familyId: fid, familyKey: fk });
  check("路径2：家长手动同步拉到（补推后的）孩子新打卡 7A-11", p2.checkins && p2.checkins["7A-11"] && p2.checkins["7A-11"].photo === "data:image/png;base64,C11");
  check("路径2：之前的数据 7A-10 仍在", p2.checkins && p2.checkins["7A-10"]);
  check("云端记录总数=2", p2.cnt === 2);

  console.log("\n结果: "+pass+" 通过 / "+fail+" 失败");
  process.exit(fail ? 1 : 0);
})().catch(function(e){ console.error("E2E 异常:", e); process.exit(2); });
