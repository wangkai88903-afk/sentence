// 初中英语长难句打卡 · 云同步后端（零依赖 Node 服务）
// 同时托管 PWA 静态文件 + 提供 /api 家庭同步接口
// 运行：node server.js  （默认端口 8787，可用 PORT 环境变量覆盖）

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8787;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------- 家庭数据存储（内存存储） ----------
// 说明：Render 等托管平台的文件系统是临时性的（重启即清空），
// 家庭数据量很小且需跨设备持久同步，故采用纯内存存储。
// 注意：服务重启会清空所有家庭数据，部署后请让家长端重新“创建家庭云”即可。
// 结构：{ [familyId]: { keyHash, accounts, checkins, extra, updatedAt } }
let DB = {};

function genCode(len) {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符
  let s = '';
  for (let i = 0; i < len; i++) s += a[crypto.randomInt(a.length)];
  return s;
}
function keyHash(k) { return crypto.createHash('sha256').update('lcs|' + k).digest('hex'); }

// 合并：checkins 按 ts 后写覆盖；extra 按 id 去重并集；accounts 按角色合并
// client.remove 为要移除的成员用户名数组（家长删除成员时使用）

// 选出「更完整/更新」的一条打卡记录：ts 大者优先；ts 相等时优先保留带订正照片的记录，
// 避免多设备并行时订正照片被旧记录覆盖。
function betterRec(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  var ta = a.ts || 0, tb = b.ts || 0;
  if (ta !== tb) return ta > tb ? a : b;
  if (!!a.correctedPhoto !== !!b.correctedPhoto) return a.correctedPhoto ? a : b;
  if (!!a.deleted !== !!b.deleted) return a.deleted ? a : b;
  return a;
}

// 协作字段（评论/标注/高亮）合并：按 id 去重并集，双向独立保留（不互相覆盖）
function mergeCollabInto(target, src) {
  var changed = false;
  ['comments', 'annotations', 'highlights'].forEach(function (f) {
    var a = (target[f] || []).slice();
    var b = (src && src[f]) || [];
    var seen = {};
    a.forEach(function (x) { if (x) { var key = x.id || (x.by + ':' + x.ts); seen[key] = 1; } });
    b.forEach(function (x) {
      if (!x) return;
      var key = x.id || (x.by + ':' + x.ts);
      if (seen[key]) return;
      seen[key] = 1; a.push(x); changed = true;
    });
    if (a.length !== (target[f] ? target[f].length : 0)) {
      if (a.length) target[f] = a; else delete target[f];
      changed = true;
    }
  });
  return changed;
}

function mergeInto(server, client) {
  server.removed = server.removed || [];
  if (Array.isArray(client.remove) && client.remove.length) {
    client.remove.forEach(function (u) {
      if (server.accounts && server.accounts[u]) delete server.accounts[u];
      if (server.removed.indexOf(u) < 0) server.removed.push(u);
    });
  }
  // 客户端持久化的黑名单也合并进服务端：服务端重启（内存清空）后，
  // 任意客户端 self-heal 重建时即可恢复黑名单，被删成员不会"复活"。
  if (Array.isArray(client.removed) && client.removed.length) {
    client.removed.forEach(function (u) {
      if (u && server.removed.indexOf(u) < 0) {
        server.removed.push(u);
        if (server.accounts && server.accounts[u]) delete server.accounts[u];
      }
    });
  }
  if (client.checkins && typeof client.checkins === 'object') {
    server.checkins = server.checkins || {};
    Object.keys(client.checkins).forEach(function (k) {
      var c = client.checkins[k];
      var s = server.checkins[k];
      var base = betterRec(c, s);
      var other = (base === c) ? s : c;
      mergeCollabInto(base, other || {});
      server.checkins[k] = base;
    });
  }
  if (Array.isArray(client.extra) && client.extra.length) {
    server.extra = server.extra || [];
    var seen = {}; server.extra.forEach(function (x) { if (x && x.id) seen[x.id] = 1; });
    client.extra.forEach(function (x) { if (x && x.id && !seen[x.id]) { seen[x.id] = 1; server.extra.push(x); } });
  }
  if (client.accounts && typeof client.accounts === 'object') {
    server.accounts = server.accounts || {};
    Object.keys(client.accounts).forEach(function (k) {
      if (server.removed.indexOf(k) >= 0) return; // 已被移除的成员不再合并回来
      var ca = client.accounts[k];
      if (ca && ca.user && ca.pass) {
        var sa = server.accounts[k];
        if (!sa || sa.pass !== ca.pass || sa.role !== ca.role) server.accounts[k] = ca;
      }
    });
  }
  server.updatedAt = Date.now();
}

