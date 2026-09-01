# server.js → Cloudflare R2 后端改造方案

> 状态：方案讨论稿（未改任何代码）
> 日期：2026-09-01

---

## 0. 结论先行

- **R2 是对象存储（云硬盘），不能跑代码**。它只能替换 `server.js` 里的「数据存储」这一块（`let DB = {}`），替换不了 HTTP 服务、同步业务逻辑、静态托管。
- 因此有两条路线：
  - **方案 A（最小改动）**：`server.js` 继续跑 Render，只把内存 DB 换成 R2 读写。数据持久，但仍有冷启动。
  - **方案 B（一步到位，推荐）**：整体迁到 Cloudflare Workers + R2（静态用 Pages）。无服务器、无冷启动、数据持久。
- **推荐方案 B**，理由：已注册 R2 说明要走 Cloudflare 生态；顺带解决 Render 免费版「15 分钟无请求即休眠、首请求冷启动 30~60 秒」的最大痛点；免费额度内 0 成本。
- 若求稳，可按「先 A 后 B」分两步走：A 只改存储层，风险极低；跑稳后再迁 B。

---

## 1. 现状盘点

`server.js` 是零依赖 Node 服务，同时承担 4 件事：

| 职责 | 位置 | 说明 |
|---|---|---|
| HTTP 服务 + 路由 | `http.createServer` + 路由分支 | 3 个 API + 1 个 ping + 静态兜底 |
| 同步业务逻辑 | `mergeInto` / `betterRec` / `mergeCollabInto` | 多端合并，纯函数，可原样移植 |
| 静态托管 | `staticFile` | PWA 的 index.html / icons / sw.js 等 |
| 数据存储 | `let DB = {}`（内存） | 重启即清空，靠客户端「自愈」重建 |

**现有 API 只有 3 个：**

| 接口 | 作用 |
|---|---|
| `POST /api/family/create` | 生成 familyId(6位) + familyKey(8位)，返回 `fid-fk` 口令 |
| `POST /api/sync/pull` | 拉取云端家庭数据（校验口令） |
| `POST /api/sync/push` | 推送本地数据，服务端合并后返回全量 |

**数据模型**（每个家庭一个对象）：

```js
DB[familyId] = {
  keyHash,        // sha256('lcs|' + familyKey)，认证用
  accounts,       // 成员账号 {user:{user,pass,role}}
  checkins,       // 打卡记录 {id:{...}}
  extra,          // 附加项数组
  removed,        // 已移除成员黑名单
  pullReq,        // 「请各端补推」信号时间戳
  updatedAt,
}
```

**核心痛点**：Render 免费版文件系统临时 + 进程会休眠，内存数据重启即丢，目前靠「任一客户端持口令自愈重建」兜底——数据能回来，但依赖客户端在线，且每次重启后第一次同步是空的。

---

## 2. R2 的角色边界

| | 能 | 不能 |
|---|---|---|
| R2 | 持久化存对象（S3 兼容）、全球边缘、免费 10GB | 跑代码、执行同步逻辑、鉴权 |

所以「改造为 R2 后端」本质是：**把 `DB[familyId]` 从内存换成 `families/{familyId}.json` 对象**，而计算逻辑必须落在 Node（方案 A）或 Workers（方案 B）上。

---

## 3. 方案 A：R2 仅作持久化（过渡 / 降级）

### 3.1 思路

`server.js` 继续跑 Render，存储层换成 R2。每个家庭一个对象 `families/{fid}.json`。

### 3.2 改动点

- 引入 R2 读写：二选一
  - 官方库 `@aws-sdk/client-s3`（要 `npm install`，破坏「零依赖」，简单但重）；
  - **手写 AWS SigV4 签名**（约 60 行，保持零依赖，推荐）。
- 三个 API 里所有对 `DB[fid]` 的读写改成 `await r2.get(fid)` / `await r2.put(fid, data)`。
- 创建家庭时 `r2.put(fid, initialData)`。
- `pull` 直接读对象返回；`push` 读→内存合并→写回。
- 前端、`sw.js`、`render.yaml` **零改动**。

### 3.3 关键实现（零依赖 SigV4 草图）

```js
// R2 S3 兼容 endpoint: https://<account_id>.r2.cloudflarestorage.com
// 认证：AWS Access Key ID + Secret Access Key（R2 控制台创建 API Token 生成）
function signV4(method, path, headers, body, date, region, service, accessKey, secretKey) {
  // canonical request -> string to sign -> signature
  // 详见 AWS SigV4 规范；PUT/GET 对象即可，无需 GET 桶列表
}
```

### 3.4 方案 A 的优缺点

