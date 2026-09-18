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

  var els = {};
  var note = null;
  var settings = null;

  function $(id) { return document.getElementById(id); }

  function withActiveTab(fn) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || tab.id == null) { fn(null); return; }
      chrome.tabs.sendMessage(tab.id, { type: 'GET_NOTE' }, function (resp) {
        // 内容脚本未注入（非小红书页面）时会走这里
        void chrome.runtime.lastError;
        fn(resp || null, tab.id);
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
      settings = (r && r.xhs_settings) || {};
      updateHint();
    });

    withActiveTab(function (resp) {
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
      withActiveTab(function (resp, tabId) {
        if (!resp || !resp.ok) {
          els.btnAll.disabled = false;
          els.btnAll.textContent = '下载失败，请在页面中重试';
          return;
        }
        window.close();
      });
    });

    els.btnPanel.addEventListener('click', function () {
      withActiveTab(function (resp, tabId) {
        if (tabId != null) {
          chrome.tabs.sendMessage(tabId, { type: 'OPEN_PANEL' }, function () {
            void chrome.runtime.lastError;
          });
        }
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
