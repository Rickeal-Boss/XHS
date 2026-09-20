#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""真机验证：SPA 切换后的「取源」修复（真实 Edge + 合成页面）。

════════════════════════════════════════════════════════════════════════
本脚本的定位（务必先读，避免误读结论）
════════════════════════════════════════════════════════════════════════
这是「真浏览器 + 合成页面」验证，不是真机联网验证：

  ✅ 覆盖：真实 Edge 的 DOM/事件/postMessage/fetch/XHR/history 语义；
           src/page-interceptor.js 的**真实源码**在真实 JS 引擎里执行；
           SPA 切换（pushState）、软刷新（同源 fetch SSR HTML）、
           钩子自愈、相对路径 API 旁路等全部走真代码路径。
  ❌ 不覆盖：真实小红书的 x-s / x-t 签名、风控、登录态、真实 SSR 体积与
           字段演进、真实 CDN 可达性。这些**只能靠登录后在小红书站内
           人工点开新笔记来验证**，本脚本不能替代。

页面形状的合成方式：
  - 用本地 HTTP 服务（127.0.0.1 随机端口）合成 `/s<N>/explore/<noteId>` 形状；
  - 用 `--host-resolver-rules=MAP www.xiaohongshu.com 127.0.0.1` 把域名解析到
    本机，于是 location.hostname 仍是 www.xiaohongshu.com —— 这样
    isApiUrl() 的「相对路径归一化后判域名」分支才会走真实路径
    （若用 127.0.0.1 直接访问，isApiUrl 会因域名不匹配而判否，场景 9 失效）。
  - 服务端按 noteId 返回不同的 SSR HTML，用于模拟「软刷新拿到的服务端状态」。

运行： python tools/check_spa_source.py
"""
import http.server
import json
import os
import re
import socket
import subprocess
import sys
import threading
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
TMP = os.path.join(ROOT, "..", ".workbuddy-ai", "shot")
os.makedirs(TMP, exist_ok=True)

HOST = "www.xiaohongshu.com"

with open(os.path.join(ROOT, "src", "page-interceptor.js"), encoding="utf-8") as f:
    SRC = f.read()

ID_A = "6a1b2c3d00000000000000a1"      # 首屏 URL 上的笔记
ID_B = "6a1b2c3d00000000000000b2"      # SPA 切换后的笔记
ID_X = "6a1b2c3d00000000000000c3"      # 只存在于 state、不属于当前 URL 的笔记


# ────────────────────────────── 合成状态 ──────────────────────────────

def mk_note(nid, title, kind="normal"):
    return {
        "noteId": nid,
        "title": title,
        "desc": title + " 的正文",
        "type": kind,
        "time": 1711612800000,
        "ipLocation": "浙江",
        "user": {"nickname": "作者_" + title, "userId": "u" + nid[-6:], "redId": "r" + nid[-6:]},
        "imageList": [{
            "urlDefault": "http://sns-webpic-qc.xhscdn.com/202609/aa/1040g2sg%s!nc_n_webp_mw_1" % nid,
            "width": 1080,
            "height": 1440,
        }],
    }


def mk_state(nid, title):
    return {"note": {"noteDetailMap": {nid: {"note": mk_note(nid, title)}}}, "user": {"loggedIn": True}}


STATE_A = mk_state(ID_A, "首屏笔记A")
STATE_B = mk_state(ID_B, "切换后的笔记B")
STATE_X = mk_state(ID_X, "别人的笔记X")


# ─────────────────────────── 页面骨架 / 驱动 ───────────────────────────

FETCH_WRAP = """
(function () {
  var real = window.fetch;
  if (typeof real !== 'function') return;
  window.__fetchLog = [];
  window.fetch = function (input, init) {
    try {
      var u = (typeof input === 'string') ? input : (input && input.url ? input.url : '');
      window.__fetchLog.push(String(u));
    } catch (e) { /* 忽略 */ }
    return real.apply(this, arguments);
  };
})();
"""

PAGE_TMPL = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>spa-source</title></head>
<body><pre id="out">pending</pre>
<script>
window.__msgs = [];
window.__errs = [];
window.__extra = {};
window.addEventListener('error', function (e) {
  window.__errs.push(String((e && e.message) || '?') + ' @' + ((e && e.lineno) || '?'));
});
window.addEventListener('message', function (ev) {
  var d = ev.data;
  if (!d || d.__channel !== 'xhs-dl') return;
  window.__msgs.push({ type: d.type, t: Math.round(performance.now()), payload: d.payload });
});
function __askRescan() {
  window.postMessage({ __channel: 'xhs-dl', type: 'REQUEST_RESCAN' }, '*');
}
</script>
__STATE_SCRIPT__
<script>__FETCH_WRAP__</script>
<script>__SRC__</script>
<script>__DRIVER__</script>
<script>
setTimeout(function () {
  var dump = {
    href: location.href,
    msgs: window.__msgs,
    errs: window.__errs,
    fetchLog: window.__fetchLog || [],
    extra: window.__extra || {}
  };
  var txt;
  try { txt = JSON.stringify(dump); } catch (e) { txt = JSON.stringify({ stringifyError: String(e) }); }
  document.getElementById('out').textContent = '###JSON###' + txt + '###END###';
}, __REPORT_AT__);
</script></body></html>"""