| 优点 | 缺点 |
|---|---|
| 改动最小、风险最低 | 仍有 Render 冷启动 |
| 前端零改动 | 仍是 Node 依赖，需维护 Render |
| 数据真正持久 | 多端并发写需乐观锁（同 B） |

---

## 4. 方案 B：Workers + R2（推荐，一步到位）

### 4.1 架构

```
PWA 客户端 ──┬─→ Cloudflare Pages（静态：index.html / sw.js / icons）
             └─→ Cloudflare Workers（/api/*，同步逻辑）──→ R2（families/{fid}.json）
```

### 4.2 文件结构（新增/改动）

```
worker.js          # 新增：Workers 入口，移植 server.js 的 API 逻辑
wrangler.toml      # 新增：部署配置，绑定 R2
index.html         # 改动：cloudFetch 的 base URL 指向 Worker 域名
server.js          # 可保留作本地开发，或退役
render.yaml        # 方案 B 落地后可删
```

### 4.3 worker.js 核心（移植 + R2 绑定）

```js
const keyHash = (k) => { /* 移植 crypto.subtle 或保持用 Web Crypto 的 SHA-256 */ };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const json = (o, s = 200) => new Response(JSON.stringify(o), {
      status: s,
      headers: { 'Content-Type': 'application/json; charset=utf-8',
                 'Cache-Control': 'no-store',
                 'Access-Control-Allow-Origin': '*' },  // 跨域，见 4.7
    });
    if (req.method === 'OPTIONS') return json({ ok: true });  // CORS 预检

    if (url.pathname === '/api/ping') return json({ ok: true });

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const body = await req.json().catch(() => ({}));

      if (url.pathname === '/api/family/create') {
        const fid = genCode(6), fk = genCode(8);
        const data = { keyHash: keyHash(fk), accounts: null, checkins: {},
                       extra: [], removed: [], updatedAt: Date.now() };
        await env.DB.put(`families/${fid}.json`, JSON.stringify(data));
        return json({ ok: true, familyId: fid, familyKey: fk, code: fid + '-' + fk });
      }

      if (url.pathname === '/api/sync/pull' || url.pathname === '/api/sync/push') {
        const fam = await load(env, body.familyId, body.familyKey); // 见 4.5
        if (!fam) return json({ ok: false, msg: '家庭不存在，请确认口令或重新创建家庭云' }, 401);
        if (fam.keyHash !== keyHash(body.familyKey))
          return json({ ok: false, msg: '家庭口令不正确' }, 401);

        if (url.pathname === '/api/sync/push') {
          if (body.byUser && fam.removed?.includes(body.byUser))
            return json({ ok: false, kicked: true, msg: '你已被移出家庭群组，云同步已断开。' });
          if (body.payload) mergeInto(fam, body.payload);   // 原样移植
          if (body.requestPull) fam.pullReq = Date.now();
          await save(env, body.familyId, fam);              // 见 4.5（带乐观锁）
        }
        return json({ ok: true, updatedAt: fam.updatedAt,
          cnt: Object.keys(fam.checkins || {}).length,
          accounts: fam.accounts, checkins: fam.checkins || {},
          extra: fam.extra || [], removed: fam.removed || [], pullReq: fam.pullReq || 0 });
      }
      return json({ ok: false, msg: '未知接口' }, 404);
    }
    return new Response('not found', { status: 404 });
  }
}
```

> 说明：`mergeInto` / `betterRec` / `mergeCollabInto` 三个纯函数**逐行原样搬**，逻辑零改动，只是外面套一层 Worker 的 `fetch`。

### 4.4 wrangler.toml

```toml
name = "lcs-checkin-sync"
main = "worker.js"
compatibility_date = "2026-09-01"

[[r2_buckets]]
binding = "DB"           # 代码里 env.DB
bucket_name = "lcs-families"   # R2 控制台建好的桶名
```

### 4.5 并发写：乐观锁（本次改造唯一新增的难点）

问题：两台设备同时 push，若都「读整个 JSON → 合并 → 写回」，后写会覆盖先写，可能丢一条打卡。

解法：**ETag 条件写 + 冲突重试**（乐观锁）。家庭场景并发极低，重试一次基本必成。

