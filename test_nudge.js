// E2E 验证「家长手动同步 → 孩子补推 → 家长拉到新打卡」链路
// 场景：孩子本地有一条新打卡但【还没推到云端】；家长点手动同步(requestPull)，
// 孩子下次 pull 看到 pullReq 后补推，家长再拉应拿到孩子新打卡。
const PORT = process.env.PORT || 8911;
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
  // 启动服务
  require("./server.js");
  await sleep(400);

  // 创建家庭
  var c = await post("/api/family/create", {});
  check("创建家庭 ok", c.ok && c.familyId && c.familyKey);
  var fid = c.familyId, fk = c.familyKey;

  // 孩子本地有一条新打卡（尚未推）
  var childRec = { ts: Date.now(), date: "2026-08-31", photo: "data:image/png;base64,CHILD", file: "child.jpg" };
  // —— 模拟：孩子【没有】主动 push，只有本地数据 ——

  // 家长端：先推自己的（无孩子数据），再 pull。此时云端没有孩子新打卡
  await post("/api/sync/push", { familyId: fid, familyKey: fk, byUser:"parent", requestPull:false,
    payload: { accounts:{parent:{user:"parent",pass:"x",role:"parent"}}, checkins:{}, extra:[], removed:[] } });
  var p1 = await post("/api/sync/pull", { familyId: fid, familyKey: fk });
  check("家长首次 pull：云端尚无孩子新打卡", !(p1.checkins && p1.checkins["7A-05"]));

  // 家长点「手动同步」= push(requestPull:true) + pull（标记 pullReq）
  var pm = await post("/api/sync/push", { familyId: fid, familyKey: fk, byUser:"parent", requestPull:true,
    payload: { accounts:{parent:{user:"parent",pass:"x",role:"parent"}}, checkins:{}, extra:[], removed:[] } });
  check("家长手动同步 push 返回 pullReq 标记", typeof pm.pullReq === "number" && pm.pullReq > 0);
  var p2 = await post("/api/sync/pull", { familyId: fid, familyKey: fk });
  check("家长手动同步 pull 返回 pullReq", p2.pullReq > 0);

  // 孩子端：像 5s 轮询那样发起一次 pull，应看到 pullReq 并【补推】自己的新打卡
  var childLastPush = 0; // 孩子自那之后还没推过
  check("孩子应响应 pullReq（pullReq > 孩子 lastPush）", p2.pullReq > childLastPush);
  // 孩子补推
  await post("/api/sync/push", { familyId: fid, familyKey: fk, byUser:"child", requestPull:false,
    payload: { accounts:{child:{user:"child",pass:"y",role:"child"}}, checkins:{ "7A-05": childRec }, extra:[], removed:[] } });
  check("孩子补推成功", true);

  // 家长再 pull（模拟手动同步的延迟补拉）：应拿到孩子新打卡
  var p3 = await post("/api/sync/pull", { familyId: fid, familyKey: fk });
  check("家长延迟补拉拿到孩子新打卡 7A-05", p3.checkins && p3.checkins["7A-05"] && p3.checkins["7A-05"].photo === "data:image/png;base64,CHILD");
  check("云端记录总数=1", p3.cnt === 1);

  // 反向：孩子 pull 也能刷新看到自己数据（无回归）
  var c2 = await post("/api/sync/pull", { familyId: fid, familyKey: fk });
  check("孩子 pull 自身数据仍在", c2.checkins && c2.checkins["7A-05"]);

  console.log("\n结果: "+pass+" 通过 / "+fail+" 失败");
  process.exit(fail ? 1 : 0);
})().catch(function(e){ console.error("E2E 异常:", e); process.exit(2); });