def page_html(driver, report_at, state):
    """state 为 None 时**不注入** __INITIAL_STATE__（用于模拟「服务端 SSR 里没有状态」）。"""
    state_script = ""
    if state is not None:
        state_script = "<script>window.__INITIAL_STATE__ = %s;</script>" % json.dumps(state, ensure_ascii=False)
    return (PAGE_TMPL
            .replace("__STATE_SCRIPT__", state_script)
            .replace("__FETCH_WRAP__", FETCH_WRAP)
            .replace("__SRC__", SRC)
            .replace("__DRIVER__", driver)
            .replace("__REPORT_AT__", str(report_at)))


DRV_PUSH = "history.pushState({}, '', '/s%s/explore/%s');"


# ──────────────────────────── 场景定义 ────────────────────────────
# ssr(note_id) -> 服务端在该 URL 下返回的 SSR 状态；None 表示「服务端也没状态」

def _d1():
    return "setTimeout(__askRescan, 800);"


def _d2():
    return """
setTimeout(function () {
  %s
  window.__INITIAL_STATE__ = %s;
  window.__extra.pushedAt = Math.round(performance.now());
}, 500);
setTimeout(__askRescan, 2500);
""" % (DRV_PUSH % (2, ID_B), json.dumps(STATE_B, ensure_ascii=False))


def _d_soft(n):
    return """
setTimeout(function () { %s }, 500);
setTimeout(__askRescan, 1500);
""" % (DRV_PUSH % (n, ID_B))


def _d6():
    return """
setTimeout(function () { %s }, 400);
setTimeout(__askRescan, 1200);
setTimeout(__askRescan, 1900);
""" % (DRV_PUSH % (6, ID_B))


def _d7():
    return "setTimeout(__askRescan, 900);"


def _d8():
    return """
function __vidErr() {
  var v = document.createElement('video');
  document.body.appendChild(v);
  v.dispatchEvent(new Event('error'));
}
setTimeout(function () { __vidErr(); window.__extra.errAt1 = Math.round(performance.now()); }, 400);
setTimeout(__askRescan, 900);
setTimeout(function () { __vidErr(); __vidErr(); window.__extra.errAt3 = Math.round(performance.now()); }, 1400);
setTimeout(__askRescan, 2000);
setTimeout(function () { window.__extra.lateAt = Math.round(performance.now()); }, 31200);
"""


def _d9():
    return """
setTimeout(function () {
  var x = new XMLHttpRequest();
  x.open('GET', '/api/sns/web/v1/feed');
  x.send();
  window.__extra.xhrAt = Math.round(performance.now());
}, 400);
"""


def _d10():
    return """
setTimeout(function () { %s }, 1000);
setTimeout(function () {
  window.__INITIAL_STATE__ = %s;
  window.__extra.injectedAt = Math.round(performance.now());
}, 2200);
""" % (DRV_PUSH % (10, ID_B), json.dumps(STATE_B, ensure_ascii=False))


def _ssr(init_state, second_state):
    def f(nid):
        if nid == ID_A:
            return init_state
        if nid == ID_B:
            return second_state
        return None
    return f


# ══════════════════════ 断言辅助 ══════════════════════

def msgs(d):
    return d.get("msgs") or []


def of_type(d, t):
    return [m for m in msgs(d) if m.get("type") == t]


def pl(d, t):
    return [m.get("payload") for m in of_type(d, t)]


def first_note_index(d, nid):
    for i, m in enumerate(msgs(d)):
        if m.get("type") == "NOTE" and (m.get("payload") or {}).get("noteId") == nid:
            return i
    return None