```js
async function load(env, fid, fk) {
  const obj = await env.DB.get(`families/${fid}.json`);
  if (obj) { const d = JSON.parse(await obj.text()); d._etag = obj.httpEtag; return d; }
  // 对象不存在：沿用现有「口令自愈重建」策略
  if (fk) return { keyHash: keyHash(fk), accounts: null, checkins: {},
                   extra: [], removed: [], updatedAt: Date.now(), _etag: null };
  return null;
}

async function save(env, fid, data, retry = 3) {
  const etag = data._etag; delete data._etag;
  const opt = etag ? { onlyIf: { etagMatches: etag } }
                   : { onlyIf: { etagDoesNotMatch: '*' } }; // 对象不存在才可写
  try {
    await env.DB.put(`families/${fid}.json`, JSON.stringify(data), opt);
  } catch (e) {
    if (retry > 0) {  // 冲突：重读最新、重跑合并、再写
      const fresh = await load(env, fid);
      mergeInto(fresh, data);   // 把本次修改叠加到最新之上
      return save(env, fid, fresh, retry - 1);
    }
    throw e;
  }
}
```

> 注意：`onlyIf` 的字段名/语义以 Cloudflare R2 绑定文档为准（`etagMatches` / `etagDoesNotMatch` / `uploadedBefore` / `uploadedAfter`），实现时按官方文档核对一遍。

### 4.6 前端改动（index.html）

现在 `cloudFetch("/api/...")` 是同源相对路径。迁到 Worker 后：

- 若 Pages 和 Worker 挂在**不同域名**：把 base 改成 `https://<worker-domain>/api/...`，并依赖 4.7 的 CORS。
- 若给 Worker 配了**自定义域名**（如 `api.yourdomain.com`），前端写绝对地址。
- 改动点集中在 `cloudFetch` 一处（约 1 行），其余调用不变。

```js
// 现状
function cloudFetch(p, opt) { return fetch(p, opt); }   // p = "/api/..."
// 改后
var API = "https://lcs-sync.<你的域名或workers.dev子域>"; // 仅此一处
function cloudFetch(p, opt) { return fetch(API + p, opt); }
```

### 4.7 CORS

- 方案 B 下 Worker 与 Pages 跨域，需在 Worker 响应加：
  - `Access-Control-Allow-Origin: *`（或限定 Pages 域名）
  - `Access-Control-Allow-Headers: Content-Type`
  - `Access-Control-Allow-Methods: POST, GET, OPTIONS`
- 若走**自定义域名把静态和 API 合并到同源**，可完全不加 CORS（最省事，推荐给有域名的场景）。

### 4.8 方案 B 优缺点

| 优点 | 缺点 |
|---|---|
| 无服务器、无冷启动、数据持久 | 改动最大 |
| 全球边缘，国内访问更快 | 需装 wrangler、配域名/CORS |
| 免费额度内 0 成本 | 认证/合并逻辑需移植（但纯函数可原样搬） |

---

## 5. 成本估算

| 项目 | 免费额度 | 本项目用量估算 | 结论 |
|---|---|---|---|
| Workers 请求 | 10 万次/天 | 家庭打卡，几十~几百次/天 | 免费 |
| R2 存储 | 10 GB | 几 MB | 免费 |
| R2 读操作 | 100 万次/月 | 极少 | 免费 |
| R2 写操作 | 100 万次/月 | 极少 | 免费 |

**结论：基本全程 0 成本。**

---

## 6. 数据迁移

无需迁移。现数据本就在内存中重启即丢、靠客户端自愈重建。切到 R2 后首次同步由客户端照常推回，云端从空对象开始累积即可。

---

## 7. 实施步骤（方案 B）

1. R2 控制台建桶 `lcs-families`；确认 Account ID。
2. 装 wrangler：`npm i -g wrangler`，`wrangler login`。
3. 写 `worker.js`（移植逻辑）+ `wrangler.toml`。
4. 本地 `wrangler dev` 用 `curl` 打三个 API，验证 create/pull/push 与并发合并。
5. `wrangler deploy`，拿到 `*.workers.dev` 域名。
6. 前端 `cloudFetch` 改 base URL；Pages 或继续 Render 托管静态先过渡。
7. 端到端联调（多设备模拟并发 push，验证乐观锁重试）。
8. 稳定后删 `render.yaml`、退役 Render。

---

## 8. 待确认问题清单（我们逐条敲定）

1. **路线**：B（一步到位）/ A（过渡）/ 先 A 后 B？
2. **静态托管**：迁 Pages，还是 Worker 顺带托管、或继续 Render 托管静态只迁 API？
3. **域名**：是否有自己的域名？有 → 建议自定义域名合并同源（免 CORS）；无 → 用 `*.workers.dev` + CORS。
4. **并发策略**：是否接受「ETag 乐观锁 + 重试」？还是你担心丢数据、想上更强的「事件日志追加」方案（改动更大）？
5. **保留 server.js**：是否保留作为本地开发用，还是直接退役？
