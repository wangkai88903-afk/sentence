// 初中英语长难句打卡 · Cloudflare Worker 同步后端（方案 B）
// 数据持久化到 R2 桶 lcs-families，每条家庭存为 families/{familyId}.json
// 逻辑与 server.js 保持一致（genCode / keyHash / betterRec / mergeInto 等）
// 部署：wrangler deploy  （wrangler.toml 已绑定 R2 与路由）

// ---------- 工具：适配 Workers 运行时 ----------
// 注意：Workers 没有 Node 的 crypto.randomInt / crypto.createHash，
// 改用 Web Crypto（crypto.getRandomValues / crypto.subtle）。
const CODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符
function genCode(len) {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let s = '';
  for (let i = 0; i < len; i++) s += CODE[buf[i] % CODE.length];
  return s;
}
async function keyHash(k) {
  const data = new TextEncoder().encode('lcs|' + k);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- Supabase 认证（口味 A：账号在 Supabase，数据仍在 R2）----------
// JWT 验签走 JWKS（ES256，非对称），无需 JWT secret；service_role 仅用于写入映射表。
function b64urlDecode(s){
  s = String(s).replace(/-/g,'+').replace(/_/g,'/');
  while(s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i);
  return out;
}
let JWKS_CACHE = null; // {keys, exp}
async function getJWKS(env){
  if(JWKS_CACHE && JWKS_CACHE.exp > Date.now()) return JWKS_CACHE.keys;
  const url = (env.SUPABASE_URL||'').replace(/\/$/,'') + '/auth/v1/.well-known/jwks.json';
  const r = await fetch(url, { headers: { 'apikey': env.SUPABASE_SERVICE_KEY || '' } });
  if(!r.ok) return null;
  const data = await r.json();
  JWKS_CACHE = { keys: data.keys || [], exp: Date.now() + 3600*1000 };
  return JWKS_CACHE.keys;
}
async function verifySupabaseJWT(token, env){
  try{
    const parts = String(token).split('.');
    if(parts.length !== 3) return null;
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    if(header.alg !== 'ES256') return null;
    const keys = await getJWKS(env);
    if(!keys) return null;
    const jwk = keys.find(k => k.kid === header.kid);
    if(!jwk) return null;
    const key = await crypto.subtle.importKey('jwk',
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
      { name:'ECDSA', namedCurve:'P-256' }, false, ['verify']);
    const sig = b64urlDecode(parts[2]);
    const data = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    const ok = await crypto.subtle.verify({ name:'ECDSA', hash:'SHA-256' }, key, sig, data);
    if(!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    const ref = env.SUPABASE_REF || '';
    const okRef = (payload.ref && payload.ref===ref) || (payload.iss && payload.iss.indexOf(ref)>=0);
    if(ref && !okRef) return null;
    if(payload.exp && payload.exp*1000 < Date.now()) return null;
    if(!payload.sub) return null;
    return payload;
  }catch(e){ return null; }
}

// 邮箱 -> familyId 映射（扫描 R2，60s 缓存，避免每次请求全量解析大 JSON）
let EMAIL_FAM_CACHE = null; // {map, exp}
async function familyIdByEmail(bucket, email){
  if(!email) return null;
  const e = String(email).trim().toLowerCase();
  // 缓存命中且未过期则直接返回（即使找不到也返回 null，避免频繁重扫）
  if(EMAIL_FAM_CACHE && EMAIL_FAM_CACHE.exp >= Date.now()){
    const v = EMAIL_FAM_CACHE.map[e];
    if(v !== undefined) return v || null;
  }
  // 缓存未命中/过期：重新扫描 R2 建立邮箱→familyId 映射
  const map = {};
  try{
    const listed = await bucket.list({ prefix:'families/' });
    for(const obj of (listed.objects||[])){
      const got = await bucket.get(obj.key); if(!got) continue;
      let fam; try{ fam = JSON.parse(await got.text()); }catch(_){ continue; }
      const fid = obj.key.replace(/^families\//,'').replace(/\.json$/,'');
      const acc = fam.accounts || {};
      for(const k of Object.keys(acc)){
        const a = acc[k] || {};
        if(a.email) map[String(a.email).trim().toLowerCase()] = fid;
      }
    }
  }catch(_){}
  EMAIL_FAM_CACHE = { map, exp: Date.now() + 60000 };
  return map[e] || null;
}

// 鉴权：Supabase JWT（新）优先；若邮箱尚未绑定到家庭，可用 familyKey（旧，兼容/回滚）兜底
async function authorize(request, env, bucket, body){
  const h = request.headers.get('Authorization') || '';
  let jwtAuth = null;
  let keyAuth = null;

  if(h.startsWith('Bearer ')){
    const payload = await verifySupabaseJWT(h.slice(7), env);
    if(!payload) return { ok:false, code:401, msg:'登录已过期或无效，请重新登录' };
    jwtAuth = { userId: payload.sub, email: payload.email, via:'jwt' };
  }

  // 校验 familyKey（只要提供了就校验，用于兜底）
  if(body && body.familyKey && body.familyId){
    const loaded = await loadFamily(bucket, body.familyId);
    const fam = loaded ? loaded.fam : null;
    if(fam && fam.keyHash === await keyHash(body.familyKey)){
      keyAuth = { via:'key' };
    }
  }

  if(jwtAuth){
    if(!body || !body.familyId) return Object.assign({ok:true}, jwtAuth);
    const fid = await familyIdByEmail(bucket, jwtAuth.email);
    if(fid === body.familyId) return Object.assign({ok:true}, jwtAuth);
    // 邮箱未绑定到任何家庭，但本地保存的 familyKey 正确：仍允许访问，方便迁移期用户
    if(keyAuth) return Object.assign({ok:true}, jwtAuth, {via:'jwt-key'});
    return { ok:false, code:403, msg:'该邮箱尚未绑定到该家庭。请先在设置中填写此邮箱并同步一次，或退出后用家庭口令重新加入。' };
  }

  if(keyAuth) return Object.assign({ok:true}, keyAuth);
  return { ok:false, code:401, msg:'缺少凭证' };
}

// claim：用 JWT 里的邮箱反查 R2 找到旧家庭，写映射表后返回 familyId
async function handleClaim(bucket, request, env){
  const h = request.headers.get('Authorization') || '';
  if(!h.startsWith('Bearer ')) return { code:401, body:{ ok:false, msg:'缺少登录凭证' } };
  const payload = await verifySupabaseJWT(h.slice(7), env);
  if(!payload) return { code:401, body:{ ok:false, msg:'登录已过期或无效' } };
  if(!payload.email) return { code:400, body:{ ok:false, msg:'账号缺少邮箱' } };
  const fid = await familyIdByEmail(bucket, payload.email);
  if(!fid) return { code:404, body:{ ok:false, msg:'该邮箱尚未在旧数据中登记，请先在设置里填写邮箱并同步' } };
  // 尽力写入映射表（表未建时忽略错误）
  try{
    let role = 'child';
    try{
      const got = await bucket.get('families/'+fid+'.json');
      const fam = got ? JSON.parse(await got.text()) : null;
      const acc = (fam&&fam.accounts)||{};
      for(const k of Object.keys(acc)){
        const a = acc[k]||{};
        if(a.email && String(a.email).trim().toLowerCase()===String(payload.email).trim().toLowerCase()){ role = a.role||'child'; break; }
      }
    }catch(_){}
    const url = (env.SUPABASE_URL||'').replace(/\/$/,'') + '/rest/v1/lcs_family_members';
    await fetch(url, {
      method:'POST',
      headers:{ 'apikey': env.SUPABASE_SERVICE_KEY||'', 'Authorization':'Bearer '+ (env.SUPABASE_SERVICE_KEY||''), 'Content-Type':'application/json', 'Prefer':'resolution=merge-duplicates' },
      body: JSON.stringify({ user_id: payload.sub, family_id: fid, role })
    });
  }catch(_){}
  return { code:200, body:{ ok:true, familyId: fid, role: 'child' } };
}

// ---------- 合并算法（与 server.js 一致） ----------
function betterRec(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const ta = a.ts || 0, tb = b.ts || 0;
  if (ta !== tb) return ta > tb ? a : b;
  if (!!a.correctedPhoto !== !!b.correctedPhoto) return a.correctedPhoto ? a : b;
  if (!!a.deleted !== !!b.deleted) return a.deleted ? a : b;
  return a;
}
function mergeCollabInto(target, src) {
  let changed = false;
  ['comments', 'annotations', 'highlights'].forEach(function (f) {
    const a = (target[f] || []).slice();
    const b = (src && src[f]) || [];
    const seen = {};
    a.forEach(function (x) { if (x) { const key = x.id || (x.by + ':' + x.ts); seen[key] = 1; } });
    b.forEach(function (x) {
      if (!x) return;
      const key = x.id || (x.by + ':' + x.ts);
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
      const c = client.checkins[k];
      const s = server.checkins[k];
      const base = betterRec(c, s);
      const other = (base === c) ? s : c;
      mergeCollabInto(base, other || {});
      server.checkins[k] = base;
    });
  }
  if (Array.isArray(client.extra) && client.extra.length) {
    server.extra = server.extra || [];
    const seen = {}; server.extra.forEach(function (x) { if (x && x.id) seen[x.id] = 1; });
    client.extra.forEach(function (x) { if (x && x.id && !seen[x.id]) { seen[x.id] = 1; server.extra.push(x); } });
  }
  if (client.accounts && typeof client.accounts === 'object') {
    server.accounts = server.accounts || {};
    Object.keys(client.accounts).forEach(function (k) {
      if (server.removed.indexOf(k) >= 0) return;
      const ca = client.accounts[k];
      if (ca && ca.user && ca.pass) {
        const sa = server.accounts[k];
        if (!sa) {
          server.accounts[k] = ca;
        } else if (sa.pass !== ca.pass || sa.role !== ca.role) {
          server.accounts[k] = ca;
        } else {
          // 账号主体未变（同 pass/role）：仅在客户端填了非空 email 时增量更新 email，
          // 避免「只加邮箱」被静默丢弃，也避免空 email 覆盖已存在的邮箱。
          if (ca.email && ca.email !== sa.email) sa.email = ca.email;
        }
      }
    });
  }
  server.updatedAt = Date.now();
}

// ---------- R2 读写 + 乐观锁 ----------
function famKey(id) { return 'families/' + id + '.json'; }
async function loadFamily(bucket, id) {
  const obj = await bucket.get(famKey(id));
  if (!obj) return null;
  let fam = null;
  try { fam = JSON.parse(await obj.text()); } catch (e) { fam = null; }
  return fam ? { fam, etag: obj.etag } : null;
}
// 乐观锁：仅当 etag 匹配时写入；冲突返回 false（调用方重试）
async function saveFamily(bucket, id, fam, etag) {
  const res = await bucket.put(famKey(id), JSON.stringify(fam),
    etag ? { onlyIf: { etagMatches: etag } } : {});
  return !!res;
}
function pullResponse(fam) {
  return {
    ok: true, updatedAt: fam.updatedAt,
    cnt: fam.checkins ? Object.keys(fam.checkins).length : 0,
    accounts: fam.accounts, checkins: fam.checkins || {}, extra: fam.extra || [],
    removed: fam.removed || [], pullReq: fam.pullReq || 0
  };
}

// ---------- 业务处理 ----------
async function handleCreate(bucket) {
  const fid = genCode(6), fk = genCode(8);
  const fam = { keyHash: await keyHash(fk), accounts: null, checkins: {}, extra: [], removed: [], updatedAt: Date.now() };
  await bucket.put(famKey(fid), JSON.stringify(fam));
  return { code: 200, body: { ok: true, familyId: fid, familyKey: fk, code: fid + '-' + fk } };
}
async function handlePull(bucket, body, request, env) {
  const auth = await authorize(request, env, bucket, body);
  if (!auth.ok) return { code: auth.code, body: { ok:false, msg: auth.msg } };
  let loaded = await loadFamily(bucket, body.familyId);
  let fam = loaded ? loaded.fam : null;
  if (!fam) {
    if (auth.via === 'key') {
      // 自愈：云端无数据（理论上 R2 持久化后不会丢），用口令重建空家庭并返回
      fam = { keyHash: await keyHash(body.familyKey), accounts: null, checkins: {}, extra: [], removed: [], updatedAt: Date.now() };
    } else {
      return { code: 401, body: { ok: false, msg: '家庭不存在，请确认口令或重新创建家庭云' } };
    }
  }
  if (auth.via === 'key' && fam.keyHash !== await keyHash(body.familyKey)) {
    return { code: 401, body: { ok: false, msg: '家庭口令不正确' } };
  }
  return { code: 200, body: pullResponse(fam) };
}
async function handlePush(bucket, body, request, env) {
  // 并发写：读→改→写，etag 冲突则重试（家庭场景并发极低，5 次足够）
  const auth = await authorize(request, env, bucket, body);
  if (!auth.ok) return { code: auth.code, body: { ok:false, msg: auth.msg } };
  for (let attempt = 0; attempt < 5; attempt++) {
    let loaded = await loadFamily(bucket, body.familyId);
    let fam = loaded ? loaded.fam : null;
    if (!fam) {
      if (auth.via === 'key') {
        fam = { keyHash: await keyHash(body.familyKey), accounts: null, checkins: {}, extra: [], removed: [], updatedAt: Date.now() };
      } else {
        return { code: 401, body: { ok: false, msg: '家庭不存在，请确认口令或重新创建家庭云' } };
      }
    }
    if (auth.via === 'key' && fam.keyHash !== await keyHash(body.familyKey)) {
      return { code: 401, body: { ok: false, msg: '家庭口令不正确' } };
    }
    if (body.byUser && fam.removed && fam.removed.indexOf(body.byUser) >= 0) {
      return { code: 200, body: { ok: false, kicked: true, msg: '你已被移出家庭群组，云同步已断开。' } };
    }
    if (body.payload) mergeInto(fam, body.payload);
    if (body.requestPull) fam.pullReq = Date.now();
    const ok = await saveFamily(bucket, body.familyId, fam, loaded ? loaded.etag : undefined);
    if (ok) return { code: 200, body: pullResponse(fam) };
    // etag 冲突，下一轮重试
  }
  return { code: 409, body: { ok: false, msg: '并发写入冲突，请稍后重试' } };
}

// ---------- CORS（同源部署下不会被触发，仅作安全兜底） ----------
function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}
function json(code, obj, cors) {
  const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors || {});
  return new Response(JSON.stringify(obj), { status: code, headers: h });
}

// ---------- 入口 ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const cors = corsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (p === '/api/ping') {
      return json(200, { ok: true }, cors);
    }
    if (p.indexOf('/api/') === 0 && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch (e) { return json(400, { ok: false, msg: '请求体错误' }, cors); }
      body = body || {};
      const bucket = env.lcs_families;
      if (p === '/api/family/create') {
        const r = await handleCreate(bucket);
        return json(r.code, r.body, cors);
      }
      if (p === '/api/sync/pull') {
        const r = await handlePull(bucket, body, request, env);
        return json(r.code, r.body, cors);
      }
      if (p === '/api/sync/push') {
        const r = await handlePush(bucket, body, request, env);
        return json(r.code, r.body, cors);
      }
      if (p === '/api/auth/claim') {
        const r = await handleClaim(bucket, request, env);
        return json(r.code, r.body, cors);
      }
      return json(404, { ok: false, msg: '未知接口' }, cors);
    }
    return json(404, { ok: false, msg: '未找到' }, cors);
  }
};
