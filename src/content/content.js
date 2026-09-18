/**
 * 小红书下载助手 — 内容脚本编排层（ISOLATED world）
 * ------------------------------------------------------------------
 * 职责：
 *   1. 接收页面世界（MAIN world）投递的笔记数据，维护「当前笔记」状态
 *   2. 加载用户设置，驱动 UI 与页面世界钩子开关
 *   3. 把用户勾选翻译成下载任务，交给后台 Service Worker
 *   4. 处理后台回传的进度 / 完成 / 失败事件
 *
 * 数据正确性关键点：SPA 切换笔记时**必须清空上一笔记的缓存**，
 * 否则会把上一篇的文件名套到这一篇上（开源方案里常见的串台 bug）。
 */
(function () {
  'use strict';

  var CHANNEL = 'xhs-dl';
  var DEFAULT_SETTINGS = {
    nameRule: '[<发布者昵称>] <标题>_<序号>',
    timeFormat: 'YYYYMMDD',
    imageFormat: 'origin',
    videoQuality: 'origin',
    // 多档直链的排序策略：compat=编解码器兼容性优先(h264 最稳)，quality=画质优先
    streamPreference: 'compat',
    liveMode: 'both',
    dirByAuthor: false,
    dirByTitle: false,
    baseDir: '小红书下载',
    hookEnabled: true
  };

  var settings = Object.assign({}, DEFAULT_SETTINGS);
  var current = null;          // 当前笔记（归一化后的 NoteData）
  var mediaHints = { videos: [] };
  var hookDisabledNotified = false;

  /**
   * 入站数据白名单。
   * 页面世界投递过来的数据理论上可被页面自身的脚本伪造（攻击者可在
   * xiaohongshu.com 上执行脚本），因此所有来自页面世界的字段都要过一遍
   * 校验：URL 必须是 http(s) 且落在小红书自有域名内，字符串要限长。
   * 这同时也挡住了「把扩展当通用下载器」的滥用路径。
   */
  /** 与 background.js 保持一致：含国际站 rednote.com 及其 CDN */
  var ALLOWED_HOST_RE = /(^|\.)(xhscdn\.com|xhscdn\.net|rednotecdn\.com|xiaohongshu\.com|rednote\.com)$/i;
  var MAX_IMAGES = 200;
  var MAX_LEN = { title: 300, desc: 5000, nickname: 100, ipLocation: 50, noteId: 64 };

  function safeUrl(u) {
    if (typeof u !== 'string' || !u) return '';
    try {
      var url = new URL(u, 'https://www.xiaohongshu.com/');
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
      if (!ALLOWED_HOST_RE.test(url.hostname)) return '';
      return url.href;
    } catch (e) {
      return '';
    }
  }

  /** URL 数组白名单：逐条过 safeUrl，去重并限长 */
  function safeUrlList(arr, max) {
    if (!Array.isArray(arr)) return [];
    var out = [];
    var seen = {};
    for (var i = 0; i < arr.length && out.length < max; i++) {
      var u = safeUrl(arr[i]);
      if (!u || seen[u]) continue;
      seen[u] = 1;
      out.push(u);
    }
    return out;
  }

  function safeStr(s, max) {
    if (typeof s !== 'string') return '';
    // 去掉控制字符，防止污染 UI 与文件名
    return s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  }

  /** 把不可信的页面数据清洗成可信的 NoteData；无法通过校验则返回 null */
  function sanitizeNote(raw) {
    if (!raw || typeof raw !== 'object') return null;

    var noteId = safeStr(raw.noteId, MAX_LEN.noteId);
    if (!/^[0-9a-zA-Z_-]{6,64}$/.test(noteId)) return null;

    var out = {
      noteId: noteId,
      source: safeStr(raw.source, 40),
      url: 'https://www.xiaohongshu.com/explore/' + noteId,
      title: safeStr(raw.title, MAX_LEN.title),
      desc: safeStr(raw.desc, MAX_LEN.desc),
      type: raw.type === 'video' ? 'video' : 'normal',
      publishTime: (typeof raw.publishTime === 'number' && isFinite(raw.publishTime) && raw.publishTime > 0)
        ? raw.publishTime : 0,
      ipLocation: safeStr(raw.ipLocation, MAX_LEN.ipLocation),
      cover: safeUrl(raw.cover),
      author: {
        nickname: safeStr(raw.author && raw.author.nickname, MAX_LEN.nickname),
        userId: safeStr(raw.author && raw.author.userId, 64),
        redId: safeStr(raw.author && raw.author.redId, 64),
        avatar: safeUrl(raw.author && raw.author.avatar)
      },
      images: [],
      video: null
    };

    var list = Array.isArray(raw.images) ? raw.images.slice(0, MAX_IMAGES) : [];
    for (var i = 0; i < list.length; i++) {
      var img = list[i];
      if (!img || typeof img !== 'object') continue;
      var urlDefault = safeUrl(img.urlDefault);
      var urlOrigin = safeUrl(img.urlOrigin);
      var urlJpg = safeUrl(img.urlJpg);
      var live = safeUrl(img.liveVideoUrl);
      if (!urlDefault && !urlOrigin && !urlJpg && !live) continue;
      out.images.push({
        index: out.images.length,
        urlDefault: urlDefault,
        urlOrigin: urlOrigin,
        urlJpg: urlJpg,
        liveVideoUrl: live,
        // 实况视频的备用直链，供下载失败时重试；上限 6 条，逐条过 URL 白名单
        liveVideoUrls: safeUrlList(img.liveVideoUrls, 6),
        liveVideoUrlsBest: safeUrlList(img.liveVideoUrlsBest, 6),
        isLive: !!(live || img.isLive),
        width: Number(img.width) || 0,
        height: Number(img.height) || 0
      });
    }

    if (raw.video && typeof raw.video === 'object') {
      var vOrigin = safeUrl(raw.video.urlOrigin);
      var vStream = safeUrl(raw.video.urlStream);
      if (vOrigin || vStream) {
        out.video = {
          urlOrigin: vOrigin,
          originKey: safeStr(raw.video.originKey, 200),
          urlStream: vStream,
          // 按画质降序的备用直链（原画质失败时逐条降级）
          urlStreams: safeUrlList(raw.video.urlStreams, 6),
          urlStreamsBest: safeUrlList(raw.video.urlStreamsBest, 6),
          cover: safeUrl(raw.video.cover),
          duration: Number(raw.video.duration) || 0
        };
        if (out.type !== 'video') out.type = 'video';
      }
    }

    return out;
  }

  /* ========================= 工具 ========================= */

  function currentNoteIdFromUrl() {
    var m = location.pathname.match(/\/(?:explore|discovery\/item)\/([0-9a-zA-Z]+)/);
    return m ? m[1] : '';
  }

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; });
    } catch (e) { /* 扩展被重载时可能抛错，忽略 */ }
  }

  /* ========================= 设置 ========================= */

  function loadSettings() {
    return new Promise(function (resolve) {
      chrome.storage.local.get('xhs_settings', function (r) {
        settings = Object.assign({}, DEFAULT_SETTINGS, (r && r.xhs_settings) || {});
        XHS_DL_UI.setSettings(settings);
        applyHookSetting();
        resolve(settings);
      });
    });
  }

  /**
   * 不透明源判定。file:// 页面的 location.origin 是字符串 "file://"，
   * 沙箱 iframe / data: 等则是 "null"。这两种情况下 origin 无法用于同源比对：
   *   - 作为 postMessage 的 targetOrigin 非法（"null"）或永远匹配不上（"file://"）
   *   - 同窗口消息的 ev.origin 统一是字符串 "null"，与 location.origin 永不相等
   * 生产环境（https://www.xiaohongshu.com）不走这条分支，此处纯属健壮性兜底。
   */
  function originComparable() {
    var o = location.origin;
    return !!o && o !== 'null' && o !== 'file://';
  }

  /** postMessage 的 targetOrigin：可比对时精确限定（比 '*' 安全），否则退回 '*'。 */
  function targetOrigin() {
    return originComparable() ? location.origin : '*';
  }

  /**
   * 入站消息同源校验。
   * 注意：这**不是**安全边界——同窗口的页面脚本可以伪造 ev.origin 之外的一切，
   * 真正防线是 acceptNote() 里的 sanitizeNote() 白名单。这里只做粗筛。
   */
  function originOk(ev) {
    return !originComparable() || ev.origin === location.origin;
  }

  function applyHookSetting() {
    window.postMessage({
      __channel: CHANNEL,
      type: 'SET_HOOK',
      payload: { enabled: settings.hookEnabled !== false }
    }, targetOrigin());
  }

  /* ========================= 笔记状态 ========================= */

  function acceptNote(raw) {
    var data = sanitizeNote(raw);
    if (!data) return;

    // SPA 串台防护：URL 上能取到 noteId 且与数据不一致时，说明数据是上一篇的。
    // 首页 feed 会一次返回多条笔记，此时以 URL 为准，忽略非当前条目。
    var urlId = currentNoteIdFromUrl();
    if (urlId && data.noteId !== urlId) return;

    if (current && current.noteId === data.noteId) {
      // 同一篇笔记的更新：保留用户已勾选状态，只刷新数据
      current = mergeNote(current, data);
      XHS_DL_UI.setNote(current);
      return;
    }

    current = data;
    hookDisabledNotified = false;
    XHS_DL_UI.setNote(current);
    XHS_DL_UI.setBanner('', null);
    updateBadge();
  }

  /** 合并两份同一笔记的数据，字段更完整者胜出 */
  function mergeNote(a, b) {
    var out = Object.assign({}, a, b);
    if (b.images.length < a.images.length) out.images = a.images;
    if (!b.video && a.video) out.video = a.video;
    if (!out.author.nickname && a.author.nickname) out.author = a.author;
    return out;
  }

  function updateBadge() {
    if (!current) { XHS_DL_UI.setBadge(0); return; }
    var n = current.images.length + (current.video ? 1 : 0);
    XHS_DL_UI.setBadge(n);
  }

  function clearNote() {
    current = null;
    mediaHints = { videos: [] };
    XHS_DL_UI.clearNote();
    XHS_DL_UI.setBadge(0);
  }

  /* ========================= DOM 兜底提取 ========================= */

  /**
   * 三级降级的最后一级：页面状态和网络响应都拿不到时，从 DOM 直接抠。
   * 拿到的是压缩图 / blob 视频，信息不完整，仅保证「有总比没有好」。
   */
  function domFallback() {
    var noteId = currentNoteIdFromUrl() || ('dom_' + Date.now());
    var images = [];
    var seen = Object.create(null);
    var nodes = document.querySelectorAll(
      '#noteContainer img, .note-image-box img, .media-container img, .swiper-slide img'
    );
    for (var i = 0; i < nodes.length; i++) {
      var src = nodes[i].currentSrc || nodes[i].src || '';
      if (!src || src.indexOf('http') !== 0 || seen[src]) continue;
      if (/(avatar|icon|logo|sprite)/i.test(src)) continue;
      seen[src] = 1;
      images.push({
        index: images.length,
        urlDefault: src,
        urlOrigin: '',
        urlJpg: '',
        liveVideoUrl: '',
        isLive: false,
        width: nodes[i].naturalWidth || 0,
        height: nodes[i].naturalHeight || 0
      });
    }

    var videoEl = document.querySelector('#noteContainer video, .media-container video');
    var video = null;
    if (videoEl) {
      // 优先用 performance 里观察到的真实 CDN 直链（blob: 地址无法直接下载）
      var real = mediaHints.videos.length ? mediaHints.videos[mediaHints.videos.length - 1] : '';
      video = {
        urlOrigin: real,
        originKey: '',
        urlStream: real,
        cover: videoEl.poster || '',
        duration: videoEl.duration || 0
      };
    }

    if (!images.length && !video) return null;

    var titleEl = document.querySelector('#detail-title, .title, .note-content .title');
    return {
      noteId: noteId,
      source: 'dom',
      url: location.href,
      title: (titleEl && titleEl.textContent.trim()) || document.title || '',
      desc: '',
      type: video ? 'video' : 'normal',
      publishTime: 0,
      ipLocation: '',
      cover: images.length ? images[0].urlDefault : (video ? video.cover : ''),
      author: { nickname: '', userId: '', redId: '', avatar: '' },
      images: images,
      video: video
    };
  }

  function tryDomFallback() {
    try {
      var d = sanitizeNote(domFallback());
      if (d) {
        current = d;
        XHS_DL_UI.setNote(d);
        XHS_DL_UI.setBanner('未能读取页面数据，已降级为页面元素提取：原图/原画质可能不可用。', 'warn');
        updateBadge();
      }
    } catch (e) { /* 忽略 */ }
  }

  /* ========================= 页面世界消息 ========================= */

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    if (!originOk(ev)) return;
    var d = ev.data;
    if (!d || d.__channel !== CHANNEL) return;

    switch (d.type) {
      case 'NOTE':
        acceptNote(d.payload);
        break;

      case 'MEDIA_HINTS': {
        var raw = (d.payload && d.payload.videos) || [];
        var clean = [];
        for (var i = 0; i < raw.length && clean.length < 80; i++) {
          var u = safeUrl(raw[i]);
          if (u) clean.push(u);
        }
        mediaHints = { videos: clean };
        XHS_DL_UI.setMediaHints(mediaHints);
        // 有笔记但视频直链缺失时，用观察到的真实 URL 补上
        if (current && current.video && !current.video.urlStream && clean.length) {
          current.video.urlStream = clean[clean.length - 1];
        }
        break;
      }

      case 'HOOK_DISABLED':
        if (!hookDisabledNotified && d.payload && d.payload.reason === 'video-error') {
          hookDisabledNotified = true;
          XHS_DL_UI.setBanner('检测到页面视频播放异常，已自动停用网络监听以保证播放正常。重新加载页面可恢复。', 'warn');
        }
        break;

      case 'RESCAN_DONE':
        if (!current) {
          tryDomFallback();
          if (!current) XHS_DL_UI.toast('没有识别到笔记数据', 'error');
        }
        break;

      case 'ROUTE_CHANGE':
        clearNote();
        XHS_DL_UI.setBanner('', null);
        break;
    }
  });

  function requestRescan() {
    window.postMessage({ __channel: CHANNEL, type: 'REQUEST_RESCAN' }, targetOrigin());
  }

  /* ========================= 下载 ========================= */

  function doDownload(note, selected) {
    var tasks = XHS_DL_DOWNLOADER.buildTasks(note, selected, settings);
    if (!tasks.length) {
      XHS_DL_UI.toast('没有可下载的内容', 'error');
      return;
    }
    XHS_DL_UI.setBusy(true);
    XHS_DL_UI.hideProgress();
    send({
      type: 'DOWNLOAD_BATCH',
      payload: { tasks: tasks, noteId: note.noteId }
    });
  }

  function onBackgroundMessage(msg, sender, sendResponse) {
    // ---- 来自 Popup 的同步请求（必须立即应答） ----
    if (msg.type === 'GET_NOTE') {
      if (!current) {
        // popup 打开时顺手再兜底一次，避免用户刚进详情页就点图标拿不到数据
        tryDomFallback();
      }
      sendResponse({ ok: !!current, note: current });
      return false;
    }

    if (msg.type === 'DOWNLOAD_ALL') {
      if (!current) { sendResponse({ ok: false, error: 'no-note' }); return false; }
      var all = current.images.map(function (i) { return i.index; });
      if (current.video) all.unshift(-1);
      doDownload(current, all);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'OPEN_PANEL') {
      XHS_DL_UI.open();
      sendResponse({ ok: true });
      return false;
    }

    var p = (msg && msg.payload) || {};
    switch (msg.type) {
      case 'DL_START':
        XHS_DL_UI.setBusy(true);
        XHS_DL_UI.setProgress(0, p.pending || p.total, '准备下载…');
        if (p.skipped) XHS_DL_UI.toast('已跳过 ' + p.skipped + ' 个重复文件');
        break;

      case 'DL_PROGRESS':
        XHS_DL_UI.setProgress(p.done || 0, p.total || 0, p.current || '');
        break;

      case 'DL_ITEM_PROGRESS':
        XHS_DL_UI.setProgress(p.done || 0, p.totalItems || 0,
          (p.name || '') + '  ' + (p.pct || 0) + '%');
        break;

      case 'DL_SKIPPED':
        XHS_DL_UI.toast('已跳过 ' + p.count + ' 个已下载过的文件');
        break;

      case 'DL_ALL_DONE': {
        XHS_DL_UI.setBusy(false);
        var failed = (p.failed || []).length;
        if (failed === 0) {
          XHS_DL_UI.setProgress(p.total, p.total, '全部完成');
          XHS_DL_UI.toast('下载完成，共 ' + (p.ok || 0) + ' 个文件', 'success');
          setTimeout(function () { XHS_DL_UI.hideProgress(); }, 2500);
        } else {
          XHS_DL_UI.setProgress(p.total - failed, p.total, failed + ' 个失败');
          XHS_DL_UI.toast('完成 ' + (p.ok || 0) + ' 个，失败 ' + failed + ' 个' +
            (p.lastError ? '（' + p.lastError + '）' : ''), 'error');
        }
        break;
      }
    }
    if (sendResponse) sendResponse({ ok: true });
    return false;
  }

  /* ========================= 复制直链 / 导出元数据 ========================= */

  function collectUrls(note, selected) {
    var urls = [];
    if (note.video && selected.indexOf(-1) !== -1) {
      urls.push(settings.videoQuality === 'origin'
        ? (note.video.urlOrigin || note.video.urlStream)
        : (note.video.urlStream || note.video.urlOrigin));
    }
    note.images.forEach(function (img) {
      if (selected.indexOf(img.index) === -1) return;
      var u = settings.imageFormat === 'default'
        ? img.urlDefault
        : (settings.imageFormat === 'jpg' ? (img.urlJpg || img.urlOrigin) : (img.urlOrigin || img.urlDefault));
      if (u) urls.push(u);
      if (img.liveVideoUrl && settings.liveMode !== 'image-only') urls.push(img.liveVideoUrl);
    });
    return urls.filter(Boolean);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        XHS_DL_UI.toast('已复制 ' + text.split('\n').length + ' 条直链', 'success');
      }).catch(function () {
        fallbackCopy(text);
      });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      XHS_DL_UI.toast(ok ? '已复制直链' : '复制失败，请手动选择', ok ? 'success' : 'error');
    } catch (e) {
      XHS_DL_UI.toast('复制失败', 'error');
    }
  }

  function exportJson(note) {
    try {
      var payload = JSON.stringify({
        exportedAt: new Date().toISOString(),
        note: note,
        directLinks: collectUrls(note, note.images.map(function (i) { return i.index; })
          .concat(note.video ? [-1] : []))
      }, null, 2);
      var blob = new Blob([payload], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = XHS_DL_DOWNLOADER.sanitize(note.title || note.noteId) + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      XHS_DL_UI.toast('元数据已导出', 'success');
    } catch (e) {
      XHS_DL_UI.toast('导出失败', 'error');
    }
  }

  /* ========================= 启动 ========================= */

  function boot() {
    XHS_DL_UI.mount({
      onOpen: function () {
        requestRescan();
        if (!current) tryDomFallback();
      },
      onRescan: function () {
        clearNote();
        requestRescan();
        setTimeout(function () {
          if (!current) tryDomFallback();
        }, 900);
      },
      onOptions: function () {
        try { chrome.runtime.openOptionsPage(); } catch (e) { /* 忽略 */ }
      },
      onDownload: doDownload,
      onCopyLinks: function (note, selected) {
        if (!note) return;
        copyText(collectUrls(note, selected).join('\n'));
      },
      onExportJson: function (note) {
        if (note) exportJson(note);
      },
      // background.js 一直支持 CANCEL_BATCH，但此前没有任何入口发送它，
      // 用户只能干等一批下载跑完。这里把能力接到 UI 上。
      onCancel: function () {
        try {
          chrome.runtime.sendMessage({ type: 'CANCEL_BATCH' }, function () {
            // 取消是尽力而为：已发出的 chrome.downloads 调用无法撤回，
            // 只能阻止后续任务继续入队
            if (chrome.runtime.lastError) { /* 忽略：SW 可能已被回收 */ }
          });
          XHS_DL_UI.toast('已请求取消，剩余任务不会再开始');
        } catch (e) {
          XHS_DL_UI.toast('取消失败：' + (e && e.message ? e.message : e));
        }
      },
      onPositionChange: function (pos) {
        try { chrome.storage.local.set({ xhs_ball_pos: pos }); } catch (e) { /* 忽略 */ }
      }
    });

    chrome.storage.local.get('xhs_ball_pos', function (r) {
      if (r && r.xhs_ball_pos) XHS_DL_UI.setPosition(r.xhs_ball_pos);
    });

    loadSettings().then(function () {
      // 设置变化时热更新（用户在设置页改完立刻生效，无需刷新页面）
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes.xhs_settings) return;
        settings = Object.assign({}, DEFAULT_SETTINGS, changes.xhs_settings.newValue || {});
        XHS_DL_UI.setSettings(settings);
        applyHookSetting();
      });
    });

    chrome.runtime.onMessage.addListener(onBackgroundMessage);

    // 首屏稍等再兜底，给页面状态注入留出时间
    setTimeout(function () {
      if (!current) tryDomFallback();
    }, 3500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
