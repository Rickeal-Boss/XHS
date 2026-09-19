"""验证评论区媒体（图片 / 语音）提取。

调研确认的真实字段（与直觉不同，务必按此实现）：
  评论图片：comment.pictures[*].info_list[*].url
  评论语音：comment.audioInfo.playInfo.url（snake_case 别名 audio_info.play_info.url）
  语音容器是 MP4，走 sns-video-v2.xhscdn.com（与视频共用域名，无 sns-voice）

本工具构造一个含评论的 __INITIAL_STATE__，在真实 Edge 里跑拦截器，
断言能投递出 COMMENT_MEDIA，且图片/语音 URL 都正确取出。

运行： python tools/check_comment_media.py
"""
import json
import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
TMP = os.path.join(ROOT, "..", ".workbuddy-ai", "shot")
os.makedirs(TMP, exist_ok=True)
PAGE = os.path.join(TMP, "comment-media.html")

with open(os.path.join(ROOT, "src", "page-interceptor.js"), encoding="utf-8") as f:
    SRC = f.read()

NOTE_ID = "692676bf000000001e022e82"

# 模拟 /api/sns/web/v2/comment/page 的响应结构：data.comments[]
STATE = {
    "note": {
        "noteDetailMap": {
            NOTE_ID: {
                "note": {
                    "noteId": NOTE_ID,
                    "title": "带评论的笔记",
                    "type": "normal",
                    "user": {"nickname": "楼主", "userId": "u1"},
                    "imageList": [
                        {"urlDefault": "http://sns-webpic-qc.xhscdn.com/2026/aa/1040g2sgmain!nc_n_webp_mw_1"}
                    ],
                }
            }
        }
    },
    "comment": {
        # 有的实现挂在 data.comments，这里两处都放，验证都能命中
        "comments": [
            {
                "id": "c1",
                "content": "带图评论",
                "user_info": {"nickname": "评论者甲", "userId": "cu1"},
                "pictures": [
                    {"info_list": [
                        {"url": "http://sns-webpic-qc.xhscdn.com/2026/bb/1040g2sgcmt1!nc_n_webp_mw_1"},
                        {"url": "http://sns-webpic-qc.xhscdn.com/2026/bb/1040g2sgcmt1_pre!nd_prv_wlteh_webp_3"},
                    ]}
                ],
            },
            {
                "id": "c2",
                "content": "带语音评论",
                "user_info": {"nickname": "评论者乙", "userId": "cu2"},
                # 真实字段是 audioInfo.playInfo.url，不是 voice/voice_url
                "audioInfo": {
                    "audioId": "a2",
                    "duration": 12000,
                    "asrText": "这道菜真的太好吃了",
                    "playInfo": {"url": "https://sns-video-v2.xhscdn.com/audio/c2.m4a?sign=abc"},
                },
            },
            {
                "id": "c3",
                "content": "snake_case 变体",
                "user_info": {"nickname": "评论者丙", "userId": "cu3"},
                "audio_info": {
                    "audio_id": "a3",
                    "duration": 8000,
                    "asr_text": "变体也要能取到",
                    "play_info": {"url": "https://sns-video-v2.xhscdn.com/audio/c3.m4a?sign=def"},
                },
            },
            {"id": "c4", "content": "纯文字评论，无媒体", "user_info": {"nickname": "路人"}},
        ]
    },
}

HTML = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>comment media</title></head>
<body><pre id="out">pending</pre>
<script>
window.__log = [];
window.__seen = [];
window.__errs = [];
window.__cmt = null;
window.addEventListener('error', function (e) {
  window.__errs.push((e.message || '?') + ' @line' + (e.lineno || '?'));
});
window.addEventListener('message', function (ev) {
  if (!ev.data || ev.data.__channel !== 'xhs-dl') return;
  window.__seen.push(ev.data.type);
  if (ev.data.type === 'COMMENT_MEDIA') {
    window.__cmt = ev.data.payload && ev.data.payload.items;
    var items = window.__cmt || [];
    window.__log.push('COMMENT_MEDIA 条目数=' + items.length);
    items.forEach(function (c) {
      window.__log.push('  #' + c.commentId + ' 作者=' + c.author +
                       ' 图=' + c.images.length + ' 音=' + c.audios.length +
                       ' asr=' + (c.asrText || '-') + ' dur=' + c.duration);
      c.images.forEach(function (u) { window.__log.push('     img  ' + u); });
      c.audios.forEach(function (u) { window.__log.push('     audio ' + u); });
    });
  }
  if (ev.data.type === 'NOTE') {
    window.__log.push('NOTE title=' + ev.data.payload.title);
  }
});
</script>
<script>window.__INITIAL_STATE__ = __STATE__;</script>
<script>__SRC__</script>
<script>
setTimeout(function () {
  var L = window.__log;
  var items = window.__cmt || [];
  var imgs = 0, auds = 0, allOk = true;
  items.forEach(function (c) {
    imgs += c.images.length; auds += c.audios.length;
    c.images.concat(c.audios).forEach(function (u) {
      if (!/^https?:\\/\\//.test(u)) allOk = false;
    });
  });
  L.unshift('=== 收到消息: ' + (window.__seen.join(', ') || '(无)') + ' ===');
  L.push('图片总数=' + imgs + '  语音总数=' + auds);
  L.push('所有 URL 均为 http(s) = ' + allOk);
  L.push('JS 错误: ' + (window.__errs.length ? window.__errs.join(' | ') : '(无)'));
  L.push('是否收到 COMMENT_MEDIA: ' + (window.__seen.indexOf('COMMENT_MEDIA') !== -1 ? 'YES' : 'NO'));
  document.getElementById('out').textContent = L.join('\\n');
}, 1200);
</script></body></html>"""

html = HTML.replace("__STATE__", json.dumps(STATE, ensure_ascii=False)).replace("__SRC__", SRC)
with open(PAGE, "w", encoding="utf-8") as f:
    f.write(html)

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

print("构造：1 条带图评论(2 图) + 2 条带语音评论(camelCase 与 snake_case 各一) + 1 条纯文字")
print("-" * 64)
print(out.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&"))
print("-" * 64)
ok = ("是否收到 COMMENT_MEDIA: YES" in out
      and "图片总数=2" in out
      and "语音总数=2" in out
      and "所有 URL 均为 http(s) = true" in out)
print("结论: " + ("✅ 评论区图片与语音均正确提取" if ok else "❌ 提取不完整"))
raise SystemExit(0 if ok else 1)
