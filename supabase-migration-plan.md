# 长难句打卡 · 迁移 Supabase 认证方案（口味 A）

> 决策日期：2026-09-01，用户选定**口味 A**。
> 目标：实现「任何设备、只用用户名+密码即可登录」，同时**照片与家庭数据完全不动**。

---

## 一、架构不变量（先钉死，后面所有设计都不许违反）

| 数据 | 存放位置 | 是否变动 |
|---|---|---|
| 打卡照片字节（base64 jpeg） | **Cloudflare R2** `families/{familyId}.json` | ❌ 零变动 |
| 打卡记录 / 批注 / extra / removed | **Cloudflare R2** 同一个 JSON | ❌ 零变动 |
| 账号认证（谁是谁、密码校验） | **Supabase Auth** (`auth.users`) | ✅ 新增 |
| user → familyId 映射、显示用户名、邀请码 | **Supabase Postgres**（3 张 `lcs_*` 表） | ✅ 新增 |

**Supabase 里一个图片字节都不存。** 它只装几十字节的映射关系，1GB 免费额度用不到千分之一。

**照片上传路径完全不变**：客户端照旧把整个家庭 JSON push 给 Worker，Worker 照旧写 R2。
上一轮提到的"需要额外的预签名 URL / 薄服务端"在口味 A 里是**多余的**——Worker 本身就是那个薄服务端，已经存在。

---

## 二、鉴权模型的变化

### 现在（familyKey）
```
客户端 ──POST /api/sync/push { familyId, familyKey, payload } ──▶ Worker
                                    │
                                    └─ keyHash(familyKey) === fam.keyHash ?
```
问题：凭证是"家庭级"的，跨设备必须手抄 `XXXXXX-XXXXXXXX` 口令。

### 改造后（Supabase JWT）
```
① 登录：客户端 ──username+password──▶ Supabase Auth ──▶ access_token (JWT)
② 取家庭：客户端 ──select family_id──▶ lcs_family_members (RLS 保护)
③ 同步：客户端 ──POST /api/sync/push
                 Authorization: Bearer <JWT>
                 { familyId, payload } ──▶ Worker
                                            │
                                            ├─ 验 JWT 签名 → 得 user_id (sub)
                                            └─ 查 lcs_family_members 确认
                                               user_id 确实属于该 familyId
```
`familyKey` 从"登录凭证"降级为**可选的兼容路径**（保留以便回滚，前端不再展示）。

---

## 三、用户名怎么变成 Supabase 账号（最容易踩的坑）

Supabase Auth 以邮箱为主键。要做到"用户输入中文用户名即可登录"，采用**合成邮箱**：

```js
// 用户名 → 稳定的合成邮箱（前端与迁移脚本必须用完全相同的算法）
async function userToEmail(username) {
  const norm = username.trim().toLowerCase();          // 归一化
  const buf  = new TextEncoder().encode('lcs-user|' + norm);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  const hex  = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  return 'u' + hex.slice(0, 32) + '@lcs.invalid';      // 33 字符 localpart，合法
}
```

为什么这么做：

1. **中文用户名不能直接做邮箱 localpart**。`小头爸爸@...` 会被 Supabase 直接拒。哈希成 hex 后一律合法。
2. **全局唯一性天然保证**：`auth.users.email` 本身有唯一约束，同名用户第二次注册必然失败 → 正是我们要的"用户名全局唯一"。
3. **不可反推**：从邮箱看不出中文用户名，顺带缓解一点信息泄露。
4. 中文名显示靠 `lcs_profiles.username` 存原文，界面上照旧显示"小头爸爸"。
5. 域名用 `.invalid`（RFC 2606 保留），永远不会真的往外发信。

### 必须配套的两个 Supabase 设置

- **关闭邮箱确认**（Authentication → Providers → Email → Confirm email 关掉）。
  合成邮箱收不到确认信，不关就永远登不进去。
- **接受"无法邮件自助找回密码"**。这是合成邮箱的唯一代价。补偿手段：
  - 你（管理员）在 Supabase 控制台直接给成员改密码；或
  - 后续加一个 parent 用 service_role 重置 child 密码的入口（Phase 6，可选）。

> 若你更看重"自助找回密码"，另一条路是要求真实邮箱注册。但孩子多半没有邮箱，
> 且改动会波及注册 UI，所以默认走合成邮箱。

---

## 四、Worker 侧改造（`worker.js`）

### 4.1 JWT 验签

**先确认你项目用的签名算法**（Supabase 控制台 → Settings → API → JWT Keys）：