def note_sources(d, nid):
    return [(m.get("payload") or {}).get("source") for m in of_type(d, "NOTE")
            if (m.get("payload") or {}).get("noteId") == nid]


def short(nid):
    return "…" + nid[-4:]


def rescan_briefs(d):
    """把每次 RESCAN_DONE 的关键字段摊平，便于人眼核对（也是报告里的原始证据）。"""
    out = []
    for m in of_type(d, "RESCAN_DONE"):
        p = m.get("payload") or {}
        dg = p.get("diag") or {}
        out.append("t=%sms ok=%s accepted=%s pending=%s softRefresh=%s hookInstalled=%s navSeq=%s reason=%s"
                   % (m.get("t"), p.get("ok"), p.get("accepted"), p.get("pendingSoftRefresh"),
                      dg.get("softRefresh"), dg.get("hookInstalled"), dg.get("navSeq"), dg.get("reason")))
    return out


def note_briefs(d):
    """投递过的 NOTE 序列：来源 + noteId，用于核对「投的是不是当前这条」。"""
    out = []
    for m in of_type(d, "NOTE"):
        p = m.get("payload") or {}
        out.append("t=%sms %s←%s" % (m.get("t"), short(p.get("noteId") or "?"), p.get("source")))
    return out


# ══════════════════════ 各场景断言 ══════════════════════

def chk1(d):
    srcs = note_sources(d, ID_A)
    rd = pl(d, "RESCAN_DONE")
    ok = ("initial-state" in srcs) and bool(rd) and rd[-1].get("accepted") is True
    return ok, [
        "首屏 NOTE(%s) 的 source 序列 = %s" % (short(ID_A), srcs or "(无)"),
        "末次 RESCAN_DONE.accepted = %s" % (rd[-1].get("accepted") if rd else "(无 RESCAN_DONE)"),
        "末次 diag.softRefresh = %s（期望 idle，未走软刷新）" % (rd[-1].get("diag", {}).get("softRefresh") if rd else "-"),
    ]


def chk2(d):
    seq = msgs(d)
    i_rc = next((i for i, m in enumerate(seq) if m.get("type") == "ROUTE_CHANGE"), None)
    i_note = first_note_index(d, ID_B)
    navseq = (seq[i_rc].get("payload") or {}).get("navSeq") if i_rc is not None else None
    rd = pl(d, "RESCAN_DONE")
    ordered = (i_rc is not None and i_note is not None and i_rc < i_note)
    ok = ordered and navseq == 1
    return ok, [
        "ROUTE_CHANGE 出现位置 = %s，navSeq = %s" % (i_rc, navseq),
        "NOTE(%s) 首次出现位置 = %s" % (short(ID_B), i_note),
        "顺序断言 ROUTE_CHANGE 先于 NOTE = %s" % ordered,
        "末次 RESCAN_DONE.accepted = %s，diag.navSeq = %s" % (
            rd[-1].get("accepted") if rd else None,
            rd[-1].get("diag", {}).get("navSeq") if rd else None),
    ]


def chk3(d):
    srcs = note_sources(d, ID_B)
    rd = pl(d, "RESCAN_DONE")
    ok = ("soft-refresh" in srcs) and bool(rd) and rd[-1].get("accepted") is True \
        and rd[-1].get("diag", {}).get("softRefresh") == "ok"
    return ok, [
        "NOTE(%s) 的 source 序列 = %s" % (short(ID_B), srcs or "(无)"),
        "末次 RESCAN_DONE.accepted = %s" % (rd[-1].get("accepted") if rd else "(无)"),
        "末次 diag.softRefresh = %s（期望 ok）" % (rd[-1].get("diag", {}).get("softRefresh") if rd else "-"),
    ]


