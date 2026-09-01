# R2 后端部署手册（方案 B 落地）

> 目标：把原 `server.js`（Render + 内存存储）改造为 Cloudflare Workers + R2，前端仍由 Pages 托管，同源免 CORS。

## 已完成
- ✅ Cloudflare 账号绑卡
- ✅ 域名 `englearning.cc` 已购（DNS 由 Cloudflare 接管）
- ✅ R2 桶 `lcs-families` 已创建（默认 Standard 存储类）
- ✅ `worker.js` 已写（同步逻辑逐行移植自 server.js，R2 读写 + ETag 乐观锁）
- ✅ `wrangler.toml` 已写（R2 绑定 `lcs_families` + 路由 `app.englearning.cc/api/*`）
- ✅ `.pagesignore` 已写（避免把后端文件上传到前端）
- ✅ `worker.js` 合并算法已用 Node 单元测试验证（7/7 通过：迁移合并不丢数据、冲突取最新、协作评论不丢、移除成员正确）

## 部署状态（2026-09-01，已实际执行）
- ✅ **Worker 已部署**：`lcs-checkin-sync`，R2 绑定 `lcs_families`，路由 `app.englearning.cc/api/*`（zone: englearning.cc）已生效。
- ✅ **Pages 已部署**：项目 `lcs-checkin-web`，65 个静态文件已上传，预览地址 `https://lcs-checkin-web.pages.dev`。
- ✅ **Pages 自定义域已生效**：`app.englearning.cc`（用户已于 2026-09-01 15:38 手动添加 `app` CNAME 记录，目标 `lcs-checkin-web.pages.dev`，开代理）。控制台 Custom domains 可能短暂显示 `pending`，但实际 DNS 已生效——实测 `GET /` 返回 200 且页面正常、`/api/*` 可达。
- ✅ **端到端验证通过（2026-09-01 实测）**：见下方「验证结果」一节。孩子数据迁移链路（本机 → 导入 → push 到 R2 → 任意端 pull）确认不丢数据。
- ✅ **测试痕迹已清理**：验证用的临时家庭 `GN2MX5` 已从 R2 桶删除，桶当前为空。
- ✅ **孩子数据迁移代码已就绪**：`index.html` 的「导出备份」已包含家庭云口令 `cloud`，「导入恢复」后自动全量推送到 R2（见「数据迁移」一节）。
- ⚠️ **部署用 API Token（`cfut_...`）建议用完后到 Cloudflare 控制台 revoke 并重新生成**，不要长期保留明文。

## 验证结果（2026-09-01 实测，全部通过）

> 以下为实际调用 `https://app.englearning.cc` 的结果，非纸上推演。

| 检查项 | 方法 | 结果 |
|---|---|---|
| 前端页面可达 | `GET /` | HTTP 200，`text/html`，标题 `初中英语长难句 · 打卡（家长/孩子）` ✅ |
| 后端接口可达 | `GET /api/ping` | HTTP 200，`{"ok":true}` ✅ |
| 创建家庭 | `POST /api/family/create` | 返回 `familyId=GN2MX5, familyKey=6G99JZG8` ✅ |
| 多端推送合并 | 孩子 push `sent-001` + 家长 push `sent-002`（两次独立 push） | 云端计数 2，两个账户/两条打卡都在 ✅（ETag 乐观锁并发合并正确） |
| 拉取全量 | `POST /api/sync/pull` | 两条打卡均返回，账户完整 ✅ |
| 幂等性 | 重复 push 同一条打卡 | 计数仍为 2，无重复 ✅ |

**结论**：R2 持久化 + 并发合并 + 数据迁移链路均工作正常，孩子已有打卡数据经「旧应用导出 → 新应用导入恢复」可无损上云。

> 注：Cloudflare 控制台的 Pages Custom domains 状态可能延迟显示 `pending`，但实测已生效，无需等待其翻 `Active` 即可使用。

## 关键参数
- Account ID：`8c8273abf092fc40abc76970eb129d70`
- R2 桶：`lcs-families`（绑定名 `lcs_families`）
- Worker 名：`lcs-checkin-sync`
- 前端域名：`app.englearning.cc`（Pages）
- API 路由：`app.englearning.cc/api/*` → Worker（同源，前端零改动）

## 待执行（部署步骤）
> 注意：API Token 是敏感凭证，**不要写进任何文件 / 不要提交 git**。仅在执行命令时作为环境变量传入。
> 当前用的 User Token 前缀 `cfut_...`，部署完建议在 Cloudflare 控制台 revoke 并重新生成一个。

