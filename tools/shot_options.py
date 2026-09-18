"""用无头 Edge 渲染设置页并截图，验证表单与占位符 chips 是否正常。

options.js 依赖 chrome.storage，直接在 file:// 下会抛错，
因此这里注入一段 chrome API 桩，再加载真实的 options.html / options.js。
"""
import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
SHOT = os.path.join(ROOT, "..", ".workbuddy-ai", "shot")
os.makedirs(SHOT, exist_ok=True)

STUB = """<script>
window.chrome = {
  storage: {
    local: {
      get: function (k, cb) { cb({ xhs_settings: {
        nameRule: '[<发布者昵称>] <标题>_<序号>',
        timeFormat: 'YYYYMMDD',
        imageFormat: 'origin',
        videoQuality: 'origin',
        liveMode: 'both',
        dirByAuthor: false,
        dirByTitle: false,
        baseDir: '小红书下载',
        hookEnabled: true
      } }); },
      set: function (o, cb) { if (cb) cb(); }
    },
    session: { remove: function (k, cb) { if (cb) cb(); } }
  },
  runtime: { getManifest: function () { return { version: '1.0.0' }; } }
};
</script>
"""

src = os.path.join(ROOT, "src", "options", "options.html")
with open(src, encoding="utf-8") as f:
    html = f.read()

html = html.replace('<script src="../content/downloader.js"></script>', STUB + '<script src="../content/downloader.js"></script>')

tmp = os.path.join(ROOT, "src", "options", "_preview_tmp.html")
with open(tmp, "w", encoding="utf-8") as f:
    f.write(html)

try:
    png = os.path.join(SHOT, "options.png")
    cmd = [
        EDGE, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
        "--hide-scrollbars",
        "--user-data-dir=" + os.path.join(ROOT, "..", ".workbuddy-ai", "edgeprofile"),
        "--window-size=900,1500", "--virtual-time-budget=3000",
        "--screenshot=" + png,
        "file:///" + tmp.replace("\\", "/"),
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore", timeout=120)
    tail = [l for l in (out.stdout + out.stderr).splitlines() if "written to file" in l]
    print(tail[0] if tail else (out.stdout + out.stderr)[-500:])
finally:
    os.remove(tmp)
    print("临时文件已清理")