def chk4(d):
    seq = msgs(d)
    i_pend = next((i for i, m in enumerate(seq)
                   if m.get("type") == "RESCAN_DONE" and (m.get("payload") or {}).get("pendingSoftRefresh") is True), None)
    i_final = next((i for i, m in enumerate(seq)
                    if m.get("type") == "RESCAN_DONE" and (m.get("payload") or {}).get("pendingSoftRefresh") is False
                    and (m.get("payload") or {}).get("accepted") is True), None)
    i_note = next((i for i, m in enumerate(seq)
                   if m.get("type") == "NOTE" and (m.get("payload") or {}).get("source") == "soft-refresh"), None)
    # 「提前降级」信号：软刷新还在飞（或尚未出结果）时，就投递了 pendingSoftRefresh=false 且 accepted=false
    premature = []
    if i_final is not None:
        for i, m in enumerate(seq[:i_final]):
            p = m.get("payload") or {}
            if m.get("type") == "RESCAN_DONE" and p.get("pendingSoftRefresh") is False and p.get("accepted") is False:
                premature.append(i)
    ok = (i_pend is not None and i_final is not None and i_pend < i_final
          and i_note is not None and i_pend < i_note < i_final and not premature)
    return ok, [
        "RESCAN_DONE{pendingSoftRefresh:true} 位置 = %s" % i_pend,
        "NOTE(source=soft-refresh) 位置 = %s" % i_note,
        "RESCAN_DONE{pending:false,accepted:true} 位置 = %s" % i_final,
        "其间出现的「提前降级」信号 = %s" % (premature or "无"),
    ]


def chk5(d):
    rd = pl(d, "RESCAN_DONE")
    ok = bool(rd) and rd[-1].get("accepted") is False and rd[-1].get("diag", {}).get("softRefresh") == "failed"
    return ok, [
        "末次 RESCAN_DONE.accepted = %s（期望 false）" % (rd[-1].get("accepted") if rd else "(无)"),
        "末次 diag.softRefresh = %s（期望 failed）" % (rd[-1].get("diag", {}).get("softRefresh") if rd else "-"),
    ]


def chk6(d):
    flog = d.get("fetchLog") or []
    rd = pl(d, "RESCAN_DONE")
    ok = len(flog) == 1 and len(rd) >= 2 and all(r.get("accepted") is False for r in rd)
    return ok, [
        "页面 fetch 调用次数 = %d（期望 1，3s 内第二次不得重发）" % len(flog),
        "fetch 目标 = %s" % (flog or "(无)"),
        "RESCAN_DONE 条数 = %d，accepted 全为 false = %s" % (
            len(rd), all(r.get("accepted") is False for r in rd) if rd else False),
    ]


def chk7(d):
    rd = pl(d, "RESCAN_DONE")
    notes = [(m.get("payload") or {}).get("noteId") for m in of_type(d, "NOTE")]
    accepted_any = any(r.get("accepted") for r in rd)
    ok = bool(rd) and not accepted_any and ID_A not in notes
    return ok, [
        "state 里只有 %s，URL 上是 %s" % (short(ID_X), short(ID_A)),
        "投递过的 NOTE noteId 序列 = %s" % ([short(n) for n in notes] or "(无)"),
        "RESCAN_DONE 中出现过 accepted=true = %s（期望 False）" % accepted_any,
    ]


def chk8(d):
    seq = msgs(d)
    i_disable = next((i for i, m in enumerate(seq) if m.get("type") == "HOOK_DISABLED"), None)
    i_true = next((i for i, m in enumerate(seq)
                   if m.get("type") == "RESCAN_DONE" and (m.get("payload") or {}).get("diag", {}).get("hookInstalled") is True), None)
    i_false = next((i for i, m in enumerate(seq)
                    if m.get("type") == "RESCAN_DONE" and (m.get("payload") or {}).get("diag", {}).get("hookInstalled") is False), None)
    i_back = next((i for i, m in enumerate(seq)
                   if m.get("type") == "HOOK_STATE" and (m.get("payload") or {}).get("active") is True
                   and i_disable is not None and i > i_disable), None)
    reason = (seq[i_disable].get("payload") or {}).get("reason") if i_disable is not None else None
    ok = (i_disable is not None and reason == "video-error"
          and i_true is not None and i_false is not None and i_true < i_disable < i_false
          and i_back is not None)
    return ok, [
        "1 次 error 后 diag.hookInstalled=true 的位置 = %s（应早于卸载）" % i_true,
        "HOOK_DISABLED 位置 = %s，reason = %s（期望 video-error）" % (i_disable, reason),
        "卸载后 diag.hookInstalled=false 的位置 = %s" % i_false,
        "30s 后自动重装 HOOK_STATE{active:true} 位置 = %s" % i_back,
    ]


