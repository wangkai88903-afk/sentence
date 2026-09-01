// 精准推送本次修改的 3 个文件到 GitHub Contents API（node 22 原生 fetch + 超时重传）
// 用法：GITHUB_TOKEN=xxx node push_three.js
const fs = require("fs");
const path = require("path");
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error("缺少 GITHUB_TOKEN"); process.exit(1); }
const API = "https://api.github.com/repos/wangkai88903-afk/sentence/contents";
const BRANCH = "main";
const FILES = ["server.js", "sw.js", "index.html"]; // 小文件优先，index.html 最后
const FETCH_TIMEOUT = 120000; // 单次请求 120s 超时

function b64(f) { return fs.readFileSync(path.join(__dirname, f)).toString("base64"); }
function timedFetch(url, opts, label) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  return fetch(url, Object.assign({ signal: ctrl.signal }, opts))
    .finally(() => clearTimeout(t))
    .catch(e => { if (e.name === "AbortError") throw new Error(label + " 超时 " + (FETCH_TIMEOUT/1000) + "s"); throw e; });
}
async function withRetry(fn, label, retries) {
  retries = retries || 6;
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) {
      console.log("  retry " + (i + 1) + "/" + retries + " " + label + ": " + (e.message || e).toString().slice(0, 140));
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 3000 + i * 3000));
    }
  }
}
(async () => {
  for (const f of FILES) {
    const content = b64(f);
    console.log("推送 " + f + " (" + Math.round(content.length / 1024) + "KB b64)...");
    const r = await withRetry(async () => {
      const g = await timedFetch(API + "/" + encodeURIComponent(f) + "?ref=" + BRANCH, {
        headers: { Authorization: "Bearer " + TOKEN, Accept: "application/vnd.github+json", "User-Agent": "lcs-deploy" }
      }, "GET-sha");
      if (!g.ok) throw new Error("GET sha HTTP " + g.status);
      const meta = await g.json();
      if (typeof meta.content === "string" && Buffer.from(meta.content, "base64").toString("base64") === content) {
        console.log("  [SKIP] " + f + " 内容未变化");
        return { skipped: true };
      }
      const put = await timedFetch(API + "/" + encodeURIComponent(f), {
        method: "PUT",
        headers: { Authorization: "Bearer " + TOKEN, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "lcs-deploy" },
        body: JSON.stringify({ message: "deploy: sync-fix " + f, content: content, branch: BRANCH, sha: meta.sha })
      }, "PUT");
      const body = await put.json();
      if (!put.ok) throw new Error("PUT HTTP " + put.status + ": " + JSON.stringify(body).slice(0, 200));
      return { skipped: false, sha: (body.commit && body.commit.sha || "?").slice(0, 10) };
    }, f);
    console.log(r.skipped ? "" : "  [OK] " + f + " commit=" + r.sha);
  }
  console.log("全部完成");
})().catch(e => { console.error("失败:", e.message); process.exit(1); });
