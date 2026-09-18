"""在真实 Edge 里验证 page-interceptor.js 的消息桥与提取引擎。

测试桩（vm 沙箱）对 ev.source / ev.origin 的语义保真度存疑，
这里直接用真实浏览器跑一遍，结论更硬。
"""
import json
import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
TMP = os.path.join(ROOT, "..", ".workbuddy-ai", "shot")
os.makedirs(TMP, exist_ok=True)
PAGE = os.path.join(TMP, "bridge-test.html")

with open(os.path.join(ROOT, "src", "page-interceptor.js"), encoding="utf-8") as f:
    SRC = f.read()

NOTE_ID = "65f1a2b3000000001203abcd"

# 仿真一条「视频 + 实况」混合笔记，覆盖原图重拼 / 原视频 / 实况三个关键路径
FIXTURE = {
    "note": {
        "noteDetailMap": {
            NOTE_ID: {
                "note": {
                    "noteId": NOTE_ID,
                    "title": "莫干山民宿实测",
                    "desc": "竹林 view 直接封神",
                    "type": "video",
                    "time": 1711612800000,
                    "ipLocation": "浙江",
                    "user": {"nickname": "旅行的小鹿", "userId": "5f2c1b", "redId": "lulu_trip"},
                    "imageList": [
                        {
                            "urlDefault": "http://sns-webpic-qc.xhscdn.com/202401/abc/notes_pre_post/1040g2sg31abcdefg!nd_dft_wlteh_webp_3",
                            # 同一编解码器内多档分辨率 + 更高档的 h265 + 备用直链，
                            # 用于验证「按画质降序择优」而不是「取数组第一条」
                            "stream": {
                                "h264": [
                                    {"masterUrl": "https://sns-video-bd.xhscdn.com/live-720", "height": 720},
                                    {"masterUrl": "https://sns-video-bd.xhscdn.com/live-1080", "height": 1080,
                                     "backupUrls": ["https://sns-video-hw.xhscdn.com/live-1080-bak"]}
                                ],
                                "h265": [{"masterUrl": "https://sns-video-bd.xhscdn.com/live-2160", "height": 2160}]
                            },
                            "livePhoto": True
                        },
                        {
                            "urlDefault": "http://sns-webpic-qc.xhscdn.com/202401/abc/notes_pre_post/1040g2sg31hijklmn!nd_dft_wlteh_webp_3"
                        }
                    ],
                    "video": {
                        "consumer": {"originVideoKey": "spectrum/origin/video.mp4"},
                        "media": {"stream": {
                            "h264": [
                                {"masterUrl": "https://sns-video-bd.xhscdn.com/stream-480", "height": 480},
                                {"masterUrl": "https://sns-video-bd.xhscdn.com/stream-1080", "height": 1080,
                                 "backupUrls": ["https://sns-video-hw.xhscdn.com/stream-1080-bak"]}
                            ],
                            "av1": [{"masterUrl": "https://sns-video-bd.xhscdn.com/stream-av1", "height": 2160}]
                        }}
                    }
                }
            }
        }
    }
}

HTML = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>bridge</title></head>
<body><pre id="out">pending</pre>
<script>
window.__errs = [];
window.addEventListener('error', function (e) {
  window.__errs.push((e.message || '?') + ' @line' + (e.lineno || '?'));
});
window.__seen = [];
window.__log = [];
window.addEventListener('message', function (ev) {
  if (!ev.data || ev.data.__channel !== 'xhs-dl') return;
  window.__seen.push(ev.data.type);
  if (ev.data.type === 'NOTE') {
    var n = ev.data.payload;
    var L = window.__log;
    L.push('NOTE noteId=' + n.noteId);
    L.push('  title=' + n.title);
    L.push('  type=' + n.type);
    L.push('  author=' + n.author.nickname + ' / redId=' + n.author.redId);
    L.push('  ipLocation=' + n.ipLocation);
    L.push('  images=' + n.images.length);
    n.images.forEach(function (im, i) {
      L.push('   img[' + i + '] isLive=' + im.isLive +
             ' urlOrigin=' + im.urlOrigin +
             ' liveVideoUrl=' + im.liveVideoUrl);
      if (im.liveVideoUrls && im.liveVideoUrls.length) {
        L.push('     liveVideoUrls(' + im.liveVideoUrls.length + ')=' + im.liveVideoUrls.join(' , '));
      }
    });
    L.push('  video.urlOrigin=' + (n.video && n.video.urlOrigin));
    L.push('  video.urlStream=' + (n.video && n.video.urlStream));
    if (n.video && n.video.urlStreams && n.video.urlStreams.length) {
      L.push('  video.urlStreams(' + n.video.urlStreams.length + ')=' + n.video.urlStreams.join(' , '));
    }
    L.push('  video.originKey=' + (n.video && n.video.originKey));
  }
});
</script>
<script>window.__INITIAL_STATE__ = __FIXTURE__;</script>

<!-- 监听器必须在拦截器之前注册，否则会漏掉 document-start 时投递的 NOTE -->
<script>__SRC__</script>
<script>window.__flag = (typeof window.__XHS_DL_INTERCEPTOR__);</script>

<script>
(function () {
  var log = window.__log;
  var seen = window.__seen;

  // 模拟隔离世界发起重扫。发送侧用 '*' —— file:// 下 location.origin 是
  // 字符串 "null"，作为 targetOrigin 非法会导致 postMessage 抛异常。
  setTimeout(function () {
    try {
      window.postMessage({ __channel: 'xhs-dl', type: 'REQUEST_RESCAN' }, '*');
      log.push('[sender] REQUEST_RESCAN 已发出');
    } catch (e) {
      log.push('[sender] postMessage 抛异常: ' + e.message);
    }
  }, 50);

  setTimeout(function () {
    log.unshift('=== 收到的消息类型: ' + (seen.join(', ') || '(无)') + ' ===');
    log.push('');
    log.push('拦截器标记 __XHS_DL_INTERCEPTOR__ = ' + window.__flag);
    log.push('location.origin = ' + JSON.stringify(location.origin));
    log.push('页面捕获到的 JS 错误: ' + (window.__errs.length ? window.__errs.join(' | ') : '(无)'));
    log.push('RESCAN_DONE 是否收到: ' + (seen.indexOf('RESCAN_DONE') !== -1 ? 'YES' : 'NO'));
    log.push('MEDIA_HINTS 是否收到: ' + (seen.indexOf('MEDIA_HINTS') !== -1 ? 'YES' : 'NO'));
    document.getElementById('out').textContent = log.join('\\n');
  }, 600);
})();
</script></body></html>"""

html = HTML.replace("__FIXTURE__", json.dumps(FIXTURE, ensure_ascii=False)).replace("__SRC__", SRC)

with open(PAGE, "w", encoding="utf-8") as f:
    f.write(html)

cmd = [
    EDGE, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--user-data-dir=" + os.path.join(ROOT, "..", ".workbuddy-ai", "edgeprofile"),
    "--window-size=1000,800", "--virtual-time-budget=3000",
    "--dump-dom", "file:///" + PAGE.replace("\\", "/"),
]
r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore", timeout=120)
dom = r.stdout or ""
s = dom.find('<pre id="out">')
e = dom.find('</pre>', s)
out = dom[s + len('<pre id="out">'):e] if s >= 0 else dom[:2000]
print(out.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&"))
