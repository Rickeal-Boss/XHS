"""诊断：面板为什么没显示。

在无头 Edge 里加载真实 ui.js，mount + open 之后把计算样式与几何信息
写到 DOM，再用 --dump-dom 取回来。
"""
import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
TMP = os.path.join(ROOT, "..", ".workbuddy-ai", "shot")
os.makedirs(TMP, exist_ok=True)

PAGE = os.path.join(TMP, "diag.html")


def read(p):
    with open(os.path.join(ROOT, p), encoding="utf-8") as f:
        return f.read()


html = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>diag</title></head>
<body><pre id="out">pending</pre>
<script>window.chrome={storage:{local:{get:function(k,cb){cb({})},set:function(){}},onChanged:{addListener:function(){}}},runtime:{getManifest:function(){return {version:'1'}}}};</script>
<script>__STYLES__</script>
<script>__UI__</script>
<script>
var log = [];
function rec(label, v) { log.push(label + ' = ' + v); }
try {
  XHS_DL_UI.mount({ onOpen: function(){ log.push('onOpen CALLED'); } });
  var host = document.getElementById('xhs-dl-host');
  var sr = host.shadowRoot;
  var panel = sr.querySelector('.xhs-dl-panel');
  var mask = sr.querySelector('.xhs-dl-mask');
  var ball = sr.querySelector('.xhs-dl-ball');

  rec('host.parentNode.tagName', host.parentNode.tagName);
  rec('panel.hidden(before)', panel.hidden);
  rec('panel.display(before)', getComputedStyle(panel).display);
  rec('panel.transform(before)', getComputedStyle(panel).transform);
  rec('panel.rect(before)', JSON.stringify(panel.getBoundingClientRect()));

  XHS_DL_UI.open();

  rec('panel.hidden(after)', panel.hidden);
  rec('panel.display(after)', getComputedStyle(panel).display);
  rec('panel.transform(after)', getComputedStyle(panel).transform);
  rec('panel.rect(after)', JSON.stringify(panel.getBoundingClientRect()));
  rec('mask.display(after)', getComputedStyle(mask).display);
  rec('ball.display', getComputedStyle(ball).display);
  rec('ball.rect', JSON.stringify(ball.getBoundingClientRect()));
  rec('isOpen()', XHS_DL_UI.isOpen());
} catch (e) {
  log.push('EXCEPTION: ' + e.message + '\\n' + e.stack);
}
setTimeout(function () {
  var panel = document.getElementById('xhs-dl-host').shadowRoot.querySelector('.xhs-dl-panel');
  log.push('--- after 800ms ---');
  log.push('panel.transform = ' + getComputedStyle(panel).transform);
  log.push('panel.rect = ' + JSON.stringify(panel.getBoundingClientRect()));
  document.getElementById('out').textContent = log.join('\\n');
}, 800);
</script></body></html>"""

html = html.replace("__STYLES__", read("src/content/styles.js")).replace("__UI__", read("src/content/ui.js"))

with open(PAGE, "w", encoding="utf-8") as f:
    f.write(html)

cmd = [
    EDGE, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--user-data-dir=" + os.path.join(ROOT, "..", ".workbuddy-ai", "edgeprofile"),
    "--window-size=1200,900", "--virtual-time-budget=3000",
    "--dump-dom", "file:///" + PAGE.replace("\\", "/"),
]
out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore", timeout=120)
dom = out.stdout or ""

start = dom.find('<pre id="out">')
end = dom.find('</pre>', start)
print(dom[start + len('<pre id="out">'):end] if start >= 0 else dom[:3000])
