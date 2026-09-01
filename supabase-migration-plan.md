# 长难句打卡 · 迁移 Supabase 认证方案（口味 A）

> 决策日期：2026-09-01，用户选定**口味 A**。
> 2026-09-01 21:3x 重大修订：**登录账号改为真实邮箱**（用户在 App「账号设置」里自行填写并同步到 R2），废弃原合成邮箱方案；相应 SQL 已删 `lcs_profiles` 表。
> 目标：实现「任何设备、只用邮箱+密码即可登录」，同时**照片与家庭数据完全不动**。

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

## 三、登录邮箱怎么来的（真实邮箱，2026-09-01 已改为真实邮箱路线）

上一版方案用「合成邮箱 `u<sha256>@lcs.invalid`」，现已废弃。改为**真实邮箱**：

- 用户在 App 的「⚙ 设置 → 账号设置」里自行填写**真实邮箱**（上一步已上线，带格式校验 + 二次确认 + 保存即同步到 R2 `accounts[k].email`）。
- 迁移后该邮箱即登录账号；且因为邮箱真实可用，**开启 Supabase 邮箱确认**，用户可自助「忘记密码」收信重置——原合成邮箱"无法自助找回"的痛点消失。

为什么不用合成邮箱了：

1. 真实邮箱是用户能记住、能收信的；合成邮箱 `.invalid` 域名永远发不出信，必须依赖管理员后台改密码。
2. 用户诉求就是"填一个邮箱、之后用邮箱直接登录"——真实邮箱天然契合，且每个孩子需独立邮箱（无邮箱用家长邮箱 `+别名`，如 `wangkai88903+child@gmail.com`，Supabase 视为不同邮箱、确认信进同一收件箱）。
3. 全局唯一性由 `auth.users.email` 唯一约束保证 → 即"账号全局唯一"。

注意：**中文显示名仍存 R2**（`accounts[k].user`，如「小头爸爸」），只在界面显示；登录身份是邮箱。两者在同一账号对象里共存，不冲突。因此 Supabase 侧**不再需要 `lcs_profiles` 表**（该表已在 SQL 中删除）。

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
2. **登录页**改为默认「云端登录」：邮箱 + 密码 → `signInWithPassword`。
   成功后：
   - 读 `lcs_family_members` 拿到 `familyId`（按当前登录用户的 `sub`）；
   - 写入本机 `cloud = { familyId }`（不再需要 `familyKey`）；
   - 调 `syncPull()` 拉全量数据（含照片）落本机 → 秒变"已登录且有数据"。
3. **注册（首登/新用户）**：`signUp({ email, password })` → Supabase 发确认信 →
   用户点开确认后，**调 Worker `/api/auth/claim`（带 JWT）**：
   Worker 按 JWT 里的 `email` 扫描 R2 各家庭，找到 `accounts[k].email` 匹配的那个 →
   取它的 `familyId` + `role` → 写 `lcs_family_members(sub, familyId, role)` → 返回 `familyId` →
   前端 `syncPull`。即"首次用邮箱注册即自动绑定旧家庭"，无需管理员建号、无需重置邮件。
4. **加入家庭**：输入邀请码 → RPC `lcs_redeem_invite` → 拿到 familyId → 同步。
5. **所有 `/api/*` 请求**统一带 `Authorization: Bearer <session.access_token>`；
   token 过期由 supabase-js 自动 refresh，失败则弹回登录页。
6. **本机账号登录保留**为兜底（断网、Supabase 休眠时仍能看本地数据），但从主入口降级为「本机离线登录」。
7. 「导入恢复」按钮**提到登录页**（这是上次发现的 UI 缺口，顺手补掉）。

---

## 六、存量迁移（改为「用户自助 claim」，无需批量建号）

由于邮箱已在 App 里由各用户填好并同步到 R2，迁移不再需要管理员用 Admin API 批量建号 + 发重置邮件。流程变为：

1. **先部署**新版前端（邮箱登录/注册）+ Worker 的 `/api/auth/claim`（保留 familyKey 旧路径可回滚）。
2. **通知家人**：各自用「填好的邮箱 + 自设密码」在新版 App 注册/登录。
   - 注册成功 → 收确认信 → 点开确认 → 自动 `claim` 旧家庭 → 数据秒回。
   - 若个别家人不会操作，回退到管理员 `admin.createUser({ email, password: 临时, email_confirm: true })` + 写 `lcs_family_members`，再把临时密码给他。
3. 前端上线前，我会先从 R2 导出一份「用户名 ↔ 邮箱」清单给你**人工核对**，确认无误再切。

> ⚠️ **密码哈希仍无法导入 Supabase**，但变为"用户自己设新密码"（注册时填），不是管理员派发，体验顺得多。
> 唯一前置：**每人必须已填真实邮箱且互不相同**（孩子用 `+别名`）。

**R2 数据零迁移**——`families/*.json` 原地不动，照片一张都不用重传。

### 6.1 Worker `/api/auth/claim` 的实现要点
- 入参：请求头 `Authorization: Bearer <JWT>`，body `{ familyId? }`（可不传，由邮件反查）。
- 步骤：验签 JWT → 取 `payload.email` 与 `payload.sub` → 遍历 R2 `families/*.json` → 在 `accounts` 中找 `email === payload.email` 的账号 → 拿到 `familyId` + `role` → 用 service_role 写 `lcs_family_members(sub, familyId, role)` → 返回 `familyId`。
- 家庭数少（几十个量级），全量扫描可接受；若后续规模变大，再加一张 `lcs_email_index(email → familyId)` 表做 O(1) 反查。
- 找不到匹配邮箱 → 返回 404（提示"该邮箱尚未在旧数据中登记，请先在原设备填写"）。
- 该端点与 familyKey 路径互斥：claim 走 JWT，不校验 familyKey。