def chk9(d, server_paths=None):
    srcs = note_sources(d, ID_A)
    api_hit = any((s or "").startswith("api:") for s in srcs)
    seen = any("/api/sns/web/v1/feed" in p for p in (server_paths or []))
    ok = api_hit and seen
    return ok, [
        "NOTE(%s) 的 source 序列 = %s（期望含 api:…）" % (short(ID_A), srcs or "(无)"),
        "本地服务收到相对路径 /api/sns/web/v1/feed = %s" % seen,
    ]


def chk10(d):
    seq = msgs(d)
    i_rc = next((i for i, m in enumerate(seq) if m.get("type") == "ROUTE_CHANGE"), None)
    i_note = first_note_index(d, ID_B)
    delta = (seq[i_note]["t"] - seq[i_rc]["t"]) if (i_rc is not None and i_note is not None) else None
    ok = (delta is not None and 1100 <= delta <= 2800)
    return ok, [
        "状态在切换后 1.2s 才注入（__extra.injectedAt=%s）" % d.get("extra", {}).get("injectedAt"),
        "ROUTE_CHANGE→首条 NOTE(%s) 间隔 = %s ms（期望 ≈1500，即 1500ms 那次重试命中）" % (short(ID_B), delta),
    ]


SCENARIOS = [
    dict(n=1, name="首屏 __INITIAL_STATE__ 含当前 URL 的笔记",
         ssr=_ssr(STATE_A, STATE_B), driver=_d1(), budget=4000, report=3200, check=chk1),
    dict(n=2, name="SPA 切换：ROUTE_CHANGE 先于新 NOTE，navSeq 自增",
         ssr=_ssr(STATE_A, STATE_B), driver=_d2(), budget=5000, report=4200, check=chk2),
    dict(n=3, name="SPA 后状态陈旧 → 软刷新取到源",
         ssr=_ssr(STATE_A, STATE_B), driver=_d_soft(3), budget=6000, report=5000, check=chk3),
    dict(n=4, name="软刷新期间不得提前降级 DOM",
         ssr=_ssr(STATE_A, STATE_B), driver=_d_soft(4), budget=6000, report=5000, check=chk4),
    dict(n=5, name="软刷新也拿不到 → softRefresh=failed / accepted=false",
         ssr=_ssr(STATE_A, None), driver=_d_soft(5), budget=6000, report=5000, check=chk5),
    dict(n=6, name="软刷新节流：3s 内第二次不重复发 fetch",
         ssr=_ssr(STATE_A, None), driver=_d6(), budget=6000, report=5000, check=chk6),
    dict(n=7, name="URL 归属校验：state 里只有别的 noteId → accepted=false",
         ssr=_ssr(STATE_X, STATE_X), driver=_d7(), budget=5000, report=4200, check=chk7),
    dict(n=8, name="钩子自愈：1 次 error 不卸、3 次才卸、30s 后自动重装",
         ssr=_ssr(STATE_A, STATE_A), driver=_d8(), budget=34000, report=32500, check=chk8),
    dict(n=9, name="isApiUrl 相对路径：/api/sns/web/v1/feed 旁路仍生效",
         ssr=lambda nid: None, driver=_d9(), budget=4000, report=3200, check=chk9),
    dict(n=10, name="多次重试：状态延迟 1.2s 注入也被 1500ms 那次命中",
         ssr=_ssr(STATE_A, STATE_B), driver=_d10(), budget=7000, report=6000, check=chk10),
]


# ══════════════════════ 本地 HTTP 服务 ══════════════════════