// ---------- HTTP 工具 ----------
function sendJSON(res, code, obj) {
  var b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(b);
}
function readBody(req, cb) {
  var chunks = [];
  req.on('data', function (c) { chunks.push(c); if (Buffer.concat(chunks).length > 12 * 1024 * 1024) req.destroy(); });
  req.on('end', function () { var raw=Buffer.concat(chunks).toString('utf-8'); try { cb(null, JSON.parse(raw)); } catch (e) { cb(e); } });
}
function staticFile(res, urlPath) {
  var rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel.split('?')[0]);
  var fp = path.normalize(path.join(ROOT, rel));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    // SPA 兜底：未命中静态资源时回 index.html
    fp = path.join(ROOT, 'index.html');
  }
  var ext = path.extname(fp).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(fp).pipe(res);
}

// ---------- 路由 ----------
const server = http.createServer(function (req, res) {
  var u = req.url.split('?')[0];
  if (req.method === 'POST' && u.indexOf('/api/') === 0) {
    readBody(req, function (err, body) {
      if (err) return sendJSON(res, 400, { ok: false, msg: '请求体错误' });
      body = body || {};

      if (u === '/api/family/create') {
        var fid = genCode(6), fk = genCode(8);
        DB[fid] = { keyHash: keyHash(fk), accounts: null, checkins: {}, extra: [], removed: [], updatedAt: Date.now() };
        return sendJSON(res, 200, { ok: true, familyId: fid, familyKey: fk, code: fid + '-' + fk });
      }

      if (u === '/api/sync/pull' || u === '/api/sync/push') {
        var fam = DB[body.familyId];
        if (!fam) {
          // Render 重启导致内存清空：用用户持有的口令“自愈”重建该家庭，
          // 这样任意一端打开 App 都会把本地打卡记录重新推回云端，数据不会丢。
          if (body.familyKey) {
            fam = DB[body.familyId] = { keyHash: keyHash(body.familyKey), accounts: null, checkins: {}, extra: [], removed: [], updatedAt: Date.now() };
          } else {
            return sendJSON(res, 401, { ok: false, msg: '家庭不存在，请确认口令或重新创建家庭云' });
          }
        }
        if (fam.keyHash !== keyHash(body.familyKey)) {
          return sendJSON(res, 401, { ok: false, msg: '家庭口令不正确' });
        }
        if (u === '/api/sync/push') {
          // 被移出家庭的成员：拒绝接收其数据，并通知客户端自动断开云同步
          if (body.byUser && fam.removed && fam.removed.indexOf(body.byUser) >= 0) {
            return sendJSON(res, 200, { ok: false, kicked: true, msg: '你已被移出家庭群组，云同步已断开。' });
          }
          if (body.payload) mergeInto(fam, body.payload);
          // 任一端发起「请各设备补推」信号（家长端手动同步时打标），
          // 其他端在下次 pull 看到该信号且自己尚未推过，便立即把本地最新数据推上来。
          if (body.requestPull) fam.pullReq = Date.now();
        }
        return sendJSON(res, 200, {
          ok: true, updatedAt: fam.updatedAt,
          cnt: fam.checkins ? Object.keys(fam.checkins).length : 0, // 云端打卡记录总数（客户端据此判断是否需要全量补推）
          accounts: fam.accounts, checkins: fam.checkins || {}, extra: fam.extra || [],
          removed: fam.removed || [],
          pullReq: fam.pullReq || 0 // 告诉各端：若有更新请补推
        });
      }

      return sendJSON(res, 404, { ok: false, msg: '未知接口' });
    });
    return;
  }
  if (u === '/api/ping') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
  staticFile(res, u);
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('[lcs-sync] 服务已启动: http://0.0.0.0:' + PORT + '  (内存存储，家庭数据重启后清空)');
});