---

## 七、分阶段落地（每步可独立验证、可回滚）

| 阶段 | 动作 | 验证 | 回滚方式 |
|---|---|---|---|
| P0 | 跑 `supabase_schema_lcs.sql`；**开启**邮箱确认；确认 JWT 算法 | SQL 自检返回 2 表 / 4 函数 | drop 掉 `lcs_*` 对象即可，不影响词根 |
| P1 | Worker 加 JWT 验签 + `authorize()`，**保留 familyKey 路径** | curl 带假 token 得 401；带旧 familyKey 仍 200 | 回退上一版 Worker |
| P2 | 手工建 1 个测试账号，跑通「新设备纯用户名密码登录 → 拉到数据」 | 无痕窗口登录成功且能看到打卡 | 删测试账号 |
| P3 | 前端上线云端登录（本机登录降级保留） | 双设备互登、打卡双向同步 | Pages 回滚到上一次部署 |
| P4 | 迁移家人账号，通知改密码 | 每人各自设备登录成功 | 本机登录 + 导入备份兜底 |
| P5 | 前端隐藏 familyKey 入口（Worker 仍兼容） | 回归测试 | 放回入口 |

---

## 八、风险清单

| 风险 | 影响 | 对策 |
|---|---|---|
| 密码哈希不可迁移 | 家人需各自用邮箱+自设密码注册（非管理员派发） | 人少，一次性；提前告知 |
| 真实邮箱未填/填错 → 无法登录或收不到信 | 迁移后登不进 | 迁移前导出 username↔email 清单人工核对；填错用「忘记密码」走 Supabase 重置（真实邮箱可用） |
| 家庭成员邮箱重复 | Supabase 报唯一冲突、注册失败 | 孩子无邮箱用家长 `+别名`，每人独立邮箱 |
| Supabase 免费层一周无活动休眠 | 休眠期间**无法登录**（数据不丢） | 长难句天天用不会触发；且顺带帮词根保活。真出问题再议升 Pro |
| service_role key 泄露 = 全库可写 | 严重 | 只存 Worker Secret，**绝不进前端、绝不进 git** |
| JWT 算法判断错（HS256 / ES256） | 验签全挂 | P1 阶段先用真 token 单测验签，再接主流程 |
| 用户名可枚举 | 攻击者能试探用户名是否存在 | 登录失败统一文案；必要时 Worker 侧加限流 |
| 认证依赖 Supabase 可用性 | Supabase 挂 = 登不上 | 保留本机离线登录 + 导入备份兜底 |

---

## 九、需要你提供 / 操作的清单

- [ ] Supabase 控制台跑 `supabase_schema_lcs.sql`（已改为真实邮箱版，无 `lcs_profiles` 表）
- [ ] Authentication → Providers → Email → **开启 Confirm email**（真实邮箱，可自助找回密码）
- [ ] 告诉我 Settings → API → JWT 用的是 **legacy HS256** 还是 **非对称 ES256**
- [ ] 若为 HS256：提供 JWT Secret（我存进 Worker Secret，不写入任何文件）
- [ ] 提供 **service_role key**（同上，只进 Worker Secret）
- [ ] 确认每位成员已填真实邮箱且**互相独立**（孩子用 `+别名`）；我迁移前会导出 username↔email 清单给你核对
- [ ] 确认可以接受"家人各自用邮箱+自设密码注册/登录"（密码不再由管理员派发）

> 安全提醒：这两个 key 请通过一次性方式给我，用完我会提示你在控制台**轮换**。
> 上次那个 Cloudflare API Token（`cfut_...`）也**仍待撤销**。

---

## 十、与既有决策的关系

之前定的方案 A 是"长难句留 R2、词根留 Supabase、各自存储"。
本方案**不推翻它**：长难句的数据本体（含照片）仍然全在 R2，只是**认证层**借用了词根那个 Supabase 项目。
副作用是两个应用共享同一套账号体系 → 未来真要合并成一个 PWA 时，登录状态天然打通，比原计划更顺。

当前仍然冻结的事项（不受本方案影响）：词根暂不升 Pro、词根完整版暂不上线、合并外壳站点暂不启动。

---

## 十一、变更记录

- **2026-09-01 21:3x｜真实邮箱路线替代合成邮箱**
  - 起因：用户要求在 App 设置面板自行填邮箱，迁移后用该邮箱直接登录（对话 `开始吧` 之前）。
  - 已落地：第 1 步「账号设置」UI 已上线（git `175dc36` + Worker 部署），邮箱随 R2 同步，且修复了 5 处邮箱被静默丢弃/反向擦除的路径，e2e 验证通过。
  - 本方案同步修订：删除合成邮箱 `userToEmail()` 逻辑、改为真实邮箱；Supabase 侧由"关闭邮箱确认"改为"开启邮箱确认"（可自助找回密码）；`supabase_schema_lcs.sql` 删除已废弃的 `lcs_profiles` 表（中文显示名仍存 R2）；存量迁移由"管理员批量建号+重置邮件"改为"用户自助 claim（邮箱注册即绑定旧家庭）"，新增 `/api/auth/claim` 设计。
  - 不受影响：R2 数据零迁移、照片全留 R2、Worker 的 `mergeInto`/ETag/家庭 JSON 不动、JWT 验签与 `familyKey` 兼容路径设计不变。
  - 仍待用户提供：JWT 算法（HS256/ES256）、service_role key、（ES256 则无需 JWT secret）。
  - 仍待用户操作：各成员填完真实邮箱并通知我 → 我导出 username↔email 清单核对 → 再跑迁移。