- **Legacy HS256（对称，共享 secret）**——多数存量项目是这个。
  把 JWT Secret 存成 Worker Secret：`wrangler secret put SUPABASE_JWT_SECRET`
  ```js
  function b64url(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function verifyJWT_HS256(token, secret) {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const ok = await crypto.subtle.verify(
      'HMAC', key, b64url(parts[2]),
      new TextEncoder().encode(parts[0] + '.' + parts[1])
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
    if (!payload.sub) return null;
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;   // 过期
    return payload;
  }
  ```
- **非对称 ES256（新项目默认）**——改从 JWKS 拉公钥：
  `https://khthjbutmzopfesvoqjk.supabase.co/auth/v1/.well-known/jwks.json`
  用 `crypto.subtle.importKey('jwk', …, {name:'ECDSA', namedCurve:'P-256'})` + `verify('ECDSA', …)`，
  公钥用 Cache API 缓存 1 小时。**这种情况下不需要把任何 secret 交给我**，更安全。

### 4.2 校验 user 属于该 family

Worker 验签拿到 `sub`（user_id）后，用 **service_role key** 走 PostgREST 确认归属：

```js
async function userInFamily(env, userId, familyId) {
  const cacheKey = userId + '|' + familyId;
  const hit = MEMO.get(cacheKey);                       // isolate 级缓存，60s
  if (hit && hit.exp > Date.now()) return hit.ok;

  const url = env.SUPABASE_URL
    + '/rest/v1/lcs_family_members?select=role'
    + '&user_id=eq.' + encodeURIComponent(userId)
    + '&family_id=eq.' + encodeURIComponent(familyId);
  const r = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_KEY
    }
  });
  const rows = r.ok ? await r.json() : [];
  const ok = Array.isArray(rows) && rows.length > 0;
  MEMO.set(cacheKey, { ok, exp: Date.now() + 60000 });
  return ok;
}
```

延迟成本：缓存未命中时 +30~80ms，命中则为 0。家庭场景完全可接受。

### 4.3 改造后的鉴权入口（替换现有 `fam.keyHash !== keyHash(body.familyKey)` 判断）

```js
async function authorize(request, env, body) {
  // 路径一：Supabase JWT（新）
  const h = request.headers.get('Authorization') || '';
  if (h.startsWith('Bearer ')) {
    const payload = await verifyJWT(h.slice(7), env);
    if (!payload) return { ok: false, code: 401, msg: '登录已过期，请重新登录' };
    if (!await userInFamily(env, payload.sub, body.familyId)) {
      return { ok: false, code: 403, msg: '无权访问该家庭数据' };
    }
    return { ok: true, userId: payload.sub, via: 'jwt' };
  }
  // 路径二：familyKey（旧，兼容与回滚用）
  if (body.familyKey) return { ok: true, via: 'key' };
  return { ok: false, code: 401, msg: '缺少凭证' };
}
```

`handlePull` / `handlePush` 里：`via === 'jwt'` 时**跳过** keyHash 校验；`via === 'key'` 时保持原逻辑不变。
其余（`mergeInto` / `betterRec` / ETag 乐观锁 / R2 读写）**一行都不改**。

### 4.4 需要新增的 Worker Secret

```bash
wrangler secret put SUPABASE_URL            # https://khthjbutmzopfesvoqjk.supabase.co
wrangler secret put SUPABASE_SERVICE_KEY    # service_role key（切勿放前端）
wrangler secret put SUPABASE_JWT_SECRET     # 仅 HS256 项目需要；ES256 项目不需要
```

---

## 五、前端改造（`index.html`）

1. 引入 `supabase.min.js`（词根目录下已有现成文件，直接复制过来，避免依赖 CDN）。
2. **登录页**改为默认「云端登录」：用户名 + 密码 → `userToEmail()` → `signInWithPassword`。
   成功后：
   - 读 `lcs_profiles` / `lcs_family_members` 拿到 `familyId`；
   - 写入本机 `cloud = { familyId }`（不再需要 `familyKey`）；
   - 调 `syncPull()` 拉全量数据（含照片）落本机 → 秒变"已登录且有数据"。
3. **注册**：`signUp` → 写 `lcs_profiles`（用户名重复时 Supabase 报唯一冲突，提示"该用户名已被使用"）
   → 首个用户调 Worker `/api/family/create` 拿 familyId → 调 RPC `lcs_claim_family`。
4. **加入家庭**：输入邀请码 → RPC `lcs_redeem_invite` → 拿到 familyId → 同步。
5. **所有 `/api/*` 请求**统一带 `Authorization: Bearer <session.access_token>`；
   token 过期由 supabase-js 自动 refresh，失败则弹回登录页。
