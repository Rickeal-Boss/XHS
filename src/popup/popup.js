/**
 * 小红书下载助手 — Popup
 * Popup 的定位是「当前笔记摘要 + 一键全下 + 设置入口」。
 * 真正的挑选 / 进度 / 长任务都交给页面内的侧滑面板，
 * 因为 popup 一旦失焦就会关闭，承载不了这些交互。
 *
 * 注意：本扩展没有申请 tabs 权限，因此 tabs.query 拿不到 url 字段，
 * 也无法据此判断页面类型 —— 一切信息都从内容脚本取。
 */
(function () {
  'use strict';

  /**
   * 设置项默认值。
   * popup 与内容脚本运行在不同上下文（无法 require content.js 里的
   * DEFAULT_SETTINGS），因此这里保留一份副本。三处默认值副本
   * （options.js / content.js / background.js）与本副本的一致性由
   * tests/test-static.js 的 DEF-* 静态断言守门，改动时必须同步。
   */
  var DEFAULTS = {
    nameRule: '[<发布者昵称>] <标题>_<序号>',
    timeFormat: 'YYYYMMDD',
    imageFormat: 'origin',
    videoQuality: 'origin',
    streamPreference: 'compat',
    liveMode: 'both',
    dirByAuthor: false,
    dirByTitle: false,
    baseDir: '小红书下载',
    hookEnabled: true,
    spaSource: true
  };

  var els = {};
  var note = null;
  var settings = null;

  function $(id) { return document.getElementById(id); }

  /**
   * 向当前标签页的内容脚本发消息。
   * msgType 必须由调用方显式传入 —— 早先这里把类型写死成 GET_NOTE，
   * 导致「下载本笔记全部」实际只是重新取了一次笔记数据，
   * DOWNLOAD_ALL 分支永远不会被触发（按钮点了不下载任何东西）。
   */
  function sendToTab(msgType, cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || tab.id == null) { if (cb) cb(null, null); return; }
      chrome.tabs.sendMessage(tab.id, { type: msgType }, function (resp) {
        // 内容脚本未注入（非小红书页面）时会走这里
        void chrome.runtime.lastError;
        if (cb) cb(resp || null, tab.id);
      });
    });
  }

  function show(id) {
    ['loading', 'unsupported', 'ready'].forEach(function (k) {
      els[k].hidden = (k !== id);
    });
  }

  function fmtCount(n) {
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + ' 万';
    return String(n);
  }

  function renderNote(n) {
    note = n;
    els.cover.src = n.cover || (n.images[0] && n.images[0].urlDefault) || '';
    els.cover.style.display = (n.cover || (n.images[0] && n.images[0].urlDefault)) ? '' : 'none';
    els.title.textContent = n.title || '（无标题）';

    var a = n.author || {};
    els.author.textContent = a.nickname ? '@' + a.nickname : '未知作者';

    var liveCount = n.images.filter(function (i) { return i.isLive; }).length;
    var parts = [];
    if (n.video) parts.push('视频 1');
    if (n.images.length) parts.push('图片 ' + n.images.length);
    if (liveCount) parts.push('实况 ' + liveCount);
    els.stats.textContent = parts.length ? parts.join(' · ') : '无可下载内容';

    show('ready');
    updateHint();
  }

  function updateHint() {
    if (!note || !settings) return;
    var total = note.images.length + (note.video ? 1 : 0);
    var liveExtra = (settings.liveMode !== 'image-only')
      ? note.images.filter(function (i) { return i.isLive && i.liveVideoUrl; }).length
      : 0;
    var files = total + liveExtra;
    els.btnAll.textContent = '下载本笔记全部（' + files + ' 个文件）';
    els.hint.textContent = liveExtra
      ? '实况照片会同时下载图片与配套短视频（_live 后缀）。可在设置中修改。'
      : '可在设置中调整画质、命名模板与实况处理方式。';
  }

  function boot() {
    els = {
      loading: $('loading'),
      unsupported: $('unsupported'),
      ready: $('ready'),
      cover: $('cover'),
      title: $('title'),
      author: $('author'),
      stats: $('stats'),
      btnAll: $('btnAll'),
      btnPanel: $('btnPanel'),
      hint: $('hint'),
      version: $('version'),
      btnOptions: $('btnOptions')
    };

    try {
      els.version.textContent = 'v' + chrome.runtime.getManifest().version;
    } catch (e) { /* 忽略 */ }

    chrome.storage.local.get('xhs_settings', function (r) {
      // 必须 merge DEFAULTS：用户从未打开过设置页时 storage 里没有 xhs_settings，
      // 只取原始对象会让每个设置项都变成 undefined，updateHint() 会据此算错文件数。
      settings = Object.assign({}, DEFAULTS, (r && r.xhs_settings) || {});
      updateHint();
    });

    sendToTab('GET_NOTE', function (resp) {
      if (resp && resp.ok && resp.note) {
        renderNote(resp.note);
      } else {
        show('unsupported');
      }
    });

    els.btnAll.addEventListener('click', function () {
      if (!note) return;
      els.btnAll.disabled = true;
      els.btnAll.textContent = '已提交下载…';
      sendToTab('DOWNLOAD_ALL', function (resp) {
        if (!resp || !resp.ok) {
          els.btnAll.disabled = false;
          els.btnAll.textContent = '下载失败，请在页面中重试';
          return;
        }
        window.close();
      });
    });

    els.btnPanel.addEventListener('click', function () {
      sendToTab('OPEN_PANEL', function () {
        window.close();
      });
    });

    els.btnOptions.addEventListener('click', function () {
      chrome.runtime.openOptionsPage();
      window.close();
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
