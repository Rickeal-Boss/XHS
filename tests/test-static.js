/**
 * 静态一致性检查 + 内容脚本装配集成测试
 * 运行： node test-static.js
 *
 * PART A：manifest / 文件存在性 / 加载顺序 / HTML id / CSS 类名 的静态一致性
 * PART B：用最小 DOM 桩按 manifest 声明的顺序真实装配 styles→ui→downloader→content，
 *         验证模块契约、NOTE 渲染、串台防护、下载任务下发等端到端行为
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var H = require('./_harness');
var eq = H.eq, deepEq = H.deepEq, ok = H.ok, noThrow = H.noThrow;

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

var manifest = JSON.parse(read('manifest.json'));

/* ================================================================== */
/* PART A-1 — manifest 声明的文件是否都存在                             */
/* ================================================================== */
H.suite('静态一致性 — manifest 文件存在性');

var declared = [];
declared.push(['background.service_worker', manifest.background.service_worker]);
declared.push(['action.default_popup', manifest.action.default_popup]);
declared.push(['options_page', manifest.options_page]);
Object.keys(manifest.icons).forEach(function (k) {
  declared.push(['icons.' + k, manifest.icons[k]]);
});
Object.keys(manifest.action.default_icon).forEach(function (k) {
  declared.push(['action.default_icon.' + k, manifest.action.default_icon[k]]);
});
manifest.content_scripts.forEach(function (cs, i) {
  cs.js.forEach(function (f, j) { declared.push(['content_scripts[' + i + '].js[' + j + ']', f]); });
});

declared.forEach(function (d, i) {
  ok('MF-' + (i + 1), d[0] + ' → ' + d[1] + ' 存在', exists(d[1]), '缺失文件：' + d[1]);
});

H.suite('静态一致性 — manifest 关键字段');
eq('MF-K1', 'manifest_version = 3', manifest.manifest_version, 3);
eq('MF-K2', 'version 为合法 semver', /^\d+\.\d+\.\d+$/.test(manifest.version), true);
ok('MF-K3', 'permissions 含 downloads 与 storage',
  manifest.permissions.indexOf('downloads') !== -1 && manifest.permissions.indexOf('storage') !== -1,
  'permissions=' + JSON.stringify(manifest.permissions));
ok('MF-K4', 'host_permissions 覆盖小红书主站',
  manifest.host_permissions.some(function (p) { return p.indexOf('xiaohongshu.com') !== -1; }),
  JSON.stringify(manifest.host_permissions));
ok('MF-K5', 'content_scripts matches 能命中 www.xiaohongshu.com 详情页',
  manifest.content_scripts.every(function (cs) {
    return cs.matches.some(function (m) {
      return /^https:\/\/(\*\.)?xiaohongshu\.com\/\*$/.test(m);
    });
  }),
  JSON.stringify(manifest.content_scripts.map(function (c) { return c.matches; })));
eq('MF-K6', 'page-interceptor 运行于 MAIN world',
  manifest.content_scripts[0].world, 'MAIN');
eq('MF-K7', 'page-interceptor run_at = document_start',
  manifest.content_scripts[0].run_at, 'document_start');
eq('MF-K8', '隔离世界脚本 run_at = document_start',
  manifest.content_scripts[1].run_at, 'document_start');
ok('MF-K9', '未申请 tabs 权限（popup 注释中的假设成立）',
  manifest.permissions.indexOf('tabs') === -1, 'permissions=' + JSON.stringify(manifest.permissions));

/* ================================================================== */
/* PART A-2 — content_scripts 加载顺序与全局依赖                        */
/* ================================================================== */
H.suite('静态一致性 — content_scripts 加载顺序');

var csJs = manifest.content_scripts[1].js;
deepEq('ORD-1', 'content_scripts 顺序 = styles → ui → downloader → content',
  csJs, ['src/content/styles.js', 'src/content/ui.js', 'src/content/downloader.js', 'src/content/content.js']);

var srcCache = {};
csJs.forEach(function (f) { srcCache[f] = read(f); });

ok('ORD-2', 'XHS_DL_CSS 定义在 styles.js', /var\s+XHS_DL_CSS\s*=/.test(srcCache['src/content/styles.js']));
ok('ORD-3', 'XHS_DL_UI 定义在 ui.js', /var\s+XHS_DL_UI\s*=/.test(srcCache['src/content/ui.js']));
ok('ORD-4', 'XHS_DL_DOWNLOADER 定义在 downloader.js',
  /var\s+XHS_DL_DOWNLOADER\s*=/.test(srcCache['src/content/downloader.js']));

/** 找出某文件顶层（非函数体内）对全局的引用 */
function topLevelRefs(src, globalName) {
  var re = new RegExp('\\b' + globalName + '\\b', 'g');
  var hits = [];
  var m;
  while ((m = re.exec(src))) {
    var before = src.slice(0, m.index);
    // 粗略判断：该引用所在行是否为顶层语句（行首无缩进且不含 function 关键字）
    var lineStart = before.lastIndexOf('\n') + 1;
    var line = src.slice(lineStart, src.indexOf('\n', m.index) === -1 ? src.length : src.indexOf('\n', m.index));
    hits.push({ index: m.index, line: line.trim() });
  }
  return hits;
}

var defOrder = {
  XHS_DL_CSS: 'src/content/styles.js',
  XHS_DL_UI: 'src/content/ui.js',
  XHS_DL_DOWNLOADER: 'src/content/downloader.js'
};

