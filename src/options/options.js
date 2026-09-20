/**
 * 小红书下载助手 — 设置页
 * 所有改动即时写入 chrome.storage.local，内容脚本通过 onChanged 热更新，
 * 用户改完不需要刷新小红书页面。
 */
(function () {
  'use strict';

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
    // SPA 切换后自动重新取源（同源 fetch 重取 SSR HTML）。
    // 默认开启：用户的核心痛点就是"必须整页刷新才能取到源"，
    // 关掉默认值等于把修复藏着不让人用；真出问题由用户自行关闭即可。
    spaSource: true
  };

  /** 预览用的示例笔记，让用户直观看到命名效果 */
  var SAMPLE = {
    noteId: '65f1a2b3000000001203abcd',
    title: '周末去了趟莫干山，这家民宿真的绝了',
    desc: '',
    publishTime: 1711612800,
    ipLocation: '浙江',
    author: { nickname: '旅行的小鹿', userId: '5f2c1b', redId: 'lulu_trip' }
  };

  var els = {};
  var state = Object.assign({}, DEFAULTS);

  function $(id) { return document.getElementById(id); }

  function status(msg) {
    els.status.textContent = msg;
    if (!msg) return;
    clearTimeout(status._t);
    status._t = setTimeout(function () { els.status.textContent = ''; }, 2200);
  }

  /**
   * 文本框 input 事件每敲一个字符触发一次，若每次都写 storage，
   * 输入一段模板就会产生几十次写入。这里做 200ms 防抖，用户停手后才落盘。
   * 下拉框 / 复选框的 change 事件不防抖 —— 那些是「一次决策」，
   * 立即保存才能保证用户关掉页面时不丢设置。
   */
  var SAVE_DEBOUNCE_MS = 200;
  var saveTimer = null;

  function save() {
    // 立即保存时取消挂起的防抖，避免同一份 state 被写两次
    clearTimeout(saveTimer);
    saveTimer = null;
    chrome.storage.local.set({ xhs_settings: state }, function () {
      // storage 写入可能因配额 / 权限失败。不检查 lastError 就提示「已保存」
      // 会给用户假信号 —— 用户以为设置生效了，实际内容脚本读到的还是旧值。
      if (chrome.runtime.lastError) {
        status('保存失败：' + chrome.runtime.lastError.message);
        return;
      }
      status('已保存');
    });
  }

  function saveDebounced() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
  }

  /* --------------------------- 渲染 --------------------------- */

  function renderChips() {
    els.chips.innerHTML = '';
    XHS_DL_DOWNLOADER.PLACEHOLDERS.forEach(function (p) {
      var b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.textContent = '<' + p.key + '>';
      b.title = p.desc;
      b.addEventListener('click', function () {
        insertAtCursor(els.nameRule, '<' + p.key + '>');
        state.nameRule = els.nameRule.value;
        renderPreview();
        save();
      });
      els.chips.appendChild(b);
    });
  }

  /** 在光标处插入占位符，而不是粗暴地追加到末尾 */
  function insertAtCursor(input, text) {
    var start = input.selectionStart;
    var end = input.selectionEnd;
    var v = input.value;
    if (start == null) {
      input.value = v + text;
    } else {
      input.value = v.slice(0, start) + text + v.slice(end);
      input.selectionStart = input.selectionEnd = start + text.length;
    }
    input.focus();
  }

  function renderPreview() {
    var vars = {
      index: 1,
      noteId: SAMPLE.noteId,
      title: SAMPLE.title,
      publishTime: XHS_DL_DOWNLOADER.formatTime(SAMPLE.publishTime, state.timeFormat || 'YYYYMMDD'),
      ipLocation: SAMPLE.ipLocation,
      nickname: SAMPLE.author.nickname,
      redId: SAMPLE.author.redId,
      userId: SAMPLE.author.userId
    };
    var name = XHS_DL_DOWNLOADER.sanitize(
      XHS_DL_DOWNLOADER.renderName(state.nameRule, vars)
    );
    var dir = [];
    if (state.baseDir) dir.push(state.baseDir);
    if (state.dirByAuthor) dir.push(SAMPLE.author.nickname);
    if (state.dirByTitle) dir.push(SAMPLE.title.slice(0, 40));
    var path = (dir.length ? dir.join(' / ') + ' / ' : '') + name + '.jpg';
    els.preview.textContent = path;
  }

  function renderForm() {
    els.nameRule.value = state.nameRule || DEFAULTS.nameRule;
    els.timeFormat.value = state.timeFormat || DEFAULTS.timeFormat;
    els.baseDir.value = state.baseDir || '';
    els.dirByAuthor.checked = !!state.dirByAuthor;
    els.dirByTitle.checked = !!state.dirByTitle;
    els.hookEnabled.checked = state.hookEnabled !== false;
    els.spaSource.checked = state.spaSource !== false;

    ['imageFormat', 'videoQuality', 'streamPreference', 'liveMode'].forEach(function (group) {
      var inputs = document.querySelectorAll('input[name="' + group + '"]');
      for (var i = 0; i < inputs.length; i++) {
        inputs[i].checked = inputs[i].value === state[group];
      }
    });

    renderPreview();
  }

  /* --------------------------- 事件绑定 --------------------------- */

  function bind() {
    els.nameRule.addEventListener('input', function () {
      state.nameRule = els.nameRule.value;
      renderPreview();
      saveDebounced();
    });

    els.timeFormat.addEventListener('input', function () {
      state.timeFormat = els.timeFormat.value;
      renderPreview();
      saveDebounced();
    });

    els.baseDir.addEventListener('input', function () {
      state.baseDir = els.baseDir.value;
      renderPreview();
      saveDebounced();
    });

    els.dirByAuthor.addEventListener('change', function () {
      state.dirByAuthor = els.dirByAuthor.checked;
      renderPreview();
      save();
    });

    els.dirByTitle.addEventListener('change', function () {
      state.dirByTitle = els.dirByTitle.checked;
      renderPreview();
      save();
    });

    els.hookEnabled.addEventListener('change', function () {
      state.hookEnabled = els.hookEnabled.checked;
      save();
    });

    ['imageFormat', 'videoQuality', 'streamPreference', 'liveMode'].forEach(function (group) {
      var inputs = document.querySelectorAll('input[name="' + group + '"]');
      for (var i = 0; i < inputs.length; i++) {
        inputs[i].addEventListener('change', function () {
          if (!this.checked) return;
          state[group] = this.value;
          renderPreview();
          save();
        });
      }
    });

    els.btnReset.addEventListener('click', function () {
      state = Object.assign({}, DEFAULTS);
      renderForm();
      save();
      status('已恢复默认设置');
    });

    els.btnClear.addEventListener('click', function () {
      chrome.storage.session.remove('xhs_dl_done_urls', function () {
        if (chrome.runtime.lastError) {
          status('清空失败：' + chrome.runtime.lastError.message);
          return;
        }
        status('已清空去重记录，之前下载过的文件可重新下载');
      });
    });
  }

  /* --------------------------- 启动 --------------------------- */

  function boot() {
    els = {
      nameRule: $('nameRule'),
      timeFormat: $('timeFormat'),
      baseDir: $('baseDir'),
      dirByAuthor: $('dirByAuthor'),
      dirByTitle: $('dirByTitle'),
      hookEnabled: $('hookEnabled'),
      spaSource: $('spaSource'),
      chips: $('chips'),
      preview: $('preview'),
      btnReset: $('btnReset'),
      btnClear: $('btnClear'),
      status: $('status')
    };

    chrome.storage.local.get('xhs_settings', function (r) {
      state = Object.assign({}, DEFAULTS, (r && r.xhs_settings) || {});
      renderChips();
      renderForm();
      bind();
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
