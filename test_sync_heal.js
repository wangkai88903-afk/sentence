// E2E 验证：打卡同步丢失的三个故障场景 + 修复后的自愈行为
// 场景 A：正常增量推送（无变更时不重复传照片）
// 场景 B：Render 重启清空云端 -> 增量推后 cnt 校验触发全量补推（自愈）
// 场景 C：切后台漏推 -> 重新打开 App 强制全量推送（visibilitychange 逻辑等价）
const BASE = process.env.BASE || "http://127.0.0.1:8902";

function checkins(n, startTs) {
  // 模拟 n 天打卡记录（含照片 base64）
  var o = {};
  for (var i = 1; i <= n; i++) o["7A-0" + i] = { date: "2026-08-" + String(20 + i).padStart(2, "0"), photo: "data:image/jpeg;base64," + "A".repeat(120), file: "day" + i + ".jpg", ts: startTs + i * 1000, firstTs: startTs + i * 1000 };
  return o;
}
async function api(p, body) {
  var r = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
// 复刻前端 buildPushCheckins 决策逻辑
function buildPushCheckins(all, lastPushOk, force) {
  var now = Date.now();
  if (force || !lastPushOk || (now - lastPushOk) > 600000) return all; // 全量
  var sub = {};
  Object.keys(all).forEach(function (k) { var r = all[k]; if (r && (r.ts || 0) > now - 300000) sub[k] = r; });
  return sub;
}
async function clientPush(all, lastPushOk, force, fid, fk, user) {
  // 模拟前端 syncPush：增量推 -> 检查 cnt -> 必要时全量补推
  var sub = buildPushCheckins(all, lastPushOk, force);
  var r1 = await api("/api/sync/push", { familyId: fid, familyKey: fk, byUser: user, payload: { accounts: {}, checkins: sub, extra: [], removed: [] } });
  if (!r1.ok) return { ok: false, r: r1 };
  var localCnt = Object.keys(all).length;
  if (typeof r1.cnt === "number" && r1.cnt < localCnt) {
    console.log("  [cnt 校验] 云端 " + r1.cnt + " < 本地 " + localCnt + " -> 触发全量补推");
    var r2 = await api("/api/sync/push", { familyId: fid, familyKey: fk, byUser: user, payload: { accounts: {}, checkins: all, extra: [], removed: [] } });
    return { ok: r2.ok, r: r2 };
  }
  return { ok: true, r: r1 };
}

(async function () {
  var pass = 0, fail = 0;
  function T(name, cond) { console.log((cond ? "  PASS " : "  FAIL ") + name); cond ? pass++ : fail++; }

  var ts = Date.now() - 3600000;
  var created = await api("/api/family/create", {});
  var fid = created.familyId, fk = created.familyKey;
  console.log("家庭口令: " + fid + "-" + fk);

  // ===== 场景 A：孩子打卡 Day001-004，首次全量推送 =====
  console.log("\n[场景 A] 首次全量推送 Day001-004");
  var kid = checkins(4, ts);
  var ra = await clientPush(kid, 0, false, fid, fk, "kid");
  T("推送成功", ra.ok === true);
  T("云端记录数 = 4（cnt 字段）", ra.r.cnt === 4);
  // 5 秒轮询：无变更 -> 增量子集应为空
  var sub = buildPushCheckins(kid, Date.now(), false);
  T("无变更时增量子集为空（不再重复传照片）", Object.keys(sub).length === 0);

  // ===== 场景 B：Render 重启（内存清空）+ 孩子打了 Day005 =====
  console.log("\n[场景 B] 模拟 Render 重启清空 -> 增量推 Day005 -> cnt 校验全量自愈");
  // 服务端进程未重启，用新口令重建一个空家庭模拟"重启清空"
  var created2 = await api("/api/family/create", {});
  var fid2 = created2.familyId, fk2 = created2.familyKey;
  var kid5 = checkins(5, ts); // 本地 5 条（Day001-005）
  var lastPushOk = Date.now() - 120000; // 2 分钟前成功推过（<10 分钟 -> 增量模式）
  // 打卡 Day005（ts 刚刚更新）
  kid5["7A-05"].ts = Date.now() - 5000;
  var rb = await clientPush(kid5, lastPushOk, false, fid2, fk2, "kid");
  T("增量推送成功", rb.ok === true);
  T("cnt 校验触发全量补推后云端 = 5 条", rb.r.cnt === 5);
  // 家长端 pull 验证
  var rp = await api("/api/sync/pull", { familyId: fid2, familyKey: fk2 });
  T("家长端 pull 拿到全部 5 条记录", Object.keys(rp.checkins).length === 5);
  T("Day003 记录在云端（用户问题场景）", !!rp.checkins["7A-03"] && !!rp.checkins["7A-03"].photo);

  // ===== 场景 C：切后台漏推 Day003/004 -> 重新打开强制全量 =====
  console.log("\n[场景 C] 模拟 Day003/004 漏推 -> 切回前台强制全量推送");
  var created3 = await api("/api/family/create", {});
  var fid3 = created3.familyId, fk3 = created3.familyKey;
  // 只有 Day001/002 曾推上云端（用户当前状态：家长只看到 Day002）
  var kidLocal = checkins(4, ts); // 孩子本地实际有 4 条
  var only2 = {}; only2["7A-01"] = kidLocal["7A-01"]; only2["7A-02"] = kidLocal["7A-02"];
  await api("/api/sync/push", { familyId: fid3, familyKey: fk3, byUser: "kid", payload: { accounts: {}, checkins: only2, extra: [], removed: [] } });
  var before = await api("/api/sync/pull", { familyId: fid3, familyKey: fk3 });
  T("修复前云端仅 2 条（复现用户症状）", Object.keys(before.checkins).length === 2);
  // 孩子重新打开 App：visibilitychange -> lastPushOk=0, force=true
  var rc = await clientPush(kidLocal, 0, true, fid3, fk3, "kid");
  T("强制全量推送成功", rc.ok === true);
  var after = await api("/api/sync/pull", { familyId: fid3, familyKey: fk3 });
  T("修复后云端补齐 4 条（Day003/004 恢复）", Object.keys(after.checkins).length === 4);
  T("云端含 Day004 照片", !!after.checkins["7A-04"] && !!after.checkins["7A-04"].photo);

  console.log("\n===== 结果: " + pass + " passed, " + fail + " failed =====");
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error("E2E 异常:", e); process.exit(1); });