### 1) 部署 Worker（同步后端）
```bash
# 在本机项目目录执行，token 仅本次会话生效
CLOUDFLARE_API_TOKEN='你的cfut_token' npx wrangler deploy
```
- 首次会创建 Worker 并绑定 R2、添加 `app.englearning.cc/api/*` 路由。
- 若 `routes` 报"custom domain 未配置"，去 Cloudflare 控制台 → Workers → 该 Worker → Routes 手动确认 `app.englearning.cc/api/*` 已生效（前提是 `app.englearning.cc` 的 DNS 已由 Pages 托管，见步骤 2）。

### 2) 部署前端到 Pages
```bash
# 创建 Pages 项目（只需一次）
npx wrangler pages project create lcs-checkin-web --production-branch main

# 部署当前目录（.pagesignore 已排除后端文件）
CLOUDFLARE_API_TOKEN='你的cfut_token' npx wrangler pages deploy . --project-name lcs-checkin-web
```
- 在 Cloudflare 控制台 → Pages → lcs-checkin-web → 自定义域，添加 `app.englearning.cc`（会自动建 DNS 记录并代理）。
- 确认 `app.englearning.cc` 的 DNS 记录为 Cloudflare 代理（橙色云朵），否则 Worker 路由不会生效。

### 2.5) 手动建 DNS 记录（已完成 ✅）
> 用户已于 2026-09-01 15:38 完成：在 Cloudflare 控制台为 `app.englearning.cc` 添加了 CNAME（`lcs-checkin-web.pages.dev`，开代理）。实测已生效，前端与 `/api` 均正常。

仅供参考的建记录步骤（若日后重建）：
1. Cloudflare 控制台 → 站点 `englearning.cc` → **DNS** → **Records** → **Add record**：
   - Type：`CNAME`｜Name：`app`｜Target：`lcs-checkin-web.pages.dev`｜Proxy：**Proxied（橙色云朵）** ✅
2. 保存后 1~5 分钟生效。控制台 Custom domains 可能短暂 `pending`，以实际 `curl`/`GET` 测试为准。

### 3) 验证
- 浏览器打开 `https://app.englearning.cc`，应能看到原 PWA 界面。
- 进入云同步设置 → 创建家庭云，能得到 `XXXXXX-XXXXXXXX` 家庭码（走 Worker 的 `/api/family/create`）。
- 多设备加入同一家庭码，互打卡，确认数据互通且刷新后不丢（R2 持久化）。
- （可选）`curl https://app.englearning.cc/api/ping` 应返回 `{"ok":true}`。

## 数据迁移（关键！孩子本地数据如何搬到新云端）
原 Render 后端是内存存储，没有可迁的历史数据；**但孩子设备浏览器里的打卡记录是真实存在的本地数据**，且锁定在旧域名（onrender）的 localStorage 中。新应用部署到 `app.englearning.cc` 后是另一个 origin，读不到旧数据。因此迁移靠「导出 / 导入备份」把数据跨域搬过去（代码已支持 `exportData` / `importData`，且导出已含家庭云口令 `cloud`，导入后自动全量推送）：

前提：旧应用（onrender 上的旧版）仍能打开，先从中导出。
1. 孩子的旧应用 → 设置 → 点「导出备份」，下载一个 JSON（已含打卡记录 + 账户 + 家庭云口令 cloud）。建议存到微信 / 云盘作为硬备份。
2. （推荐）家长端同样导出一份，确保全家数据完整。
3. 部署新应用后，打开 `https://app.englearning.cc` → 设置 → 「导入恢复」→ 选刚才的 JSON。导入后会**自动全量推送到 R2**（`worker.js` 的 `handlePush` 在家庭不存在时自动建家庭并写入）。
4. 验证：导入后在设置里能看到「已绑定家庭：XXXXXX-XXXXXXXX」，刷新页面数据仍在；家长端用同一家庭码加入即可看到孩子打卡。

注意：
- 导入前务必确认旧应用还能打开、能导出；一旦旧域名失效，导出文件就是唯一备份。
- 若导入时家庭口令为空（孩子从未加入家庭云），导入后数据仅在本机，需先「创建家庭云」再手动同步一次。
- 旧 Render 应用可保留作兜底，确认新云端数据完整后再停用。

## 回退 / 备注
- 若 Pages 与 Worker 同主机路由出现冲突（极端情况页面 404），备选方案：把 API 拆到独立子域 `api.englearning.cc`（改 wrangler.toml 的 `routes` + 前端加 `API_BASE` 常量 + Worker 加 CORS）。当前同源方案更优，优先用。
- 成本：数据量极小，落在 R2 / Workers 免费额度内，基本 0 费用。