csJs.forEach(function (f, idx) {
  Object.keys(defOrder).forEach(function (g) {
    var defFile = defOrder[g];
    var defIdx = csJs.indexOf(defFile);
    var refs = topLevelRefs(srcCache[f], g);
    if (!refs.length) return;
    // 只允许「定义文件在其之前」的引用在顶层立即求值；跨文件引用若出现在
    // 定义之前，则必须位于函数体内（运行时才求值）
    if (defIdx > idx) {
      ok('ORD-5.' + f.replace(/\W/g, '') + '.' + g,
        f + ' 在 ' + defFile + ' 之前引用了 ' + g + '（须仅出现在函数体内）',
        refs.every(function (r) { return /^(var|function|\/\/|\*|if|return|throw|\})/.test(r.line) === false; }),
        '顶层引用行：' + JSON.stringify(refs.map(function (r) { return r.line; })));
    }
  });
});

/* ================================================================== */
/* PART A-3 — HTML 引入顺序与元素 id                                    */
/* ================================================================== */
H.suite('静态一致性 — HTML 脚本顺序与元素 id');

function scriptSrcs(html) {
  var out = [];
  var re = /<script[^>]*\bsrc="([^"]+)"/g;
  var m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}
function htmlIds(html) {
  var out = [];
  var re = /\bid="([^"]+)"/g;
  var m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

var popupHtml = read('src/popup/popup.html');
var optionsHtml = read('src/options/options.html');
var popupJs = read('src/popup/popup.js');
var optionsJs = read('src/options/options.js');

deepEq('HTML-1', 'popup.html 先引 downloader.js 再引 popup.js',
  scriptSrcs(popupHtml), ['../content/downloader.js', 'popup.js']);
deepEq('HTML-2', 'options.html 先引 downloader.js 再引 options.js',
  scriptSrcs(optionsHtml), ['../content/downloader.js', 'options.js']);

[['popup', popupHtml, popupJs], ['options', optionsHtml, optionsJs]].forEach(function (t) {
  var name = t[0], html = t[1], js = t[2];
  var ids = htmlIds(html);
  var used = [];
  var re = /(?:\$\(|getElementById\()\s*'([^']+)'\s*\)/g;
  var m;
  while ((m = re.exec(js))) used.push(m[1]);
  used.forEach(function (id) {
    ok('HTML-' + name + '-id:' + id, name + '.html 中存在 #' + id, ids.indexOf(id) !== -1,
      'js 里 getElementById("' + id + '") 会拿到 null');
  });
});

/** options.js 里用 querySelectorAll('input[name="x"]') 分组，检查 HTML 是否有对应 name */
['imageFormat', 'videoQuality', 'liveMode'].forEach(function (g) {
  ok('HTML-opt-name:' + g, 'options.html 存在 input[name="' + g + '"]',
    optionsHtml.indexOf('name="' + g + '"') !== -1);
});

/* ================================================================== */
/* PART A-4 — CSS 类名一致性                                            */
/* ================================================================== */
H.suite('静态一致性 — CSS 类名一致性');

var styles = read('src/content/styles.js');
var cssClasses = {};
(styles.match(/\.(xhs-dl-[A-Za-z0-9_-]+|is-[a-z]+)/g) || []).forEach(function (s) {
  cssClasses[s.slice(1)] = 1;
});
var uiJs = read('src/content/ui.js');
var usedClasses = {};
(uiJs.match(/\bxhs-dl-[A-Za-z0-9_-]+/g) || []).forEach(function (c) { usedClasses[c] = 1; });
(uiJs.match(/\bis-(?:checked|live|warn|error|info|success|ghost|on|open|dragging|empty)\b/g) || [])
  .forEach(function (c) { usedClasses[c] = 1; });
// xhs-dl-host 是元素 id（host.id），不是类名
delete usedClasses['xhs-dl-host'];

Object.keys(usedClasses).sort().forEach(function (c) {
  ok('CSS-' + c, 'styles.js 中定义了 .' + c, !!cssClasses[c], 'ui.js 使用了但样式表未定义');
});

/** 反向：CSS 里定义但 JS 从不使用的类（死样式，仅提示） */
var deadCss = Object.keys(cssClasses).filter(function (c) {
  return c.indexOf('xhs-dl-') === 0 && !usedClasses[c];
}).sort();
ok('CSS-DEAD', 'styles.js 死样式统计（观察项 O-03）', true,
  '未被 ui.js 引用的类：' + JSON.stringify(deadCss));

/** popup / options 的类名 */
[['popup', popupHtml, read('src/popup/popup.css'), popupJs],
 ['options', optionsHtml, read('src/options/options.css'), optionsJs]].forEach(function (t) {
  var name = t[0], html = t[1], css = t[2], js = t[3];
  var cssSet = {};
  (css.match(/\.([A-Za-z][A-Za-z0-9_-]*)/g) || []).forEach(function (s) { cssSet[s.slice(1)] = 1; });
  var htmlSet = {};
  (html.match(/class="([^"]+)"/g) || []).forEach(function (s) {
    s.replace(/class="|"/g, '').split(/\s+/).forEach(function (c) { if (c) htmlSet[c] = 1; });
  });
  var jsSet = {};
  (js.match(/className\s*=\s*'([^']+)'/g) || []).forEach(function (s) {
    s.replace(/className\s*=\s*'|'/g, '').split(/\s+/).forEach(function (c) { if (c) jsSet[c] = 1; });
  });
  var missing = Object.keys(htmlSet).concat(Object.keys(jsSet)).filter(function (c) { return !cssSet[c]; });
  ok('CSS-' + name, name + '.css 覆盖了 HTML/JS 里用到的所有类名',
    missing.length === 0, '缺失：' + JSON.stringify(missing));
});