class Handler(http.server.BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        raw = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        path = self.path.split("?")[0]
        SERVER_PATHS.append(path)
        m = re.match(r"^/s(\d+)/explore/([0-9A-Za-z]+)$", path)
        if m:
            n, nid = int(m.group(1)), m.group(2)
            spec = next((s for s in SCENARIOS if s["n"] == n), None)
            if spec is None:
                self._send(404, "no scenario", "text/plain; charset=utf-8")
                return
            state = spec["ssr"](nid)
            self._send(200, page_html(spec["driver"], spec["report"], state), "text/html; charset=utf-8")
            return
        if path == "/api/sns/web/v1/feed":
            body = json.dumps({"data": {"items": [{"note_card": mk_note(ID_A, "API旁路笔记")}]}},
                              ensure_ascii=False)
            self._send(200, body, "application/json; charset=utf-8")
            return
        self._send(404, "not found", "text/plain; charset=utf-8")

    def log_message(self, *args):
        pass


SERVER_PATHS = []


def start_server():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, port


# ══════════════════════ 主流程 ══════════════════════

def run_scenario(spec, port):
    url = "http://%s:%d/s%d/explore/%s" % (HOST, port, spec["n"], ID_A)
    profile = os.path.join(TMP, "edgeprofile_spa_" + uuid.uuid4().hex[:8])
    cmd = [
        EDGE, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
        "--user-data-dir=" + profile,
        "--host-resolver-rules=MAP %s 127.0.0.1" % HOST,
        "--window-size=1000,800",
        "--virtual-time-budget=%d" % spec["budget"],
        "--dump-dom", url,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore", timeout=180)
    dom = r.stdout or ""
    s = dom.find('<pre id="out">')
    e = dom.find('</pre>', s)
    out = dom[s + len('<pre id="out">'):e] if s >= 0 else ""
    out = out.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&").replace("&quot;", '"').replace("&#39;", "'")
    m = re.search(r"###JSON###(.*?)###END###", out, re.S)
    if not m:
        return None, "页面未写出结果（Edge rc=%s）。dump 片段: %s" % (r.returncode, out[:300] or dom[:300])
    try:
        return json.loads(m.group(1)), None
    except Exception as exc:
        return None, "结果 JSON 解析失败: %s / 片段: %s" % (exc, m.group(1)[:300])


def main():
    if not os.path.exists(EDGE):
        print("❌ 找不到 Edge: %s" % EDGE)
        return 1
    # 可选：只跑指定场景号，便于排障（python tools/check_spa_source.py 2 7）
    only = set(int(a) for a in sys.argv[1:] if a.isdigit())
    todo = [s for s in SCENARIOS if not only or s["n"] in only]
    srv, port = start_server()
    print("本地合成服务: http://%s:%d/  （host-resolver-rules 把域名解析到 127.0.0.1）" % (HOST, port))
    print("被测源码: src/page-interceptor.js（%d 字节，未做任何改动）" % len(SRC))
    print("=" * 78)

    results = []
    for spec in todo:
        tag = "场景%-2d" % spec["n"]
        before = len(SERVER_PATHS)
        dump, err = run_scenario(spec, port)
        if dump is None:
            print("[FAIL] %s %s" % (tag, spec["name"]))
            print("       %s" % err)
            results.append((spec["n"], False))
            continue
        try:
            if spec["n"] == 9:
                ok, lines = spec["check"](dump, SERVER_PATHS[before:])
            else:
                ok, lines = spec["check"](dump)
        except Exception as exc:
            ok, lines = False, ["断言执行异常: %r" % (exc,)]
        print("[%s] %s %s" % ("PASS" if ok else "FAIL", tag, spec["name"]))
        for ln in lines:
            print("       - %s" % ln)
        for rb in rescan_briefs(dump):
            print("       · RESCAN_DONE %s" % rb)
        for nb in note_briefs(dump):
            print("       · NOTE       %s" % nb)
        # 附加观察（不计入 10 场景判定）：ok=true 却 accepted=false 是 lastEmitAccepted
        # 被后续 scanInlineScript() 覆盖造成的**诊断假阴性** —— 场景 2 里
        # scanInitialState 已取到当前笔记，紧接着的内联 script 扫描读到的却是
        # DOM 里那份陈旧的 __INITIAL_STATE__（首屏笔记），把标志位改写成了 false。
        # 功能上不致命（隔离世界按 current 判降级），但 accepted 这个新字段会撒谎。
        for rb in rescan_briefs(dump):
            if "ok=True accepted=False" in rb:
                print("       ⚠ 附加观察：%s" % rb)
                print("         （lastEmitAccepted 被后续 scanInlineScript 覆盖 → accepted 假阴性）")
        if dump.get("errs"):
            print("       ! 页面 JS 错误: %s" % " | ".join(dump["errs"][:4]))
        seq = ", ".join(m["type"] for m in (dump.get("msgs") or []))
        print("       消息序列: %s" % (seq or "(无)"))
        results.append((spec["n"], ok))

    print("=" * 78)
    passed = sum(1 for _, ok in results if ok)
    print("汇总: %d/%d 场景通过" % (passed, len(results)))
    for n, ok in results:
        if not ok:
            print("  ❌ 场景 %d 未通过" % n)
    if passed == len(results):
        print("结论: ✅ 全部场景通过（真 Edge + 合成页面；真机联网人工验证仍需另行进行）")
    else:
        print("结论: ❌ 存在未通过场景（真机联网人工验证仍需另行进行）")
    srv.shutdown()
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
