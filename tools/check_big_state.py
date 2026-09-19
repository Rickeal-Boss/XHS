"""验证「超大 __INITIAL_STATE__ 下仍能读到笔记」。

背景（用户现场问题）：explore 页的 __INITIAL_STATE__ 极大，而 collectNotes
是 LIFO 深度遍历（stack.pop），note 容器往往是靠前的 key、会被最后展开；
旧的 MAX_NODES=20000 预算一旦耗光就 break，note 根本没被访问到，
于是"未能读取页面数据、降级为 DOM 兜底"——原图/原画质随之不可用。

本工具构造一个 nodeCount 可调的巨型状态（噪音节点数远超旧预算），
把真实笔记塞在 note.noteDetailMap 里，在真实 Edge 里跑拦截器，
断言仍能投递出正确标题的 NOTE。

运行： python tools/check_big_state.py
"""
import json
import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
TMP = os.path.join(ROOT, "..", ".workbuddy-ai", "shot")
os.makedirs(TMP, exist_ok=True)
PAGE = os.path.join(TMP, "big-state.html")

with open(os.path.join(ROOT, "src", "page-interceptor.js"), encoding="utf-8") as f:
    SRC = f.read()

NOTE_ID = "6aaa8431000000000d027d09"
NOISE_ITEMS = 900          # 每个 feed item 约 60+ 个对象 → 总量远超旧 20000 预算
NOISE_COMMENTS = 600


def noise_item(i):
    """模拟一条 feed 笔记：含 user / interactInfo / cover / imageList 等"""
    return {
        "id": "feed_%d" % i,
        "modelType": "note",
        "noteCard": {
            "noteId": "feed_%d" % i,
            "type": "normal",
            "displayTitle": "噪音标题 %d" % i,
            "desc": "噪音正文 %d" % i,
            "user": {
                "userId": "u_%d" % i,
                "nickname": "噪音用户 %d" % i,
                "nickName": "噪音用户 %d" % i,
                "avatar": "https://sns-avatar-qc.xhscdn.com/avatar%d!nd_avatar" % i,
                "redId": "rid_%d" % i,
            },
            "interactInfo": {
                "likedCount": str(i),
                "collectedCount": str(i + 1),
                "commentCount": str(i + 2),
                "shareCount": str(i + 3),
            },
            "cover": {
                "urlDefault": "http://sns-webpic-qc.xhscdn.com/202609/aa%d/1040g2sgfeed%d!nc_n_webp_mw_1" % (i, i),
                "urlPre": "http://sns-webpic-qc.xhscdn.com/202609/aa%d/1040g2sgfeed%d!nc_n_webp_mw_1" % (i, i),
                "width": 1080,
                "height": 1440,
                "fileId": "f%d" % i,
            },
            "imageList": [
                {
                    "urlDefault": "http://sns-webpic-qc.xhscdn.com/202609/aa%d/1040g2sgfeed%d_%d!nc_n_webp_mw_1" % (i, i, j),
                    "urlPre": "http://sns-webpic-qc.xhscdn.com/202609/aa%d/1040g2sgfeed%d_%d!nc_n_webp_mw_1" % (i, i, j),
                    "width": 1080,
                    "height": 1440,
                    "traceId": "t%d_%d" % (i, j),
                    "stream": {},
                    "fileId": "f%d_%d" % (i, j),
                }
                for j in range(3)
            ],
        },
    }


def noise_comment(i):
    return {
        "id": "c_%d" % i,
        "noteId": NOTE_ID,          # 故意指向真实笔记，检验不会被误当成笔记本体
        "content": "噪音评论 %d" % i,
        "userInfo": {"userId": "cu_%d" % i, "nickname": "评论者 %d" % i},
        "subComments": [],
        "likeCount": str(i),
        "createTime": 1700000000000 + i,
    }