6. **本机账号登录保留**为兜底（断网、Supabase 休眠时仍能看本地数据），但从主入口降级为「本机离线登录」。
7. 「导入恢复」按钮**提到登录页**（这是上次发现的 UI 缺口，顺手补掉）。

---

## 六、存量迁移（就 2~4 个人，一次性）

1. 从 R2 导出现有 `families/{familyId}.json`，取出 `accounts` 里的用户名与 `role`。
2. 对每个用户：`admin.createUser({ email: userToEmail(name), password: <临时密码>, email_confirm: true })`。
3. 写 `lcs_profiles`（中文用户名原文）+ `lcs_family_members`（映射到原 familyId、原 role）。
4. **把临时密码告诉家人，首次登录后改掉。**

> ⚠️ **密码哈希无法搬运。** Supabase Auth 不接受外部注入的哈希，现有 `hash(p)` 没法平移。
> 这是本方案唯一的真麻烦，但只涉及 2~4 人，一次性成本极低。

**R2 数据零迁移**——`families/*.json` 原地不动，照片一张都不用重传。

---

## 七、分阶段落地（每步可独立验证、可回滚）

| 阶段 | 动作 | 验证 | 回滚方式 |
|---|---|---|---|
| P0 | 跑 `supabase_schema_lcs.sql`；关闭邮箱确认；确认 JWT 算法 | SQL 自检返回 3 表 / 4 函数 | drop 掉 `lcs_*` 对象即可，不影响词根 |
| P1 | Worker 加 JWT 验签 + `authorize()`，**保留 familyKey 路径** | curl 带假 token 得 401；带旧 familyKey 仍 200 | 回退上一版 Worker |
| P2 | 手工建 1 个测试账号，跑通「新设备纯用户名密码登录 → 拉到数据」 | 无痕窗口登录成功且能看到打卡 | 删测试账号 |
| P3 | 前端上线云端登录（本机登录降级保留） | 双设备互登、打卡双向同步 | Pages 回滚到上一次部署 |
| P4 | 迁移家人账号，通知改密码 | 每人各自设备登录成功 | 本机登录 + 导入备份兜底 |
| P5 | 前端隐藏 familyKey 入口（Worker 仍兼容） | 回归测试 | 放回入口 |

---

## 八、风险清单

| 风险 | 影响 | 对策 |
|---|---|---|
| 密码哈希不可迁移 | 家人需各自重设一次密码 | 人少，一次性；提前告知 |
| 合成邮箱 → 无法邮件找回密码 | 忘密码需管理员介入 | Supabase 控制台重置；或后续加 parent 重置入口 |
| Supabase 免费层一周无活动休眠 | 休眠期间**无法登录**（数据不丢） | 长难句天天用不会触发；且顺带帮词根保活。真出问题再议升 Pro |
| service_role key 泄露 = 全库可写 | 严重 | 只存 Worker Secret，**绝不进前端、绝不进 git** |
| JWT 算法判断错（HS256 / ES256） | 验签全挂 | P1 阶段先用真 token 单测验签，再接主流程 |
| 用户名可枚举 | 攻击者能试探用户名是否存在 | 登录失败统一文案；必要时 Worker 侧加限流 |
| 认证依赖 Supabase 可用性 | Supabase 挂 = 登不上 | 保留本机离线登录 + 导入备份兜底 |

---

## 九、需要你提供 / 操作的清单

- [ ] Supabase 控制台跑 `supabase_schema_lcs.sql`（我已写好，直接粘贴）
- [ ] Authentication → Providers → Email → **关闭 Confirm email**
- [ ] 告诉我 Settings → API → JWT 用的是 **legacy HS256** 还是 **非对称 ES256**
- [ ] 若为 HS256：提供 JWT Secret（我存进 Worker Secret，不写入任何文件）
- [ ] 提供 **service_role key**（同上，只进 Worker Secret）
- [ ] 现有家庭成员名单 + 各自角色（parent/child），用于迁移建号
- [ ] 确认可以接受"家人各重设一次密码"

> 安全提醒：这两个 key 请通过一次性方式给我，用完我会提示你在控制台**轮换**。
> 上次那个 Cloudflare API Token（`cfut_...`）也**仍待撤销**。

---

## 十、与既有决策的关系

之前定的方案 A 是"长难句留 R2、词根留 Supabase、各自存储"。
本方案**不推翻它**：长难句的数据本体（含照片）仍然全在 R2，只是**认证层**借用了词根那个 Supabase 项目。
副作用是两个应用共享同一套账号体系 → 未来真要合并成一个 PWA 时，登录状态天然打通，比原计划更顺。

当前仍然冻结的事项（不受本方案影响）：词根暂不升 Pro、词根完整版暂不上线、合并外壳站点暂不启动。
