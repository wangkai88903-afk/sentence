#!/usr/bin/env python3
# 通过 GitHub Contents API 上传部署文件（绕过 git 协议的 github.com 443 阻断）
import os, base64, json, urllib.request, urllib.error, sys

TOKEN = os.environ.get("GITHUB_TOKEN") or (sys.argv[1] if len(sys.argv) > 1 else "")
if not TOKEN:
    print("请提供 GitHub Personal Access Token：设置环境变量 GITHUB_TOKEN，或在命令行传入。", file=sys.stderr)
    sys.exit(1)
OWNER = "wangkai88903-afk"
REPO = "sentence"
BRANCH = "main"
API = f"https://api.github.com/repos/{OWNER}/{REPO}/contents"

FILES = [
    "index.html", "server.js", "package.json", "render.yaml",
    "manifest.webmanifest", "sw.js", "icon.png",
    "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png",
    "sentences.js", "components.json", ".gitignore",
]

def api_request(method, url, data=None, retries=8):
    import http.client, time
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(url, method=method,
            data=json.dumps(data).encode() if data is not None else None,
            headers={
                "Authorization": f"Bearer {TOKEN}",
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
                "User-Agent": "lcs-deploy",
            })
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                chunks = []
                while True:
                    chunk = r.read(8192)
                    if not chunk:
                        break
                    chunks.append(chunk)
                return r.status, json.loads(b"".join(chunks).decode())
        except (http.client.IncompleteRead, urllib.error.URLError, OSError) as e:
            last = e
            if attempt < retries - 1:
                time.sleep(2 + attempt)
            continue
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            return e.code, body
    return 0, f"网络重试失败: {last}"

def get_sha(path):
    for attempt in range(8):
        st, data = api_request("GET", f"{API}/{path}?ref={BRANCH}")
        if st == 200 and isinstance(data, dict) and "sha" in data:
            return data["sha"]
        if st != 0:
            return None
        import time
        time.sleep(2 + attempt)
    return None

for f in FILES:
    if not os.path.exists(f):
        print(f"[SKIP] {f} not found"); continue
    with open(f, "rb") as fh:
        content = base64.b64encode(fh.read()).decode()
    sha = get_sha(f)
    payload = {
        "message": f"deploy: add {f}",
        "content": content,
        "branch": BRANCH,
    }
    if sha:
        payload["sha"] = sha
    st, resp = api_request("PUT", f"{API}/{f}", payload)
    if st in (200, 201):
        print(f"[OK] {f}  (sha={resp.get('commit',{}).get('sha','?')[:10]})")
    else:
        print(f"[FAIL] {f}  HTTP {st}: {str(resp)[:300]}")
