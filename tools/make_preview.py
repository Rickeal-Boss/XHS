"""把扩展的真实 UI 代码打包成一个自包含的 HTML 预览页。

不是画示意图 —— 直接内联 styles.js / downloader.js / ui.js 的原文件内容，
在浏览器里真正跑一遍扩展的面板与 Popup，所见即所得。
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))          # XHS/
OUT = os.path.join(ROOT, "..", "deliverables", "preview", "xhs-ui-preview.html")


def read(p):
    with open(os.path.join(ROOT, p), encoding="utf-8") as f:
        return f.read()


MOCK_NOTE = """
{
  noteId: '65f1a2b3000000001203abcd',
  source: 'preview',
  url: 'https://www.xiaohongshu.com/explore/65f1a2b3000000001203abcd',
  title: '周末去了趟莫干山，这家民宿真的绝了，竹林view直接封神',
  desc: '住进山里两天，早上被鸟叫醒的感觉太好了。',
  type: 'video',
  publishTime: 1711612800,
  ipLocation: '浙江',
  cover: '',
  author: {
    nickname: '旅行的小鹿',
    userId: '5f2c1b9a',
    redId: 'lulu_trip',
    avatar: ''
  },
  images: [
    { index: 0, urlDefault: IMG_A, urlOrigin: IMG_A, urlJpg: IMG_A, liveVideoUrl: '', isLive: false, width: 1080, height: 1440 },
    { index: 1, urlDefault: IMG_B, urlOrigin: IMG_B, urlJpg: IMG_B, liveVideoUrl: 'https://sns-video-bd.xhscdn.com/preview-live-1', isLive: true, width: 1080, height: 1440 },
    { index: 2, urlDefault: IMG_C, urlOrigin: IMG_C, urlJpg: IMG_C, liveVideoUrl: 'https://sns-video-bd.xhscdn.com/preview-live-2', isLive: true, width: 1080, height: 1440 },
    { index: 3, urlDefault: IMG_D, urlOrigin: IMG_D, urlJpg: IMG_D, liveVideoUrl: '', isLive: false, width: 1080, height: 1440 },
    { index: 4, urlDefault: IMG_E, urlOrigin: IMG_E, urlJpg: IMG_E, liveVideoUrl: '', isLive: false, width: 1080, height: 1440 },
    { index: 5, urlDefault: IMG_F, urlOrigin: IMG_F, urlJpg: IMG_F, liveVideoUrl: '', isLive: false, width: 1080, height: 1440 }
  ],
  video: {
    urlOrigin: 'https://sns-video-hw.xhscdn.com/preview-origin',
    originKey: 'preview-origin',
    urlStream: 'https://sns-video-bd.xhscdn.com/preview-stream',
    cover: IMG_A,
    duration: 42
  }
}
"""


def svg_thumb(c1, c2, label):
    svg = (
        "<svg xmlns='http://www.w3.org/2000/svg' width='300' height='400'>"
        "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>"
        "<stop offset='0' stop-color='%s'/><stop offset='1' stop-color='%s'/>"
        "</linearGradient></defs>"
        "<rect width='300' height='400' fill='url(#g)'/>"
        "<text x='150' y='205' font-size='42' fill='rgba(255,255,255,.85)' "
        "font-family='sans-serif' text-anchor='middle'>%s</text></svg>" % (c1, c2, label)
    )
    return "data:image/svg+xml;charset=utf-8," + svg.replace("#", "%23").replace("'", "%27").replace(" ", "%20")


THUMBS = {
    "IMG_A": ("%23ffb199", "%23ff2442", "1"),
    "IMG_B": ("%23a8d8ea", "%234a7db8", "2"),
    "IMG_C": ("%23ffd3a5", "%23d98b16", "3"),
    "IMG_D": ("%23b8e6c1", "%231a9e5c", "4"),
    "IMG_E": ("%23d5c6f0", "%236c4bb8", "5"),
    "IMG_F": ("%23ffc2d1", "%23c2185b", "6"),
}

POPUP_HTML = read("src/popup/popup.html")
# 抽出 popup 的 body 内容用于同页预览
_body_start = POPUP_HTML.index("<body>") + len("<body>")
_body_end = POPUP_HTML.index("</body>")
POPUP_BODY = POPUP_HTML[_body_start:_body_end]
POPUP_BODY = POPUP_BODY.replace('<script src="../content/downloader.js"></script>', "")
POPUP_BODY = POPUP_BODY.replace('<script src="popup.js"></script>', "")

HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>小红书下载助手 · UI 预览</title>
<style>
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                 "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    background: #f2f3f5;
    color: #1f1f1f;
  }
  .doc { max-width: 1080px; margin: 0 auto; padding: 36px 24px 80px; }
  .doc h1 { font-size: 22px; margin: 0 0 6px; }
  .doc .lead { color: #6b6b70; font-size: 13.5px; line-height: 1.75; margin: 0 0 28px; }
  .note-bar {
    background: #fff; border: 1px solid #e8e8ea; border-left: 3px solid #ff2442;
    border-radius: 8px; padding: 12px 16px; font-size: 13px; color: #6b6b70;
    line-height: 1.7; margin-bottom: 28px;
  }
  .note-bar b { color: #1f1f1f; }
  .cols { display: flex; gap: 28px; flex-wrap: wrap; align-items: flex-start; }
  .col { flex: 1 1 340px; min-width: 320px; }
  .col > h2 {
    font-size: 14px; margin: 0 0 10px; color: #1f1f1f;
    display: flex; align-items: center; gap: 8px;
  }
  .col > h2 .tag {
    font-size: 11px; font-weight: 500; color: #d81e38;
    background: rgba(255,36,66,.08); padding: 2px 8px; border-radius: 999px;
  }
  /* 给 Popup 预览一个手机弹窗外框 */
  .popup-frame {
    width: 320px; background: #fff; border: 1px solid #e8e8ea;
    border-radius: 12px; overflow: hidden; box-shadow: 0 6px 24px rgba(0,0,0,.08);
    font-size: 13px; color: #1f1f1f;
  }
  .popup-frame * { box-sizing: border-box; }
  .popup-frame .hd, .popup-frame .ft { font-family: inherit; }
  .popup-frame #title, .popup-frame #author, .popup-frame #stats { margin: 0; }
  .popup-frame .state { padding: 34px 18px; text-align: center; color: #9a9aa0; }
  .popup-frame .btn {
    height: 36px; border: none; border-radius: 9px; background: #ff2442; color: #fff;
    font-size: 13px; font-weight: 600; font-family: inherit; cursor: pointer; width: 100%;
  }
  .popup-frame .btn.ghost { background: #f7f7f8; color: #1f1f1f; border: 1px solid #e8e8ea; }
  .popup-frame .actions { display: flex; flex-direction: column; gap: 8px; padding: 0 14px 12px; }
  .popup-frame .note { display: flex; gap: 10px; padding: 12px 14px; }
  .popup-frame .cover { width: 64px; height: 84px; border-radius: 8px; object-fit: cover; flex: 0 0 auto; background: #f7f7f8; }
  .popup-frame .note-info { flex: 1 1 auto; min-width: 0; }
  .popup-frame .title { font-size: 13px; font-weight: 600; line-height: 1.4; }
  .popup-frame .author { font-size: 12px; color: #6b6b70; }
  .popup-frame .stats { font-size: 12px; color: #9a9aa0; margin-top: 4px; }
  .popup-frame .hint { padding: 0 14px 12px; font-size: 12px; color: #9a9aa0; line-height: 1.6; }
  .popup-frame .hd { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid #e8e8ea; }
  .popup-frame .hd-brand { display: flex; align-items: center; gap: 7px; font-weight: 600; font-size: 14px; }
  .popup-frame .dot { width: 8px; height: 8px; border-radius: 50%; background: #ff2442; box-shadow: 0 0 0 3px rgba(255,36,66,.14); }
  .popup-frame .icon { width: 26px; height: 26px; border: none; border-radius: 6px; background: transparent; color: #6b6b70; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .popup-frame .ft { display: flex; align-items: center; gap: 5px; padding: 9px 14px; border-top: 1px solid #e8e8ea; font-size: 11px; color: #9a9aa0; background: #f7f7f8; }
</style>
</head>
<body>
<div class="doc">
  <h1>小红书下载助手 · UI 预览</h1>
  <p class="lead">
    本页直接加载扩展的真实源码（<code>styles.js</code> / <code>downloader.js</code> / <code>ui.js</code>），
    在浏览器里真实渲染悬浮球与下载面板，<b>不是示意图</b>。右侧面板内容为仿真笔记数据。
  </p>

  <div class="note-bar">
    <b>面板已经自动展开</b>（真实使用时由右下角悬浮球触发）。点击缩略图可切换勾选，
    观察 <code>实况</code> 徽标、选中态与底部按钮文案变化。<br>
    右下角那个圆形按钮就是扩展注入到小红书页面的<b>悬浮球</b>，可拖动。
  </div>

  <div class="cols">
    <div class="col">
      <h2>Popup<span class="tag">点击扩展图标</span></h2>
      <div class="popup-frame">
        __POPUP_BODY__
      </div>
    </div>
    <div class="col">
      <h2>侧滑面板<span class="tag">点击悬浮球</span></h2>
      <p class="lead" style="margin:0">
        面板宽度 380px，从右侧滑入。<b>本页右下角悬浮球与面板即为真实组件</b>，
        样式封装在 Shadow DOM 内。
      </p>
    </div>
  </div>
</div>

<script>
// ---- 预览环境桩：模拟 chrome 扩展 API ----
window.chrome = {
  storage: {
    local: { get: function (k, cb) { cb({}); }, set: function () {} },
    onChanged: { addListener: function () {} }
  },
  runtime: { getManifest: function () { return { version: '1.0.0' }; } }
};
</script>

<script>
__STYLES__
</script>
<script>
__DOWNLOADER__
</script>
<script>
__UI__
</script>
<script>
(function () {
  var IMG_A = "__IMG_A__", IMG_B = "__IMG_B__", IMG_C = "__IMG_C__",
      IMG_D = "__IMG_D__", IMG_E = "__IMG_E__", IMG_F = "__IMG_F__";

  var NOTE = __MOCK_NOTE__;

  XHS_DL_UI.mount({
    onOpen: function () {},
    onClose: function () {},
    onOptions: function () {},
    onRescan: function () {},
    onDownload: function () {},
    onCopyLinks: function () {},
    onExportJson: function () {},
    onPositionChange: function () {}
  });

  XHS_DL_UI.setSettings({
    nameRule: '[<发布者昵称>] <标题>_<序号>',
    timeFormat: 'YYYYMMDD',
    imageFormat: 'origin',
    videoQuality: 'origin',
    liveMode: 'both',
    dirByAuthor: false,
    dirByTitle: false,
    baseDir: '小红书下载',
    hookEnabled: true
  });

  XHS_DL_UI.setNote(NOTE);
  XHS_DL_UI.setBadge(NOTE.images.length + (NOTE.video ? 1 : 0));
  setTimeout(function () { XHS_DL_UI.open(); }, 120);

  // ---- 填充 Popup 预览 ----
  function $(id) { return document.getElementById(id); }
  var cover = NOTE.images[0].urlDefault;
  $('cover').src = cover;
  $('title').textContent = NOTE.title;
  $('author').textContent = '@' + NOTE.author.nickname;
  var liveCount = NOTE.images.filter(function (i) { return i.isLive; }).length;
  $('stats').textContent = '视频 1 · 图片 ' + NOTE.images.length + ' · 实况 ' + liveCount;
  $('loading').hidden = true;
  $('unsupported').hidden = true;
  $('ready').hidden = false;
  $('version').textContent = 'v1.0.0';

  var files = NOTE.images.length + 1 + liveCount;
  $('btnAll').textContent = '下载本笔记全部（' + files + ' 个文件）';
  $('hint').textContent = '实况照片会同时下载图片与配套短视频（_live 后缀）。可在设置中修改。';

  // 演示命名模板效果
  var vars = {
    index: 1,
    noteId: NOTE.noteId,
    title: NOTE.title,
    publishTime: XHS_DL_DOWNLOADER.formatTime(NOTE.publishTime, 'YYYYMMDD'),
    ipLocation: NOTE.ipLocation,
    nickname: NOTE.author.nickname,
    redId: NOTE.author.redId,
    userId: NOTE.author.userId
  };
  console.log('[预览] 命名模板渲染结果：',
    XHS_DL_DOWNLOADER.renderName('[<发布者昵称>] <标题>_<序号>', vars));
})();
</script>
</body>
</html>
"""


def main():
    html = HTML
    html = html.replace("__POPUP_BODY__", POPUP_BODY)
    html = html.replace("__STYLES__", read("src/content/styles.js"))
    html = html.replace("__DOWNLOADER__", read("src/content/downloader.js"))
    html = html.replace("__UI__", read("src/content/ui.js"))
    html = html.replace("__MOCK_NOTE__", MOCK_NOTE)
    for k, v in THUMBS.items():
        html = html.replace("__%s__" % k, svg_thumb(*v))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html)
    print("预览页生成 ->", os.path.abspath(OUT))
    print("大小: %.1f KB" % (os.path.getsize(OUT) / 1024))


if __name__ == "__main__":
    main()
