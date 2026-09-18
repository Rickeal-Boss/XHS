/**
 * 小红书下载助手 — Shadow DOM UI 层
 * 悬浮球 + 侧滑面板 + Toast，全部封装在 Shadow Root 内。
 */
var XHS_DL_UI = (function () {
  'use strict';

  var ICON = {
    download: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/></svg>',
    close: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    gear: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    check: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12 5 5L20 6"/></svg>',
    empty: '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.5-4.5L7 20"/></svg>'
  };

  var shadow = null;
  var els = {};
  var handlers = {};
  var note = null;
  var settings = null;
  var selected = [];
  var busy = false;
  var pos = { left: null, top: null };
  var mediaHints = { videos: [] };

  /* --------------------------- 工具 --------------------------- */

  function el(tag, cls, html) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (html != null) d.innerHTML = html;
    return d;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function allIndexes() {
    if (!note) return [];
    var out = note.images.map(function (i) { return i.index; });
    if (note.video) out.unshift(-1);
    return out;
  }

  /* --------------------------- 挂载 --------------------------- */

  function mount(h) {
    handlers = h || {};
    if (shadow) return;

    var host = document.createElement('div');
    host.id = 'xhs-dl-host';
    host.style.cssText = 'all:initial;position:static;';
    shadow = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = XHS_DL_CSS;
    shadow.appendChild(style);

    var wrap = el('div', 'xhs-dl');

    /* 悬浮球 */
    els.ball = el('div', 'xhs-dl-ball', ICON.download + '<span class="xhs-dl-badge" hidden></span>');
    els.ball.setAttribute('role', 'button');
    els.ball.setAttribute('tabindex', '0');
    els.ball.title = '小红书下载助手';

    els.mask = el('div', 'xhs-dl-mask');

    els.panel = el('div', 'xhs-dl-panel');
    els.panel.setAttribute('role', 'dialog');
    els.panel.setAttribute('aria-label', '小红书下载助手');

    els.toasts = el('div', 'xhs-dl-toasts');

    wrap.appendChild(els.ball);
    wrap.appendChild(els.mask);
    wrap.appendChild(els.panel);
    wrap.appendChild(els.toasts);
    shadow.appendChild(wrap);

    document.documentElement.appendChild(host);

    buildPanel();
    bindBall();
    bindGlobal();
    applyPosition();
  }

  /* --------------------------- 面板骨架 --------------------------- */

  function buildPanel() {
    els.panel.innerHTML = [
      '<div class="xhs-dl-head">',
      '  <div class="xhs-dl-head-top">',
      '    <div class="xhs-dl-title">小红书下载助手</div>',
      '    <button class="xhs-dl-iconbtn" data-act="options" title="设置">' + ICON.gear + '</button>',
      '    <button class="xhs-dl-iconbtn" data-act="close" title="关闭 (Esc)">' + ICON.close + '</button>',
      '  </div>',
      '  <div class="xhs-dl-meta"></div>',
      '</div>',
      '<div class="xhs-dl-toolbar">',
      '  <label class="xhs-dl-check"><input type="checkbox" data-act="all"> 全选</label>',
      '  <span class="xhs-dl-spacer"></span>',
      '  <span class="xhs-dl-count">0 项</span>',
      '</div>',
      '<div class="xhs-dl-body"></div>',
      '<div class="xhs-dl-foot">',
      '  <button class="xhs-dl-btn" data-act="download" disabled>下载选中</button>',
      '  <div class="xhs-dl-btn-row">',
      '    <button class="xhs-dl-btn is-ghost" data-act="copy-links">复制全部直链</button>',
      '    <button class="xhs-dl-btn is-ghost" data-act="export-json">导出元数据</button>',
      '  </div>',
      '  <div class="xhs-dl-progress"><div class="xhs-dl-bar"><i></i></div>',
      '    <div class="xhs-dl-progress-text"><span></span><span></span></div></div>',
      '</div>'
    ].join('');

    els.meta = els.panel.querySelector('.xhs-dl-meta');
    els.body = els.panel.querySelector('.xhs-dl-body');
    els.count = els.panel.querySelector('.xhs-dl-count');
    els.checkAll = els.panel.querySelector('input[data-act="all"]');
    els.dlBtn = els.panel.querySelector('button[data-act="download"]');
    els.progress = els.panel.querySelector('.xhs-dl-progress');
    els.bar = els.panel.querySelector('.xhs-dl-bar > i');
    els.progName = els.panel.querySelector('.xhs-dl-progress-text span:first-child');
    els.progNum = els.panel.querySelector('.xhs-dl-progress-text span:last-child');
    els.copyBtn = els.panel.querySelector('button[data-act="copy-links"]');
    els.jsonBtn = els.panel.querySelector('button[data-act="export-json"]');

    els.panel.addEventListener('click', onPanelClick);
    els.panel.addEventListener('change', function (e) {
      if (e.target && e.target.getAttribute('data-act') === 'all') onCheckAllChange();
    });
    els.mask.addEventListener('click', close);
  }

  function onPanelClick(ev) {
    var target = ev.target;

    // 1) 媒体卡片：切换勾选（优先判断，卡片内部不含 data-act 元素）
    var item = target.closest ? target.closest('.xhs-dl-item') : null;
    if (item) {
      toggleIndex(Number(item.getAttribute('data-idx')));
      return;
    }

    // 2) 具名动作按钮
    var btn = target.closest ? target.closest('[data-act]') : null;
    if (!btn) return;
    var act = btn.getAttribute('data-act');

    if (act === 'close') close();
    else if (act === 'options') { if (handlers.onOptions) handlers.onOptions(); }
    else if (act === 'download') doDownload();
    else if (act === 'rescan') { if (handlers.onRescan) handlers.onRescan(); }
    else if (act === 'copy-links') { if (handlers.onCopyLinks) handlers.onCopyLinks(note, selected.slice()); }
    else if (act === 'export-json') { if (handlers.onExportJson) handlers.onExportJson(note); }
    // act === 'all' 交给 change 事件处理
  }

  function onCheckAllChange() {
    if (!note) return;
    if (els.checkAll.checked) selected = allIndexes();
    else selected = [];
    render();
  }

  /* --------------------------- 悬浮球交互 --------------------------- */

  function bindBall() {
    var dragging = false;
    var moved = false;
    var start = { x: 0, y: 0, left: 0, top: 0 };

    els.ball.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      var r = els.ball.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      els.ball.classList.add('is-dragging');
      try { els.ball.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    });

    els.ball.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - start.x;
      var dy = e.clientY - start.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      var w = els.ball.offsetWidth;
      var h = els.ball.offsetHeight;
      var left = Math.min(Math.max(start.left + dx, 4), window.innerWidth - w - 4);
      var top = Math.min(Math.max(start.top + dy, 4), window.innerHeight - h - 4);
      els.ball.style.left = left + 'px';
      els.ball.style.top = top + 'px';
      els.ball.style.right = 'auto';
      els.ball.style.bottom = 'auto';
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      els.ball.classList.remove('is-dragging');
      try { els.ball.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      if (moved) {
        var r = els.ball.getBoundingClientRect();
        pos = { left: Math.round(r.left), top: Math.round(r.top) };
        if (handlers.onPositionChange) handlers.onPositionChange(pos);
      } else {
        toggle();
      }
    }
    els.ball.addEventListener('pointerup', endDrag);
    els.ball.addEventListener('pointercancel', endDrag);

    els.ball.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  }

  function applyPosition() {
    if (pos.left == null || pos.top == null) {
      els.ball.style.right = '24px';
      els.ball.style.bottom = '96px';
    } else {
      els.ball.style.left = pos.left + 'px';
      els.ball.style.top = pos.top + 'px';
    }
  }

  function bindGlobal() {
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) close();
    }, true);
    window.addEventListener('resize', function () {
      if (pos.left == null) return;
      var w = els.ball.offsetWidth;
      var h = els.ball.offsetHeight;
      var left = Math.min(pos.left, window.innerWidth - w - 4);
      var top = Math.min(pos.top, window.innerHeight - h - 4);
      els.ball.style.left = Math.max(4, left) + 'px';
      els.ball.style.top = Math.max(4, top) + 'px';
    });
  }

  /* --------------------------- 开 / 关 --------------------------- */
  /* 注意：显隐必须走 .is-open 类，不能用 hidden 属性。
     本组件对 .xhs-dl-panel 声明了 display，会覆盖 UA 的
     [hidden]{display:none}，导致 hidden 完全失效、面板永远打不开。 */

  function isOpen() {
    return !!(els.panel && els.panel.classList.contains('is-open'));
  }

  function open() {
    els.panel.classList.add('is-open');
    els.mask.classList.add('is-open');
    if (handlers.onOpen) handlers.onOpen();
  }

  function close() {
    els.panel.classList.remove('is-open');
    els.mask.classList.remove('is-open');
    if (handlers.onClose) handlers.onClose();
  }

  function toggle() {
    if (isOpen()) close(); else open();
  }

  /* --------------------------- 渲染 --------------------------- */

  function setSettings(s) { settings = s; }

  function setMediaHints(h) { mediaHints = h || { videos: [] }; }

  function setNote(n) {
    note = n;
    selected = allIndexes();
    render();
  }

  function clearNote() {
    note = null;
    selected = [];
    render();
  }

  function toggleIndex(idx) {
    var at = selected.indexOf(idx);
    if (at === -1) selected.push(idx); else selected.splice(at, 1);
    render();
  }

  function render() {
    if (!shadow) return;
    renderMeta();
    renderBody();
    renderToolbar();
    renderFoot();
  }

  function renderMeta() {
    if (!note) {
      els.meta.innerHTML = '<span>未识别到笔记</span>';
      return;
    }
    var a = note.author || {};
    var bits = [];
    if (a.nickname) bits.push('<span class="xhs-dl-meta-name">' + esc(a.nickname) + '</span>');
    if (note.publishTime) {
      bits.push('<span class="xhs-dl-meta-dot">·</span><span>' +
        esc(XHS_DL_DOWNLOADER.formatTime(note.publishTime, 'YYYY-MM-DD')) + '</span>');
    }
    if (note.ipLocation) {
      bits.push('<span class="xhs-dl-meta-dot">·</span><span>' + esc(note.ipLocation) + '</span>');
    }
    els.meta.innerHTML = (a.avatar
      ? '<img class="xhs-dl-avatar" src="' + esc(a.avatar) + '" referrerpolicy="no-referrer" alt="">'
      : '') + bits.join('');
  }

  function renderToolbar() {
    var total = allIndexes().length;
    els.count.textContent = selected.length + ' / ' + total + ' 项';
    els.checkAll.checked = total > 0 && selected.length === total;
    els.checkAll.indeterminate = selected.length > 0 && selected.length < total;
  }

  function renderBody() {
    if (!note) {
      els.body.innerHTML = '<div class="xhs-dl-empty">' + ICON.empty +
        '<p>未识别到当前笔记</p>' +
        '<p class="xhs-dl-hint">请打开一篇笔记详情页后重试</p>' +
        '<p style="margin-top:12px"><button class="xhs-dl-btn is-ghost" data-act="rescan" style="width:auto;padding:0 16px;display:inline-flex">重新扫描</button></p>' +
        '</div>';
      return;
    }

    var html = [];

    if (note.video) {
      var checked = selected.indexOf(-1) !== -1;
      html.push(
        '<div class="xhs-dl-item' + (checked ? ' is-checked' : '') + '" data-idx="-1">' +
        '<span class="xhs-dl-tag">视频</span>' +
        '<span class="xhs-dl-tick">' + ICON.check + '</span>' +
        (note.video.cover
          ? '<img src="' + esc(note.video.cover) + '" referrerpolicy="no-referrer" loading="lazy" alt="">'
          : '<div class="xhs-dl-ph">视频</div>') +
        '</div>'
      );
    }

    if (!note.images.length && !note.video) {
      els.body.innerHTML = '<div class="xhs-dl-empty">' + ICON.empty +
        '<p>这条笔记没有可下载的媒体</p>' +
        '<p style="margin-top:12px"><button class="xhs-dl-btn is-ghost" data-act="rescan" style="width:auto;padding:0 16px;display:inline-flex">重新扫描</button></p>' +
        '</div>';
      return;
    }

    note.images.forEach(function (img) {
      var checked = selected.indexOf(img.index) !== -1;
      var tag = img.isLive ? '<span class="xhs-dl-tag is-live">实况</span>' : '';
      var src = img.urlDefault || '';
      html.push(
        '<div class="xhs-dl-item' + (checked ? ' is-checked' : '') + '" data-idx="' + img.index + '">' +
        tag +
        '<span class="xhs-dl-tick">' + ICON.check + '</span>' +
        (src
          ? '<img src="' + esc(src) + '" referrerpolicy="no-referrer" loading="lazy" alt="">'
          : '<div class="xhs-dl-ph">无图</div>') +
        '<span class="xhs-dl-idx">' + (img.index + 1) + '</span>' +
        '</div>'
      );
    });

    els.body.innerHTML = '<div class="xhs-dl-grid">' + html.join('') + '</div>';
  }

  function renderFoot() {
    var has = !!note && (note.images.length > 0 || !!note.video);
    els.dlBtn.disabled = busy || selected.length === 0;
    els.dlBtn.textContent = busy
      ? '下载中…'
      : (selected.length ? '下载选中（' + selected.length + ' 项）' : '请先选择要下载的内容');
    if (els.copyBtn) els.copyBtn.disabled = !has;
    if (els.jsonBtn) els.jsonBtn.disabled = !has;
  }

  /** 顶部提示条：用于告知「已自动停用网络监听」等降级状态 */
  function setBanner(msg, type) {
    if (!els.body) return;
    var old = els.body.parentNode.querySelector('.xhs-dl-banner');
    if (old) old.remove();
    if (!msg) return;
    var b = el('div', 'xhs-dl-banner is-' + (type || 'info'), esc(msg));
    els.body.parentNode.insertBefore(b, els.body);
  }

  /* --------------------------- 下载 --------------------------- */

  function doDownload() {
    if (busy || !note || !selected.length) return;
    if (handlers.onDownload) handlers.onDownload(note, selected.slice());
  }

  function setBusy(v) {
    busy = !!v;
    renderFoot();
  }

  function setProgress(done, total, current) {
    if (!total) { els.progress.classList.remove('is-on'); return; }
    els.progress.classList.add('is-on');
    els.bar.style.width = Math.round((done / total) * 100) + '%';
    els.progName.textContent = current || '';
    els.progNum.textContent = done + ' / ' + total;
  }

  function hideProgress() {
    els.progress.classList.remove('is-on');
    els.bar.style.width = '0';
    els.progName.textContent = '';
    els.progNum.textContent = '';
  }

  /* --------------------------- Toast --------------------------- */

  function toast(msg, type) {
    if (!shadow) return;
    var t = el('div', 'xhs-dl-toast' + (type ? ' is-' + type : ''), esc(msg));
    els.toasts.appendChild(t);
    setTimeout(function () {
      t.style.transition = 'opacity .2s ease';
      t.style.opacity = '0';
      setTimeout(function () { t.remove(); }, 220);
    }, 2600);
  }

  function setBadge(n) {
    var b = els.ball.querySelector('.xhs-dl-badge');
    if (!b) return;
    if (n > 0) { b.textContent = String(n); b.hidden = false; }
    else { b.hidden = true; }
  }

  return {
    mount: mount,
    open: open,
    close: close,
    toggle: toggle,
    isOpen: isOpen,
    setNote: setNote,
    clearNote: clearNote,
    setSettings: setSettings,
    setMediaHints: setMediaHints,
    setPosition: function (p) { if (p) { pos = p; applyPosition(); } },
    setBusy: setBusy,
    setProgress: setProgress,
    hideProgress: hideProgress,
    setBadge: setBadge,
    setBanner: setBanner,
    toast: toast
  };
})();
