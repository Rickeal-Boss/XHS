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
    empty: '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.5-4.5L7 20"/></svg>',
    audio: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></svg>',
    video: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="14" height="14" rx="2"/><path d="m22 8-6 4 6 4z"/></svg>',
    refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>'
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
  /* 打开面板前的焦点元素：关闭时归还，键盘用户才不会被丢回文档开头。 */
  var lastFocus = null;

  /* 评论区媒体：独立分区、独立勾选。
     默认不勾选 —— 评论可能几十上百条，自动全选会把下载目录刷爆。 */
  var commentMedia = [];
  var commentSel = Object.create(null);

  function setCommentMedia(items) {
    commentMedia = items || [];
    // 保留已有勾选：新评论陆续到达时会多次调用本函数，
    // 早期实现每次都清空 commentSel，用户刚勾的会被冲掉。
    // 这里按 key 保留在新列表里依然存在的项。
    var prev = commentSel;
    commentSel = Object.create(null);
    commentItems().forEach(function (it) {
      if (prev[it.key]) commentSel[it.key] = 1;
    });
    render();
  }

  /** 展开成扁平条目：key 形如 c:<commentId>:i:<n>（图片）/ :a:<n>（语音） */
  function commentItems() {
    var out = [];
    for (var i = 0; i < commentMedia.length; i++) {
      var c = commentMedia[i];
      var j;
      for (j = 0; j < c.images.length; j++) {
        out.push({ key: 'c:' + c.commentId + ':i:' + j, kind: 'image', url: c.images[j], comment: c, seq: j });
      }
      for (j = 0; j < c.audios.length; j++) {
        out.push({ key: 'c:' + c.commentId + ':a:' + j, kind: 'audio', url: c.audios[j], comment: c, seq: j });
      }
    }
    return out;
  }

  function selectedCommentItems() {
    return commentItems().filter(function (it) { return !!commentSel[it.key]; });
  }

  function renderComments() {
    if (!commentMedia.length) return '';
    var items = commentItems();
    var selCount = selectedCommentItems().length;
    var h = [];
    h.push('<div class="xhs-dl-sec">');
    h.push('<div class="xhs-dl-sec-hd">');
    h.push('<label class="xhs-dl-sec-all"><input type="checkbox" data-act="cmt-all"' +
      (selCount === items.length && items.length ? ' checked' : '') +
      '><span>评论区（' + items.length + ' 项' + (selCount ? '，已选 ' + selCount : '') + '）</span></label>');
    h.push('</div><div class="xhs-dl-grid">');
    items.forEach(function (it) {
      var on = !!commentSel[it.key];
      var tag = it.kind === 'audio' ? '<span class="xhs-dl-tag is-audio">语音</span>' : '';
      var inner = it.kind === 'audio'
        ? '<div class="xhs-dl-ph is-audio">' + ICON.audio + '</div>'
        : '<img src="' + esc(it.url) + '" referrerpolicy="no-referrer" loading="lazy" alt="">';
      // 条目是裸 div，默认键盘不可达、屏幕阅读器也读不出「这是一张可选的图」。
      // 补 role/tabindex/aria-checked/aria-label 后语义完整；勾选态与 is-checked
      // 类同源，重新 render 时一并刷新，不会出现「视觉已勾、aria 未勾」。
      var label = it.kind === 'audio' ? '评论语音 ' + (it.seq + 1) : '评论图片 ' + (it.seq + 1);
      h.push('<div class="xhs-dl-item' + (on ? ' is-checked' : '') + '" data-ckey="' + esc(it.key) + '"' +
        ' role="checkbox" tabindex="0" aria-checked="' + (on ? 'true' : 'false') + '"' +
        ' aria-label="' + esc(label) + '">' +
        tag + '<span class="xhs-dl-tick">' + ICON.check + '</span>' + inner + '</div>');
    });
    h.push('</div></div>');
    return h.join('');
  }

  function toggleCommentKey(key) {
    if (commentSel[key]) delete commentSel[key];
    else commentSel[key] = 1;
    render();
  }

  function toggleCommentAll() {
    var items = commentItems();
    var allOn = items.length && selectedCommentItems().length === items.length;
    commentSel = Object.create(null);
    if (!allOn) items.forEach(function (it) { commentSel[it.key] = 1; });
    render();
  }

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
    // aria-modal 只作用于可访问性树（告知辅助技术这是模态层），与显隐无关：
    // 显隐仍由 .is-open 类驱动，绝不能用 hidden 属性（见 open/close 上方注释）。
    els.panel.setAttribute('aria-modal', 'true');
    // tabindex=-1 让容器可被脚本聚焦 —— 打开面板时把焦点移进来，屏幕阅读器
    // 才会播报对话框名称。它不进入 Tab 序列，因此不影响原有键盘路径。
    els.panel.setAttribute('tabindex', '-1');

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
      '  <button class="xhs-dl-src" type="button" data-act="src-refresh" hidden disabled></button>',
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
      '    <button class="xhs-dl-btn is-ghost" data-act="refresh" title="重新扫描页面（评论区是懒加载，滚到评论区后点这个）"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>刷新</button>',
      '  </div>',
      '  <div class="xhs-dl-progress"><div class="xhs-dl-bar"><i></i></div>',
      '    <div class="xhs-dl-progress-text"><span></span><span></span></div>',
      '    <button class="xhs-dl-cancel" data-act="cancel" type="button">取消</button></div>',
      '</div>'
    ].join('');

    els.meta = els.panel.querySelector('.xhs-dl-meta');
    els.srcBadge = els.panel.querySelector('button[data-act="src-refresh"]');
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
    els.cancelBtn = els.panel.querySelector('button[data-act="cancel"]');

    els.panel.addEventListener('click', onPanelClick);
    els.panel.addEventListener('keydown', onPanelKeydown);
    els.panel.addEventListener('change', function (e) {
      if (!e.target) return;
      var a = e.target.getAttribute('data-act');
      if (a === 'all') onCheckAllChange();
      else if (a === 'cmt-all') toggleCommentAll();
    });
    els.mask.addEventListener('click', close);
  }

  /** 勾选会整体重建 body 的 innerHTML，旧节点被销毁、焦点会掉回 body ——
      键盘用户按一次 Space 就「掉队」，得从头 Tab 回来。这里在重建后按
      data-ckey / data-idx 找回同一个条目并还原焦点。仅在键盘路径调用，
      鼠标点击不需要（也不该）把焦点抢到条目上。 */
  function refocusItem(attr, val) {
    if (!els.body || !els.body.querySelectorAll) return;
    var list = els.body.querySelectorAll('.xhs-dl-item');
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute(attr) === val) {
        if (typeof list[i].focus === 'function') list[i].focus();
        return;
      }
    }
  }

  /** 条目激活：点击与键盘（Enter/Space）共用同一套判定，行为不可能漂移。
      必须先判 data-ckey（评论区）再判 data-idx —— 否则 Number(null) 会退化成 0，
      点评论区任意一项都会错误地切换笔记第 1 张图的勾选。
      fromKeyboard 为真时在重建后还原焦点。
      返回 true 表示已处理（键盘路径据此决定是否 preventDefault）。 */
  function activateItem(target, fromKeyboard) {
    var citem = target && target.closest ? target.closest('[data-ckey]') : null;
    if (citem) {
      var ckey = citem.getAttribute('data-ckey');
      toggleCommentKey(ckey);
      if (fromKeyboard) refocusItem('data-ckey', ckey);
      return true;
    }

    // 媒体卡片：切换勾选（优先判断，卡片内部不含 data-act 元素）
    var item = target && target.closest ? target.closest('.xhs-dl-item') : null;
    if (item && item.getAttribute('data-idx') !== null) {
      var idx = item.getAttribute('data-idx');
      toggleIndex(Number(idx));
      if (fromKeyboard) refocusItem('data-idx', idx);
      return true;
    }
    return false;
  }

  /* 面板内可聚焦元素（供 Tab 循环使用）。过滤掉 disabled 与不可见项：
     隐藏的取源徽标 / 未启用的按钮若留在列表里，Tab 会把焦点送到
     不可见元素上，浏览器随即把焦点丢回 body —— 等于焦点逃出面板。 */
  var FOCUS_SEL = 'a[href],button:not([disabled]),input:not([disabled]),' +
    'select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  function focusables() {
    if (!els.panel || !els.panel.querySelectorAll) return [];
    var list = els.panel.querySelectorAll(FOCUS_SEL);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      // offsetParent 为 null 说明自身或祖先 display:none（含 [hidden]）。
      if (list[i].offsetParent === null) continue;
      out.push(list[i]);
    }
    return out;
  }

  /* 焦点陷阱：Tab / Shift+Tab 在面板内首尾循环。
     面板是注入宿主页面的浮层，不循环的话 Tab 会跑到页面正文里，键盘用户
     再也回不到面板。实现刻意保持最小：只在能算出可聚焦元素时才拦截，
     算不出来（列表为空，例如元素尚未布局）就完全交回浏览器默认行为，
     宁可漏掉循环也不把焦点锁死。 */
  function trapTab(ev) {
    var list = focusables();
    if (!list.length) return;
    var at = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i] === ev.target) { at = i; break; }
    }
    // at === -1：焦点在面板容器自身（tabindex=-1）或非可聚焦子节点上，
    // 此时正向落到第一个、反向落到最后一个，保证 Tab 不会直接出界。
    if (ev.shiftKey) {
      if (at === 0 || at === -1) { list[list.length - 1].focus(); ev.preventDefault(); }
    } else if (at === list.length - 1 || at === -1) {
      list[0].focus();
      ev.preventDefault();
    }
  }

  function onPanelKeydown(ev) {
    var key = ev.key;

    // Esc 关闭：bindGlobal 在 document 捕获阶段也有一份（用于焦点在面板外
    // 的兜底）。这里再判一次 isOpen()，避免同一次 Esc 触发两次 close()，
    // 把 handlers.onClose 重复调一遍。
    if (key === 'Escape') {
      if (isOpen()) close();
      return;
    }

    if (key === 'Tab') { trapTab(ev); return; }

    // 条目是 div，浏览器不会为它合成 click 事件；Enter / Space 需要手动映射到
    // 与点击完全相同的切换逻辑。Space 必须 preventDefault，否则会滚动页面。
    // 只在真的命中条目时才拦，按钮的 Enter/Space 原生行为不受影响。
    if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      if (activateItem(ev.target, true)) ev.preventDefault();
    }
  }

  function onPanelClick(ev) {
    var target = ev.target;

    // 0/1) 媒体卡片与评论条目：切换勾选（与键盘路径共用 activateItem）
    if (activateItem(target)) return;

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
    // 数据来源徽标（仅降级态可点）与底部「刷新」共用同一条重新取源链路
    else if (act === 'refresh' || act === 'src-refresh') { if (handlers.onRefresh) handlers.onRefresh(); }
    else if (act === 'cancel') { if (handlers.onCancel) handlers.onCancel(); }
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

  function isBusy() { return busy; }

  /** 记录打开面板前的焦点元素，供关闭时归还。
      焦点已在面板内部（重复 open）或落在 shadow 宿主上时不覆盖记录，
      否则会把记录冲成面板自身 / 宿主 div，关闭后焦点等于丢了。 */
  function rememberFocus() {
    var ae = document.activeElement;
    if (!ae || ae === els.panel) return;
    if (shadow && shadow.host && ae === shadow.host) return;
    if (els.panel.contains && els.panel.contains(ae)) return;
    lastFocus = ae;
  }

  /** 关闭时把焦点还给打开前的元素；元素已被宿主页面移除则放弃。 */
  function restoreFocus() {
    var t = lastFocus;
    lastFocus = null;
    if (!t || typeof t.focus !== 'function') return;
    // isConnected === false 说明该元素已经不在文档里，focus() 会静默失败
    // 并把焦点留在 body，不如直接放弃、让浏览器按默认规则处理。
    if (t.isConnected === false) return;
    t.focus();
  }

  function open() {
    els.panel.classList.add('is-open');
    els.mask.classList.add('is-open');
    // 焦点管理：先记住原焦点，再移入面板。不移焦的话键盘用户按 Enter
    // 打开面板后，焦点仍停在悬浮球上，屏幕阅读器不会知道面板出现了。
    rememberFocus();
    if (typeof els.panel.focus === 'function') els.panel.focus();
    // 每次打开都重置一次进度显示 —— 用户关闭面板后可能有上一次批次的
    // DL_ALL_DONE 早已把进度条推到 "0 / 33" 之类的状态，再开时会被误读为
    // "当前这批全部失败"。
    hideProgress();
    if (handlers.onOpen) handlers.onOpen();
  }

  function close() {
    var was = isOpen();
    els.panel.classList.remove('is-open');
    els.mask.classList.remove('is-open');
    // 只有真的从「打开」转到「关闭」才归还焦点：Esc 会被面板内与 document
    // 捕获两处监听各调一次 close()，若无条件归还，第二次会把焦点抢走。
    if (was) restoreFocus();
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
    // 保留勾选：只保留在新笔记里依然有效的 index —— 这样从 setNote 重扫时
    // 不会把用户之前勾选的状态清掉。新建/首次进入时 selected = []，
    // 下面的 if 会把整个索引加入。
    var all = allIndexes();
    var keep = {};
    selected.forEach(function (i) { if (all.indexOf(i) !== -1) keep[i] = 1; });
    var keptKeys = Object.keys(keep).map(Number);
    selected = keptKeys.length ? keptKeys : all;
    render();
  }

  function clearNote() {
    note = null;
    selected = [];
    commentMedia = [];
    commentSel = Object.create(null);
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
        '<div class="xhs-dl-item' + (checked ? ' is-checked' : '') + '" data-idx="-1"' +
        ' role="checkbox" tabindex="0" aria-checked="' + (checked ? 'true' : 'false') + '"' +
        ' aria-label="视频">' +
        '<span class="xhs-dl-tag">视频</span>' +
        '<span class="xhs-dl-tick">' + ICON.check + '</span>' +
        (note.video.cover
          ? '<img src="' + esc(note.video.cover) + '" referrerpolicy="no-referrer" loading="lazy" alt="">'
          : '<div class="xhs-dl-ph is-video">视频封面<br><span>缩略图未获取到</span></div>') +
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
      var label = (img.isLive ? '实况照片 ' : '图片 ') + (img.index + 1);
      html.push(
        '<div class="xhs-dl-item' + (checked ? ' is-checked' : '') + '" data-idx="' + img.index + '"' +
        ' role="checkbox" tabindex="0" aria-checked="' + (checked ? 'true' : 'false') + '"' +
        ' aria-label="' + esc(label) + '">' +
        tag +
        '<span class="xhs-dl-tick">' + ICON.check + '</span>' +
        (src
          ? '<img src="' + esc(src) + '" referrerpolicy="no-referrer" loading="lazy" alt="">'
          : '<div class="xhs-dl-ph">无图</div>') +
        '<span class="xhs-dl-idx">' + (img.index + 1) + '</span>' +
        '</div>'
      );
    });

    els.body.innerHTML = '<div class="xhs-dl-grid">' + html.join('') + '</div>' + renderComments();
  }

  /** 笔记勾选 + 评论区勾选的总数 */
  function totalSelected() {
    return selected.length + selectedCommentItems().length;
  }

  function renderFoot() {
    var has = !!note && (note.images.length > 0 || !!note.video);
    var n = totalSelected();
    els.dlBtn.disabled = busy || n === 0;
    els.dlBtn.textContent = busy
      ? '下载中…'
      : (n ? '下载选中（' + n + ' 项）' : '请先选择要下载的内容');
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

  /* 数据来源徽标：常驻在面板头部，显式告诉用户当前媒体是「取自源」
     还是「DOM 兜底降级」（降级只能拿到压缩图）。只有降级态可点击，
     点一下即走与底部「刷新」完全相同的重新取源链路。 */
  var SOURCE_BADGE = {
    source: { text: '源 · 原画质', mod: 'is-source' },
    soft: { text: '源 · 自动重取', mod: 'is-soft' },
    dom: { text: '降级 · DOM 提取', mod: 'is-dom', retry: '重新取源' }
  };

  /** @param {'source'|'soft'|'dom'|''} level 未知值一律按隐藏处理 */
  function setSourceBadge(level) {
    var b = els.srcBadge;
    if (!b) return;
    var conf = SOURCE_BADGE[level];
    if (!conf) {
      b.hidden = true;
      b.disabled = true;
      b.innerHTML = '';
      return;
    }
    b.hidden = false;
    // 非降级态用 disabled 关掉点击：disabled 按钮不派发 click，
    // 不必再在委托里判断状态。
    b.disabled = !conf.retry;
    b.className = 'xhs-dl-src ' + conf.mod;
    b.innerHTML = '<span class="xhs-dl-src-txt">' + esc(conf.text) + '</span>' +
      (conf.retry ? '<span class="xhs-dl-src-act">' + esc(conf.retry) + '</span>' : '');
  }

  /* --------------------------- 下载 --------------------------- */

  function doDownload() {
    if (busy || !note || !selected.length) return;
    if (handlers.onDownload) handlers.onDownload(note, selected.slice());
  }

  function setBusy(v) {
    busy = !!v;
    // 取消按钮只在下载进行中有意义，避免用户点了个没反应的按钮
    if (els.cancelBtn) els.cancelBtn.classList.toggle('is-on', busy);
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
    isBusy: isBusy,
    setCommentMedia: setCommentMedia,
    selectedCommentItems: selectedCommentItems,
    setProgress: setProgress,
    hideProgress: hideProgress,
    setBadge: setBadge,
    setBanner: setBanner,
    setSourceBadge: setSourceBadge,
    toast: toast
  };
})();