STATE = {
    # 靠前的 key —— LIFO 遍历时会被最后展开，正是旧实现踩的坑
    "feed": {"items": [noise_item(i) for i in range(NOISE_ITEMS)]},
    "comments": {"list": [noise_comment(i) for i in range(NOISE_COMMENTS)]},
    "user": {"loggedIn": True, "userId": "self_1", "nickname": "我"},
    "search": {"result": {"notes": [noise_item(10000 + i) for i in range(50)]}},
    # 真正的目标
    "note": {
        "noteDetailMap": {
            NOTE_ID: {
                "note": {
                    "noteId": NOTE_ID,
                    "title": "真实标题_必须被读到",
                    "desc": "真实正文",
                    "type": "video",
                    "time": 1711612800000,
                    "ipLocation": "浙江",
                    "user": {"nickname": "真实作者", "userId": "u_real", "redId": "r_real"},
                    "imageList": [
                        {
                            "urlDefault": "http://sns-webpic-qc.xhscdn.com/202609191218/0059ac707720048382cdc76be3e0f326/1040g2sg325667jtql0b049egfcgllk7165431vo!nc_n_webp_mw_1",
                            "stream": {"h264": [{"masterUrl": "https://sns-video-bd.xhscdn.com/live1.mp4"}]},
                            "livePhoto": True,
                        }
                    ],
                    "video": {
                        "consumer": {"originVideoKey": "spectrum/origin/real.mp4"},
                        "media": {"stream": {"h264": [{"masterUrl": "https://sns-video-bd.xhscdn.com/stream.mp4"}]}},
                    },
                }
            }
        }
    },
}

HTML = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>big state</title></head>
<body><pre id="out">pending</pre>
<script>
window.__log = [];
window.__seen = [];
window.__errs = [];
window.addEventListener('error', function (e) {
  window.__errs.push((e.message || '?') + ' @line' + (e.lineno || '?'));
});
window.addEventListener('message', function (ev) {
  if (!ev.data || ev.data.__channel !== 'xhs-dl') return;
  window.__seen.push(ev.data.type);
  if (ev.data.type === 'NOTE') {
    var n = ev.data.payload;
    window.__log.push('NOTE noteId=' + n.noteId);
    window.__log.push('  title=' + n.title);
    window.__log.push('  source=' + n.source);
    window.__log.push('  images=' + n.images.length);
    window.__log.push('  urlOrigin[0]=' + (n.images[0] && n.images[0].urlOrigin));
    window.__log.push('  video.urlOrigin=' + (n.video && n.video.urlOrigin));
  }
});
</script>
<script>window.__INITIAL_STATE__ = __STATE__;</script>
<script>__SRC__</script>
<script>
setTimeout(function () {
  var L = window.__log;
  L.unshift('=== 收到消息: ' + (window.__seen.join(', ') || '(无)') + ' ===');
  L.push('JS 错误: ' + (window.__errs.length ? window.__errs.join(' | ') : '(无)'));
  L.push('是否收到 NOTE: ' + (window.__seen.indexOf('NOTE') !== -1 ? 'YES' : 'NO'));
  L.push('标题正确: ' + (L.join('|').indexOf('真实标题_必须被读到') !== -1 ? 'YES' : 'NO'));
  document.getElementById('out').textContent = L.join('\\n');
}, 1200);
</script></body></html>"""

html = HTML.replace("__STATE__", json.dumps(STATE, ensure_ascii=False)).replace("__SRC__", SRC)
with open(PAGE, "w", encoding="utf-8") as f:
    f.write(html)

# 粗略估算对象总数，便于在输出里说明"远超旧预算"
def count_nodes(o):
    if isinstance(o, dict):
        return 1 + sum(count_nodes(v) for v in o.values())
    if isinstance(o, list):
        return 1 + sum(count_nodes(v) for v in o)
    return 1

total_nodes = count_nodes(STATE)

cmd = [
    EDGE, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--user-data-dir=" + os.path.join(ROOT, "..", ".workbuddy-ai", "edgeprofile2"),
    "--window-size=1000,800", "--virtual-time-budget=4000",
    "--dump-dom", "file:///" + PAGE.replace("\\", "/"),
]
r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore", timeout=180)
dom = r.stdout or ""
s = dom.find('<pre id="out">')
e = dom.find('</pre>', s)
out = dom[s + len('<pre id="out">'):e] if s >= 0 else dom[:2000]

print("构造的 __INITIAL_STATE__ 对象总数 ≈ %d（旧 MAX_NODES=20000 会提前 break）" % total_nodes)
print("噪音 feed 条目 %d 条 + 评论 %d 条，目标笔记塞在 note.noteDetailMap" % (NOISE_ITEMS, NOISE_COMMENTS))
print("-" * 64)
print(out.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&"))
print("-" * 64)
ok = "标题正确: YES" in out and "是否收到 NOTE: YES" in out
print("结论: " + ("✅ 超大状态下仍能读到笔记" if ok else "❌ 仍未读到笔记"))
raise SystemExit(0 if ok else 1)
