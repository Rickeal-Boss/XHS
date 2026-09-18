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
    hookEnabled: true
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

  function save() {
    chrome.storage.local.set({ xhs_settings: state }, function () {
      status('已保存');
    });
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
      save();
    });

    els.timeFormat.addEventListener('input', function () {
      state.timeFormat = els.timeFormat.value;
      renderPreview();
      save();
    });

    els.baseDir.addEventListener('input', function () {
      state.baseDir = els.baseDir.value;
      renderPreview();
      save();
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