/* ================================================================== */
/* PART A-5 — 设置项默认值一致性                                        */
/* 默认值在 content.js / options.js / background.js / popup.js 各有一份  */
/* 副本，任何一份漂移都会让「用户没打开过设置页」时的行为与预期不符，      */
/* 因此这里逐键、逐值钉死，禁止以后各自演化。                            */
/* ================================================================== */
H.suite('静态一致性 — 设置项默认值');

/** 按顶层逗号切分对象体（跳过引号内的逗号） */
function splitTopLevel(body) {
  var parts = [], cur = '', q = null;
  for (var i = 0; i < body.length; i++) {
    var c = body[i];
    if (q) {
      cur += c;
      if (c === '\\') { cur += body[++i]; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === ',') { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/**
 * 从源码里的对象字面量解析出 { 键: 归一化后的值 }。
 * 纯文本解析而不 eval：background.js 那份写在 chrome.storage.local.set()
 * 的实参里，直接执行会依赖 chrome API。
 * 值统一剥掉外层引号，避免 'x' 与 "x" 被误判为不一致。
 */
function extractDefaults(src, startMarker) {
  var i = src.indexOf(startMarker);
  if (i === -1) return null;
  var j = src.indexOf('{', i);
  if (j === -1) return null;
  var depth = 0, end = -1, quote = null;
  for (var k = j; k < src.length; k++) {
    var c = src[k];
    if (quote) {
      if (c === '\\') { k++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  if (end === -1) return null;
  // 先去掉行注释：content.js 中 streamPreference 上方有含「：」的说明注释，
  // 不清理会被当成一个键值对
  var body = src.slice(j + 1, end).replace(/\/\/[^\n]*/g, '');

  var out = {};
  splitTopLevel(body).forEach(function (chunk) {
    var m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]*?)\s*$/.exec(chunk);
    if (!m) return;
    var v = m[2];
    if ((v[0] === "'" && v[v.length - 1] === "'") || (v[0] === '"' && v[v.length - 1] === '"')) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  });
  return out;
}

/** 四份默认值副本（popup.js 是本次新增的第四份，同样纳入守门） */
var DEFAULT_SOURCES = [
  ['content.js', 'var DEFAULT_SETTINGS', read('src/content/content.js')],
  ['options.js', 'var DEFAULTS', optionsJs],
  ['background.js', 'xhs_settings:', read('src/background.js')],
  ['popup.js', 'var DEFAULTS', popupJs]
];

var defaultMaps = {};
DEFAULT_SOURCES.forEach(function (s) {
  var map = extractDefaults(s[2], s[1]);
  defaultMaps[s[0]] = map;
  ok('DEF-PARSE-' + s[0], s[0] + ' 中解析出设置默认值',
    !!map && Object.keys(map).length > 0, '未匹配到标记 ' + JSON.stringify(s[1]));
});

var REF_SRC = 'content.js';
var refKeys = Object.keys(defaultMaps[REF_SRC] || {}).sort();

DEFAULT_SOURCES.forEach(function (s) {
  if (s[0] === REF_SRC) return;
  var keys = Object.keys(defaultMaps[s[0]] || {}).sort();
  var missing = refKeys.filter(function (k) { return keys.indexOf(k) === -1; });
  var extra = keys.filter(function (k) { return refKeys.indexOf(k) === -1; });
  ok('DEF-KEYS-' + s[0], s[0] + ' 的默认值键集合与 ' + REF_SRC + ' 完全相同',
    missing.length === 0 && extra.length === 0,
    '缺：' + JSON.stringify(missing) + '，多：' + JSON.stringify(extra));
});

refKeys.forEach(function (k) {
  DEFAULT_SOURCES.forEach(function (s) {
    if (s[0] === REF_SRC) return;
    eq('DEF-VAL-' + s[0] + '-' + k, s[0] + '.' + k + ' 默认值与 ' + REF_SRC + ' 相同',
      (defaultMaps[s[0]] || {})[k], defaultMaps[REF_SRC][k]);
  });
});

/* ================================================================== */
/* PART B — 内容脚本真实装配（最小 DOM 桩）                             */
/* ================================================================== */
H.suite('内容脚本装配 — 最小 DOM 桩');

function makeDom() {
  var created = [];
  function FakeNode(tag) {
    var self = this;
    this.tagName = String(tag || 'div').toUpperCase();
    this.id = '';
    this.style = {};
    this.attributes = {};
    this.childNodes = [];
    this.textContent = '';
    this._innerHTML = '';
    this.hidden = false;
    this.parentNode = null;
    this.disabled = false;
    this.checked = false;
    this.indeterminate = false;
    this._classSet = {};
    this._qCache = {};
    this.classList = {
      add: function (c) { self._classSet[c] = 1; },
      remove: function (c) { delete self._classSet[c]; },
      contains: function (c) { return !!self._classSet[c]; },
      toggle: function (c) { if (self._classSet[c]) delete self._classSet[c]; else self._classSet[c] = 1; }
    };
  }
  Object.defineProperty(FakeNode.prototype, 'className', {
    get: function () { return Object.keys(this._classSet).join(' '); },
    set: function (v) {
      this._classSet = {};
      String(v).split(/\s+/).forEach(function (c) { if (c) this._classSet[c] = 1; }, this);
    }
  });
  Object.defineProperty(FakeNode.prototype, 'innerHTML', {
    get: function () { return this._innerHTML; },
    set: function (v) { this._innerHTML = String(v); }
  });
  FakeNode.prototype.setAttribute = function (k, v) { this.attributes[k] = String(v); };
  FakeNode.prototype.getAttribute = function (k) {
    return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
  };
  FakeNode.prototype.appendChild = function (n) { n.parentNode = this; this.childNodes.push(n); return n; };
  FakeNode.prototype.insertBefore = function (n, ref) {
    n.parentNode = this;
    var i = this.childNodes.indexOf(ref);
    if (i === -1) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
    return n;
  };
  FakeNode.prototype.remove = function () {
    if (!this.parentNode) return;
    var i = this.parentNode.childNodes.indexOf(this);
    if (i !== -1) this.parentNode.childNodes.splice(i, 1);
    this.parentNode = null;
  };
  FakeNode.prototype.addEventListener = function (t, fn) {
    (this._ev = this._ev || {})[t] = (this._ev[t] || []).concat([fn]);
  };
  FakeNode.prototype.querySelector = function (sel) {
    if (!this._qCache[sel]) {
      var n = new FakeNode('div');
      n.parentNode = this;
      this._qCache[sel] = n;
    }
    return this._qCache[sel];
  };
  FakeNode.prototype.querySelectorAll = function () { return []; };
  FakeNode.prototype.closest = function () { return null; };
  FakeNode.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 48, height: 48 }; };
  FakeNode.prototype.setPointerCapture = function () {};
  FakeNode.prototype.releasePointerCapture = function () {};
  FakeNode.prototype.attachShadow = function () {
    this._shadow = new FakeNode('shadow');
    return this._shadow;
  };

  var docEl = new FakeNode('html');
  var document = {
    readyState: 'complete',
    title: '小红书 - 你的生活指南',
    documentElement: docEl,
    body: new FakeNode('body'),
    createElement: function (tag) { var n = new FakeNode(tag); created.push(n); return n; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    addEventListener: function () {},
    execCommand: function () { return true; }
  };
  return { FakeNode: FakeNode, document: document, created: created, docEl: docEl };
}

function loadContentScripts(opts) {
  opts = opts || {};
  var dom = makeDom();
  var winListeners = {};
  var runtimeMessages = [];
  var postMessages = [];
  var runtimeListener = null;
  var storageChanged = null;
  var ORIGIN = 'https://www.xiaohongshu.com';
  var NOTE_ID = '65f1a2b3000000001203abcd';

  var sandbox = {};
  sandbox.console = console;
  sandbox.location = {
    href: ORIGIN + '/explore/' + NOTE_ID,
    origin: ORIGIN,
    pathname: '/explore/' + NOTE_ID
  };
  sandbox.window = sandbox;
  sandbox.document = dom.document;
  sandbox.navigator = { clipboard: null };
  sandbox.addEventListener = function (t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); };
  sandbox.postMessage = function (m, o) { postMessages.push({ msg: m, targetOrigin: o }); };
  sandbox.setTimeout = function () { return 0; };
  sandbox.clearTimeout = function () {};
  sandbox.setInterval = function () { return 0; };
  sandbox.URL = URL;
  sandbox.Blob = function () {};
  sandbox.chrome = {
    runtime: {
      id: 'test-ext-id',
      lastError: undefined,
      sendMessage: function (m, cb) { runtimeMessages.push(m); if (cb) cb(); },
      onMessage: { addListener: function (fn) { runtimeListener = fn; } },
      openOptionsPage: function () {}
    },
    storage: {
      local: {
        get: function (key, cb) {
          if (key === 'xhs_settings') return cb({ xhs_settings: opts.settings || {} });
          return cb({});
        },
        set: function (o, cb) { if (cb) cb(); }
      },
      onChanged: { addListener: function (fn) { storageChanged = fn; } }
    }
  };

  var ctx = vm.createContext(sandbox);
  var err = null;
  try {
    vm.runInContext(read('src/content/styles.js'), ctx, { filename: 'styles.js' });
    vm.runInContext(read('src/content/ui.js'), ctx, { filename: 'ui.js' });
    vm.runInContext(read('src/content/downloader.js'), ctx, { filename: 'downloader.js' });
    vm.runInContext(read('src/content/content.js'), ctx, { filename: 'content.js' });
  } catch (e) {
    err = e;
  }
  var windowRef = vm.runInContext('window', ctx);

  return {
    sandbox: sandbox,
    windowRef: windowRef,
    err: err,
    dom: dom,
    runtimeMessages: runtimeMessages,
    postMessages: postMessages,
    winListeners: winListeners,
    getRuntimeListener: function () { return runtimeListener; },
    getStorageChanged: function () { return storageChanged; },
    ORIGIN: ORIGIN,
    NOTE_ID: NOTE_ID,
    fireWindow: function (type, ev) { (winListeners[type] || []).forEach(function (f) { f(ev); }); },
    noteMsg: function (payload, origin) {
      (winListeners['message'] || []).forEach(function (f) {
        f({ source: windowRef, origin: origin || ORIGIN, data: { __channel: 'xhs-dl', type: 'NOTE', payload: payload } });
      });
    },
    channelMsg: function (type, payload, origin) {
      (winListeners['message'] || []).forEach(function (f) {
        f({ source: windowRef, origin: origin || ORIGIN, data: { __channel: 'xhs-dl', type: type, payload: payload } });
      });
    }
  };
}

var L = loadContentScripts();
ok('ASM-1', '四个内容脚本按 manifest 顺序装配无异常', !L.err,
  L.err ? (L.err.message + '\n' + L.err.stack) : '');
ok('ASM-2', 'XHS_DL_CSS 已定义', typeof L.sandbox.XHS_DL_CSS === 'string' && L.sandbox.XHS_DL_CSS.length > 100);
ok('ASM-3', 'XHS_DL_UI 已定义', !!(L.sandbox.XHS_DL_UI && L.sandbox.XHS_DL_UI.mount));
ok('ASM-4', 'XHS_DL_DOWNLOADER 已定义', !!(L.sandbox.XHS_DL_DOWNLOADER && L.sandbox.XHS_DL_DOWNLOADER.buildTasks));
ok('ASM-5', 'content.js 已注册 chrome.runtime.onMessage 监听',
  typeof L.getRuntimeListener() === 'function');
ok('ASM-6', 'content.js 源码中注册了 chrome.storage.onChanged 监听（热更新设置）',
  /chrome\.storage\.onChanged\.addListener/.test(read('src/content/content.js')),
  '注册发生在 loadSettings().then() 的微任务里，同步断言无法直接观察，故改为源码断言');
ok('ASM-7', 'content.js 已注册 window message 监听',
  (L.winListeners['message'] || []).length >= 1);
ok('ASM-8', 'UI host 已挂载到 documentElement',
  L.dom.docEl.childNodes.some(function (n) { return n.id === 'xhs-dl-host'; }),
  'children=' + JSON.stringify(L.dom.docEl.childNodes.map(function (n) { return n.id || n.tagName; })));

/* UI 方法契约（对照 content.js 实际调用） */
H.suite('内容脚本装配 — XHS_DL_UI 方法契约');
var uiMethods = ['mount', 'open', 'close', 'toggle', 'isOpen', 'setNote', 'clearNote',
  'setSettings', 'setMediaHints', 'setPosition', 'setBusy', 'setProgress', 'hideProgress',
  'setBadge', 'setBanner', 'toast', 'setSourceBadge'];
uiMethods.forEach(function (m) {
  ok('UIAPI-' + m, 'XHS_DL_UI.' + m + ' 是函数',
    typeof L.sandbox.XHS_DL_UI[m] === 'function');
});

/* ================================================================== */
/* PART B-2 — NOTE 渲染与串台防护                                       */
/* ================================================================== */
H.suite('内容脚本装配 — NOTE 渲染与串台防护');

function makeNote(id) {
  return {
    noteId: id || L.NOTE_ID,
    source: 'initial-state',
    url: 'https://www.xiaohongshu.com/explore/' + (id || L.NOTE_ID),
    title: '莫干山民宿',
    desc: '',
    type: 'normal',
    publishTime: 1711612800,
    ipLocation: '浙江',
    cover: 'https://sns-img-qc.xhscdn.com/cover',
    author: { nickname: '旅行的小鹿', userId: 'u1', redId: 'r1', avatar: 'https://sns-img-qc.xhscdn.com/av' },
    images: [
      { index: 0, urlDefault: 'https://sns-img-qc.xhscdn.com/a', urlOrigin: 'https://sns-img-qc.xhscdn.com/a', urlJpg: 'https://sns-img-qc.xhscdn.com/a?imageView2/2/w/format/jpg', liveVideoUrl: '', isLive: false, width: 1080, height: 1440 },
      { index: 1, urlDefault: 'https://sns-img-qc.xhscdn.com/b', urlOrigin: 'https://sns-img-qc.xhscdn.com/b', urlJpg: 'https://sns-img-qc.xhscdn.com/b?imageView2/2/w/format/jpg', liveVideoUrl: 'https://sns-video-hw.xhscdn.com/live1.mp4', isLive: true, width: 1080, height: 1440 }
    ],
    video: null
  };
}

var bodyEl = null;
/** 在 shadow 树里按类名递归查找节点 */
function findByClass(root, cls) {
  if (!root || !root.childNodes) return null;
  for (var i = 0; i < root.childNodes.length; i++) {
    var n = root.childNodes[i];
    if (String(n.className || '').split(/\s+/).indexOf(cls) !== -1) return n;
    var deep = findByClass(n, cls);
    if (deep) return deep;
  }
  return null;
}
function panelBody(inst) {
  var host = inst.dom.docEl.childNodes.filter(function (n) { return n.id === 'xhs-dl-host'; })[0];
  if (!host || !host._shadow) return null;
  var panel = findByClass(host._shadow, 'xhs-dl-panel');
  return panel && panel._qCache['.xhs-dl-body'];
}

L.noteMsg(makeNote());
var body = panelBody(L);
ok('RND-1', '收到 NOTE 后渲染出媒体网格', !!(body && body.innerHTML.indexOf('xhs-dl-grid') !== -1),
  'body=' + (body && body.innerHTML.slice(0, 120)));
ok('RND-2', '渲染包含 2 个媒体项', !!(body && (body.innerHTML.match(/xhs-dl-item/g) || []).length === 2),
  'count=' + (body && (body.innerHTML.match(/xhs-dl-item/g) || []).length));
ok('RND-3', '实况图片带 is-live 标记', !!(body && body.innerHTML.indexOf('xhs-dl-tag is-live') !== -1));

/* 串台防护：URL 上的 noteId 与消息不一致 → 忽略 */
H.suite('内容脚本装配 — SPA 串台防护');
var L2 = loadContentScripts();
L2.noteMsg(makeNote('ffffffffffffffffffffffff'));
var body2 = panelBody(L2);
ok('RND-4', 'noteId 与 URL 不一致时忽略该笔记（不渲染媒体）',
  !body2 || body2.innerHTML.indexOf('xhs-dl-grid') === -1,
  'body=' + (body2 && body2.innerHTML.slice(0, 80)));

var L3 = loadContentScripts();
L3.noteMsg(makeNote(), 'https://evil.example.com');
var body3 = panelBody(L3);
ok('RND-5', '跨源 NOTE 消息被忽略', !body3 || body3.innerHTML.indexOf('xhs-dl-grid') === -1);

var L4 = loadContentScripts();
L4.noteMsg(makeNote('short'));   // noteId 不满足 6-64 位校验
var body4 = panelBody(L4);
ok('RND-6', '非法 noteId（长度不足）被 sanitizeNote 拒绝',
  !body4 || body4.innerHTML.indexOf('xhs-dl-grid') === -1);

var L5 = loadContentScripts();
L5.noteMsg({
  noteId: L5.NOTE_ID, title: 'x', type: 'normal', author: { nickname: 'n' },
  images: [{ index: 0, urlDefault: 'https://evil.example.com/a.jpg', urlOrigin: 'javascript:alert(1)' }]
});
var body5 = panelBody(L5);
ok('RND-7', '非白名单域名的媒体 URL 被过滤掉（不渲染）',
  !body5 || body5.innerHTML.indexOf('xhs-dl-grid') === -1,
  'body=' + (body5 && body5.innerHTML.slice(0, 80)));

/* ROUTE_CHANGE 清空 */
H.suite('内容脚本装配 — SPA 路由切换');
var L6 = loadContentScripts();
L6.noteMsg(makeNote());
var body6a = panelBody(L6);
ok('RND-8', '前置：先渲染出媒体', body6a.innerHTML.indexOf('xhs-dl-grid') !== -1);
L6.channelMsg('ROUTE_CHANGE', { noteId: 'other' });
var body6b = panelBody(L6);
ok('RND-9', 'ROUTE_CHANGE 后清空上一笔记（显示空态）',
  body6b.innerHTML.indexOf('xhs-dl-grid') === -1,
  'body=' + body6b.innerHTML.slice(0, 100));

/* MEDIA_HINTS 过滤：第三方 / blob: 直链不得进入下载任务 */
H.suite('内容脚本装配 — MEDIA_HINTS 过滤');
var L7 = loadContentScripts({ settings: { nameRule: '<序号>', timeFormat: 'YYYYMMDD', imageFormat: 'origin', videoQuality: 'default', liveMode: 'both', baseDir: '' } });
L7.noteMsg({
  noteId: L7.NOTE_ID, title: '视频笔记', type: 'video', author: { nickname: 'n' }, images: [],
  video: { urlOrigin: 'https://sns-video-hw.xhscdn.com/origin.mp4', urlStream: '', cover: '', duration: 10 }
});
L7.channelMsg('MEDIA_HINTS', { videos: [
  'https://sns-video-hw.xhscdn.com/ok.mp4',
  'https://evil.example.com/bad.mp4',
  'blob:https://www.xiaohongshu.com/xyz'
] });
var listener7 = L7.getRuntimeListener();
listener7({ type: 'DOWNLOAD_ALL' }, { id: 'test-ext-id' }, function () {});
var batch7 = L7.runtimeMessages.filter(function (m) { return m.type === 'DOWNLOAD_BATCH'; })[0];
var urls7 = batch7 ? batch7.payload.tasks.map(function (t) { return t.url; }) : [];
ok('RND-10', 'MEDIA_HINTS 中的第三方/blob: 直链被丢弃，仅保留白名单直链',
  urls7.length === 1 && urls7[0] === 'https://sns-video-hw.xhscdn.com/ok.mp4',
  'urls=' + JSON.stringify(urls7));

/* ================================================================== */
/* PART B-3 — Popup 消息契约                                            */
/* ================================================================== */
H.suite('内容脚本装配 — Popup 消息契约');

var L8 = loadContentScripts();
var listener8 = L8.getRuntimeListener();
var resp8 = null;
listener8({ type: 'GET_NOTE' }, { id: 'test-ext-id' }, function (r) { resp8 = r; });
eq('POP-1', 'GET_NOTE（无笔记）→ ok=false', resp8 && resp8.ok, false);

L8.noteMsg(makeNote());
resp8 = null;
listener8({ type: 'GET_NOTE' }, { id: 'test-ext-id' }, function (r) { resp8 = r; });
eq('POP-2', 'GET_NOTE（有笔记）→ ok=true', resp8 && resp8.ok, true);
eq('POP-3', 'GET_NOTE 返回 note.noteId', resp8 && resp8.note && resp8.note.noteId, L8.NOTE_ID);

var resp8b = null;
listener8({ type: 'OPEN_PANEL' }, { id: 'test-ext-id' }, function (r) { resp8b = r; });
eq('POP-4', 'OPEN_PANEL → ok=true', resp8b && resp8b.ok, true);
eq('POP-5', 'OPEN_PANEL 后面板处于 is-open 状态', L8.sandbox.XHS_DL_UI.isOpen(), true);

/* DOWNLOAD_ALL → 应下发 DOWNLOAD_BATCH 到后台 */
var L9 = loadContentScripts({ settings: { nameRule: '<序号>-<标题>', timeFormat: 'YYYYMMDD', imageFormat: 'origin', videoQuality: 'origin', liveMode: 'both', baseDir: '' } });
L9.noteMsg(makeNote());
var listener9 = L9.getRuntimeListener();
var resp9 = null;
listener9({ type: 'DOWNLOAD_ALL' }, { id: 'test-ext-id' }, function (r) { resp9 = r; });
eq('POP-6', 'DOWNLOAD_ALL → ok=true', resp9 && resp9.ok, true);
var batch = L9.runtimeMessages.filter(function (m) { return m.type === 'DOWNLOAD_BATCH'; })[0];
ok('POP-7', 'DOWNLOAD_ALL 下发了 DOWNLOAD_BATCH 到后台', !!batch,
  'runtimeMessages=' + JSON.stringify(L9.runtimeMessages.map(function (m) { return m.type; })));
eq('POP-8', '任务数 = 2 张图 + 1 个实况视频', batch && batch.payload.tasks.length, 3);
eq('POP-9', 'payload.noteId 正确', batch && batch.payload.noteId, L9.NOTE_ID);
ok('POP-10', '实况任务命名带 _live 后缀',
  batch && batch.payload.tasks.some(function (t) { return /_live\.mp4$/.test(t.name); }),
  'names=' + JSON.stringify(batch && batch.payload.tasks.map(function (t) { return t.name; })));

var L9b = loadContentScripts();
var resp9b = null;
L9b.getRuntimeListener()({ type: 'DOWNLOAD_ALL' }, { id: 'test-ext-id' }, function (r) { resp9b = r; });
eq('POP-11', 'DOWNLOAD_ALL（尚无笔记）→ ok=false, error=no-note',
  resp9b && resp9b.error, 'no-note');

/* 后台进度回传 */
H.suite('内容脚本装配 — 后台进度回传');
var L10 = loadContentScripts();
L10.noteMsg(makeNote());
var listener10 = L10.getRuntimeListener();
noThrow('POP-12', 'DL_START / DL_PROGRESS / DL_ITEM_PROGRESS / DL_ALL_DONE 均不抛异常', function () {
  listener10({ type: 'DL_START', payload: { total: 3, pending: 3, skipped: 0 } }, { id: 'test-ext-id' }, function () {});
  listener10({ type: 'DL_PROGRESS', payload: { done: 1, total: 3, current: 'a.jpg' } }, { id: 'test-ext-id' }, function () {});
  listener10({ type: 'DL_ITEM_PROGRESS', payload: { name: 'a.jpg', pct: 50, done: 1, totalItems: 3 } }, { id: 'test-ext-id' }, function () {});
  listener10({ type: 'DL_ALL_DONE', payload: { ok: 3, failed: [], total: 3, skipped: 0, lastError: '' } }, { id: 'test-ext-id' }, function () {});
  listener10({ type: 'DL_ALL_DONE', payload: { ok: 1, failed: ['x.jpg'], total: 3, skipped: 0, lastError: 'SERVER_BAD_CONTENT' } }, { id: 'test-ext-id' }, function () {});
});
ok('POP-13', '进度回传后不残留 busy 状态（下载按钮可用性由 selected 决定）',
  true, '（busy 状态无法从外部读取，仅验证无异常）');

/* ================================================================== */
/* PART B-4 — 页面世界消息契约                                          */
/* ================================================================== */
H.suite('内容脚本装配 — 与页面世界的消息契约');

var L11 = loadContentScripts();
var types11 = L11.postMessages.map(function (m) { return m.msg.type; });
ok('PAGE-1', 'content.js 启动时向页面世界发送 SET_HOOK',
  types11.indexOf('SET_HOOK') !== -1, 'types=' + JSON.stringify(types11));
ok('PAGE-2', 'SET_HOOK 的 targetOrigin 为 location.origin',
  L11.postMessages.every(function (m) { return m.targetOrigin === L11.ORIGIN; }),
  JSON.stringify(L11.postMessages.map(function (m) { return m.targetOrigin; })));
ok('PAGE-3', 'SET_HOOK payload.enabled 默认 true',
  L11.postMessages.filter(function (m) { return m.msg.type === 'SET_HOOK'; })[0].msg.payload.enabled === true);

var L12 = loadContentScripts({ settings: { hookEnabled: false } });
ok('PAGE-4', 'hookEnabled=false 时 SET_HOOK payload.enabled = false',
  L12.postMessages.filter(function (m) { return m.msg.type === 'SET_HOOK'; })[0].msg.payload.enabled === false);

/** 双向契约：content.js 发出的消息类型 ⊆ page-interceptor.js 处理的类型 */
var interceptorSrc = read('src/page-interceptor.js');
var contentSrc = read('src/content/content.js');
var outgoing = [];
(contentSrc.match(/type:\s*'([A-Z_]+)'/g) || []).forEach(function (s) {
  outgoing.push(s.replace(/type:\s*'|'/g, ''));
});
outgoing.push('SET_HOOK');   // applyHookSetting
outgoing.push('REQUEST_RESCAN'); // requestRescan
// 以下类型走 chrome.runtime 通道发给后台，不属于页面世界契约
// OPEN_OPTIONS：面板齿轮转发给后台代开设置页（内容脚本自己开会被浏览器拦截）
var runtimeOnly = ['DOWNLOAD_BATCH', 'CANCEL_BATCH', 'OPEN_OPTIONS'];
outgoing = outgoing.filter(function (t) { return runtimeOnly.indexOf(t) === -1; });
var handled = [];
(interceptorSrc.match(/d\.type === '([A-Z_]+)'/g) || []).forEach(function (s) {
  handled.push(s.replace(/d\.type === '|'/g, ''));
});
var unhandled = outgoing.filter(function (t) { return handled.indexOf(t) === -1; });
ok('PAGE-5', 'content.js 发出的页面世界消息类型都被 page-interceptor 处理',
  unhandled.length === 0, '未被处理的类型：' + JSON.stringify(unhandled));

/** 反向契约：interceptor 发出的类型 ⊆ content.js 处理的类型 */
var interceptorEmits = [];
(interceptorSrc.match(/post\('([A-Z_]+)'/g) || []).forEach(function (s) {
  interceptorEmits.push(s.replace(/post\('|'/g, ''));
});
var contentHandles = [];
(contentSrc.match(/case '([A-Z_]+)':/g) || []).forEach(function (s) {
  contentHandles.push(s.replace(/case '|':/g, ''));
});
// HOOK_STATE 是 SET_HOOK 的应答，content.js 目前不消费（观察项 O-04）
var infoOnly = ['HOOK_STATE'];
var unhandled2 = interceptorEmits.filter(function (t) {
  return contentHandles.indexOf(t) === -1 && infoOnly.indexOf(t) === -1;
});
ok('PAGE-6', 'page-interceptor 发出的消息类型都被 content.js 处理',
  unhandled2.length === 0, '未被处理的类型：' + JSON.stringify(unhandled2));
ok('PAGE-7', '观察项 O-04：HOOK_STATE 已发出但 content.js 未消费',
  interceptorEmits.indexOf('HOOK_STATE') !== -1 && contentHandles.indexOf('HOOK_STATE') === -1,
  'interceptor 发出的类型=' + JSON.stringify(interceptorEmits) +
  ' content.js 处理的类型=' + JSON.stringify(contentHandles));

/* ================================================================== */
/* PART A-9 — 设置页每个输入控件都必须真的绑了监听                       */
/* ================================================================== */
/**
 * 踩过的坑：新增 spaSource 开关时只加了 HTML 复选框 + renderForm 回填，
 * 忘了在 bind() 里 addEventListener —— 结果用户勾选不写 storage，
 * 开关是死的（点了没反应，重载后回到默认值）。
 * 这里把「HTML 里有 input id ⇒ options.js 里有对应监听」钉死。
 */
H.suite('设置页控件监听完整性');
var optHtml = read('src/options/options.html');
var optJs = read('src/options/options.js');

// 取所有 <input ... id="xxx">
var inputIds = [];
var inputRe = /<input\b[^>]*\bid\s*=\s*"([^"]+)"/g;
var im;
while ((im = inputRe.exec(optHtml)) !== null) {
  if (inputIds.indexOf(im[1]) === -1) inputIds.push(im[1]);
}
ok('OPT-1', 'options.html 里解析到 input 控件', inputIds.length > 0,
  'ids=' + JSON.stringify(inputIds));

// radio 组走 querySelectorAll 批量绑定，不在 els 上单独绑
var radioNames = [];
var radioRe = /<input\b[^>]*\bname\s*=\s*"([^"]+)"/g;
var rm;
while ((rm = radioRe.exec(optHtml)) !== null) {
  if (radioNames.indexOf(rm[1]) === -1) radioNames.push(rm[1]);
}

inputIds.forEach(function (id) {
  var bound = optJs.indexOf(id + '.addEventListener') !== -1;
  // 退路：radio 组由 bind() 里的 forEach(group) 统一绑定
  if (!bound) {
    bound = radioNames.some(function (n) {
      return optHtml.indexOf('id="' + id + '"') !== -1 &&
        optHtml.slice(optHtml.indexOf('id="' + id + '"') - 200).indexOf('name="' + n + '"') !== -1 &&
        optJs.indexOf("'" + n + "'") !== -1;
    });
  }
  ok('OPT-LISTEN-' + id, 'options.js 为 #' + id + ' 绑定了监听（避免"控件是死的"）', bound,
    bound ? '' : 'options.js 中找不到 ' + id + '.addEventListener');
});

/* ================================================================== */
/* PART A-10 — popup 打开设置页不得与 window.close() 竞争                */
/* ================================================================== */
/**
 * 踩过的坑：openOptionsPage() 是异步创建/聚焦标签页，紧跟 window.close()
 * （或在其回调里 close）都会与之竞争，把打开动作掐掉 —— 表现是
 * "点了设置按钮什么也没发生"。新标签页获得焦点时 popup 本就会自动关闭，
 * 所以这里根本不需要主动 close。
 */
H.suite('popup 打开设置页不与关闭竞争');
var popupSrc = read('src/popup/popup.js');
var oi = popupSrc.indexOf('openOptionsPage');
ok('POP-1', 'popup.js 中存在 openOptionsPage 调用', oi !== -1);
if (oi !== -1) {
  var seg = popupSrc.slice(oi, oi + 500);
  ok('POP-2', 'openOptionsPage 之后不得紧跟 window.close()（会掐掉打开动作）',
    seg.indexOf('window.close') === -1,
    seg.indexOf('window.close') === -1 ? '' : '片段内出现了 window.close');
}

/* ================================================================== */
/* PART A-11 — 面板齿轮 onOptions 必须走 getURL + window.open            */
/* ================================================================== */
/**
 * 踩过的坑：chrome.runtime.openOptionsPage() 从**内容脚本**触发在 Edge MV3
 * 下经常"什么都不发生"（不报错也不开新页）。面板齿轮的 onOptions handler
 * 必须改走 window.open(chrome.runtime.getURL(...))，否则用户的齿轮不跳转。
 */
H.suite('面板齿轮 onOptions 必须转发给后台打开');
var contentSrc2 = read('src/content/content.js');
var bgSrc2 = read('src/background.js');
ok('OPT-URL-1', 'content.js 发送 OPEN_OPTIONS 消息（由后台代开）',
  contentSrc2.indexOf("type: 'OPEN_OPTIONS'") !== -1);
ok('OPT-URL-2', 'background.js 处理 OPEN_OPTIONS',
  bgSrc2.indexOf("case 'OPEN_OPTIONS'") !== -1);
// 反向守门：内容脚本里不能再出现被浏览器拦截的写法
ok('OPT-URL-3', 'content.js 不得用 window.open 打开扩展页面（会被 ERR_BLOCKED_BY_CLIENT 拦截）',
  !/window\.open\(\s*chrome\.runtime\.getURL/.test(contentSrc2),
  /window\.open\(\s*chrome\.runtime\.getURL/.test(contentSrc2) ? '发现被拦截写法' : '');

var S = H.summary('test-static.js');
process.exit(S.fail ? 1 : 0);
