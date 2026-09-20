/**
 * SPA 取源协议测试 —— 只针对 content.js 与页面世界之间的重扫协议
 * 运行： node test-content-spa.js
 *
 * 覆盖的是「静默失败链」修掉之后的判定信号：
 *   1. acceptNote 的拒绝 / 接受都要留痕（以前拒绝是裸 return）
 *   2. RESCAN_DONE 必须看 accepted（是不是当前这条笔记），不能只看 ok
 *      —— 只看 ok 会让「重扫成功」和「已降级为 DOM 提取」同时出现
 *   3. pendingSoftRefresh 期间不得提前降级（软刷新成功会被降级结果覆盖）
 *   4. ROUTE_CHANGE 之后必须再要一次数据（否则面板永久空，只能整页刷新）
 *   5. window.__XHS_DL_DIAG__() 供真机脚本直接读状态，不用匹配 console 文本
 *   6. 降级横幅的「已尝试自动重新取源但失败」只在本导航真的试过时才加
 *
 * 这里不加载 styles/ui/downloader，而是给 content.js 注入 XHS_DL_UI /
 * XHS_DL_DOWNLOADER 桩：本文件只关心 content.js 的编排决策（发什么消息、
 * 打什么日志、弹什么横幅），UI 渲染由 test-static.js 的全量装配负责。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var H = require('./_harness');
var eq = H.eq, deepEq = H.deepEq, ok = H.ok, noThrow = H.noThrow;

var ROOT = path.join(__dirname, '..');
// 可通过 XHS_CONTENT_SRC 指向另一个 content.js（用于拿旧版本跑回归，验证本套件真的能抓到老 bug）
var CONTENT_SRC = fs.readFileSync(
  process.env.XHS_CONTENT_SRC || path.join(ROOT, 'src', 'content', 'content.js'), 'utf8');

var NOTE_ID = '65f1a2b3000000001203abcd';
var OTHER_ID = '1111111111111111111111aa';
var ORIGIN = 'https://www.xiaohongshu.com';

function imgNode(src) {
  return {
    src: src,
    naturalWidth: 100,
    naturalHeight: 100,
    getAttribute: function (k) { return k === 'src' ? src : null; }
  };
}

/**
 * 装配一个只含 content.js 的沙箱。
 * opts.imgSrcs —— 让 DOM 兜底能真的抠出图，从而走到"已降级为 DOM 提取"那条横幅。
 */
function load(opts) {
  opts = opts || {};
  var logs = { log: [], warn: [], error: [] };
  var postMessages = [];
  var timers = [];
  var winListeners = {};
  var ui = { setNote: [], clearNote: 0, setBanner: [], toast: [], setBadge: [] };
  var runtimeListener = null;
  var imgSrcs = opts.imgSrcs || [];

  function rec(bucket) {
    return function () {
      bucket.push(Array.prototype.map.call(arguments, function (a) {
        return typeof a === 'string' ? a : String(a);
      }).join(' '));
    };
  }

  var sandbox = {};
  sandbox.console = {
    log: rec(logs.log),
    warn: rec(logs.warn),
    error: rec(logs.error),
    info: rec(logs.log)
  };
  sandbox.location = { href: ORIGIN + '/explore/' + NOTE_ID, origin: ORIGIN, pathname: '/explore/' + NOTE_ID };
  sandbox.window = sandbox;
  sandbox.document = {
    readyState: 'complete',
    title: '小红书',
    documentElement: { appendChild: function () {}, childNodes: [] },
    body: { appendChild: function () {} },
    createElement: function () { return { style: {}, setAttribute: function () {}, appendChild: function () {}, remove: function () {} }; },
    addEventListener: function () {},
    execCommand: function () { return true; },
    // 只有含 video 的选择器返回 null；其余一律返回标题节点，
    // 这样 domFallback() 能拿到 title 但不会误判出视频
    querySelector: function (sel) {
      if (/video/.test(sel)) return null;
      return { textContent: ' 测试标题 ' };
    },
    querySelectorAll: function () {
      return imgSrcs.map(imgNode);
    }
  };
  sandbox.navigator = { clipboard: null };
  sandbox.addEventListener = function (t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); };
  sandbox.postMessage = function (m, o) { postMessages.push({ msg: m, targetOrigin: o }); };
  sandbox.setTimeout = function (fn, d) { timers.push({ fn: fn, delay: d || 0 }); return timers.length; };
  sandbox.clearTimeout = function () {};
  sandbox.setInterval = function () { return 0; };
  sandbox.URL = URL;
  sandbox.Blob = function () {};
  sandbox.chrome = {
    runtime: {
      id: 'test-ext-id',
      lastError: undefined,
      sendMessage: function (m, cb) { if (cb) cb(); },
      onMessage: { addListener: function (fn) { runtimeListener = fn; } },
      openOptionsPage: function () {}
    },
    storage: {
      local: {
        get: function (k, cb) { return cb({}); },
        set: function (o, cb) { if (cb) cb(); }
      },
      onChanged: { addListener: function () {} }
    }
  };
  sandbox.XHS_DL_UI = {
    setSettings: function () {}, setPosition: function () {},
    mount: function () {}, open: function () {}, close: function () {},
    toggle: function () {}, isOpen: function () { return false; },
    setNote: function (n) { ui.setNote.push(n); },
    clearNote: function () { ui.clearNote++; },
    setMediaHints: function () {}, setCommentMedia: function () {},
    setBusy: function () {}, isBusy: function () { return false; },
    setProgress: function () {}, hideProgress: function () {},
    setBadge: function (n) { ui.setBadge.push(n); },
    setBanner: function (t, k) { ui.setBanner.push({ text: t, kind: k }); },
    toast: function (t, k) { ui.toast.push({ text: t, kind: k }); },
    selectedCommentItems: function () { return []; }
  };
  sandbox.XHS_DL_DOWNLOADER = {
    buildTasks: function () { return []; },
    buildCommentTasks: function () { return []; },
    sanitize: function (s) { return s; }
  };

  var err = null;
  // 必须用 createContext + runInContext（而不是 runInNewContext）：
  // 后者会另起一个全局对象，导致 content.js 里的 `window` 与外面持有的
  // sandbox 不是同一个引用，`ev.source !== window` 这条同源守卫会永远为真，
  // 消息全部被静默丢弃 —— 测试会假绿。
  var ctx = vm.createContext(sandbox);
  var windowRef = null;
  try {
    vm.runInContext(CONTENT_SRC, ctx, { filename: 'content.js' });
    windowRef = vm.runInContext('window', ctx);
  } catch (e) {
    err = e;
  }

  return {
    err: err,
    logs: logs,
    ui: ui,
    postMessages: postMessages,
    sandbox: sandbox,
    windowRef: windowRef,
    all: function () { return logs.log.concat(logs.warn).concat(logs.error); },
    /** 只跑指定 delay 的定时器，避免误触发 boot() 的 3500ms 首屏兜底 */
    flush: function (delay) {
      timers.filter(function (t) { return t.delay === delay; }).forEach(function (t) { t.fn(); });
    },
    fire: function (type, payload) {
      (winListeners['message'] || []).forEach(function (f) {
        f({ source: windowRef, origin: ORIGIN, data: { __channel: 'xhs-dl', type: type, payload: payload } });
      });
    },
    runtime: function (msg) {
      if (!runtimeListener) throw new Error('runtime.onMessage 监听未注册');
      runtimeListener(msg, { id: 'test-ext-id' }, function () {});
    },
    // 旧版本没有这个钩子，返回 null 让断言正常报错，而不是让整个套件崩掉
    diag: function () {
      return (windowRef && typeof windowRef.__XHS_DL_DIAG__ === 'function')
        ? windowRef.__XHS_DL_DIAG__() : null;
    }
  };
}

/** 构造一条可通过 sanitizeNote 的笔记 */
function noteRaw(id, source) {
  return {
    noteId: id,
    source: source || 'initial-state',
    title: '标题',
    desc: '正文',
    type: 'normal',
    images: [{ urlDefault: 'https://sns-webpic-qc.xhscdn.com/a.jpg', urlOrigin: 'https://sns-webpic-qc.xhscdn.com/a.jpg' }],
    author: { nickname: '作者', userId: 'u1', redId: 'r1' }
  };
}

var IMG = ['https://sns-webpic-qc.xhscdn.com/p1.jpg', 'https://sns-webpic-qc.xhscdn.com/p2.jpg'];

/* ================================================================== */
H.suite('SPA 取源 — acceptNote 拒绝/接受都必须留痕');

var A = load();
ok('SPA-0', 'content.js 装配无异常', !A.err, A.err ? A.err.message + '\n' + A.err.stack : '');

A.fire('NOTE', noteRaw(OTHER_ID, 'initial-state'));
ok('SPA-1', '与 URL 不符的 NOTE 打印 NOTE rejected',
  A.logs.warn.some(function (l) { return /NOTE rejected/.test(l); }),
  'warn=' + JSON.stringify(A.logs.warn));
ok('SPA-1b', 'rejected 日志带上收到的 noteId 与当前 URL 的 noteId',
  A.logs.warn.some(function (l) {
    return /NOTE rejected/.test(l) && l.indexOf(OTHER_ID) !== -1 && l.indexOf(NOTE_ID) !== -1;
  }), JSON.stringify(A.logs.warn));
ok('SPA-1c', 'rejected 日志带上来源字段（用于判断走了哪条提取路径）',
  A.logs.warn.some(function (l) { return /NOTE rejected/.test(l) && /initial-state/.test(l); }),
  JSON.stringify(A.logs.warn));
eq('SPA-1d', '被拒绝的 NOTE 不会进面板（setNote 未调用）', A.ui.setNote.length, 0);

var B = load();
B.fire('NOTE', noteRaw(NOTE_ID, 'soft-refresh'));
ok('SPA-2', 'URL 匹配的 NOTE 打印 NOTE accepted',
  B.logs.log.some(function (l) { return /NOTE accepted/.test(l); }), JSON.stringify(B.logs.log));
ok('SPA-2b', 'accepted 日志带上来源 soft-refresh',
  B.logs.log.some(function (l) { return /NOTE accepted/.test(l) && /soft-refresh/.test(l); }),
  JSON.stringify(B.logs.log));
eq('SPA-2c', '被接受的 NOTE 会进面板', B.ui.setNote.length, 1);

/* ================================================================== */
H.suite('SPA 取源 — RESCAN_DONE 判定看 accepted 而不是 ok');

// 软刷新进行中：不得提前降级，也不得弹「没有识别到笔记数据」
var C = load({ imgSrcs: IMG });
C.fire('RESCAN_DONE', {
  noteId: NOTE_ID, ok: true, accepted: false, pendingSoftRefresh: true,
  diag: { navSeq: 7, softRefresh: 'idle', urlIdInDetailMap: true, hookInstalled: true }
});
ok('SPA-3', 'pendingSoftRefresh 时打印「软刷新进行中，等待下一次结果」',
  C.logs.log.some(function (l) { return /软刷新进行中/.test(l); }), JSON.stringify(C.logs.log));
ok('SPA-3b', '软刷新期间不打印「未取到源」（信号不能自相矛盾）',
  !C.logs.warn.some(function (l) { return /未取到源/.test(l); }), JSON.stringify(C.logs.warn));
ok('SPA-3c', '软刷新期间不弹降级横幅',
  !C.ui.setBanner.some(function (b) { return /降级|未能读取/.test(b.text); }),
  JSON.stringify(C.ui.setBanner));
ok('SPA-3d', '软刷新期间不弹「没有识别到笔记数据」',
  !C.ui.toast.some(function (t) { return /没有识别到笔记数据/.test(t.text); }),
  JSON.stringify(C.ui.toast));

// accepted=true 且 current 有值 → 明确报"取到源"
var D = load();
D.fire('NOTE', noteRaw(NOTE_ID, 'initial-state'));
D.fire('RESCAN_DONE', {
  noteId: NOTE_ID, ok: true, accepted: true, pendingSoftRefresh: false,
  diag: { navSeq: 3, softRefresh: 'idle' }
});
ok('SPA-4', 'accepted=true 且已有数据时打印「已取到源数据（来源=…）」',
  D.logs.log.some(function (l) { return /已取到源数据（来源=initial-state）/.test(l); }),
  JSON.stringify(D.logs.log));
ok('SPA-4b', '取到源时不打印「未取到源」',
  !D.logs.warn.some(function (l) { return /未取到源/.test(l); }), JSON.stringify(D.logs.warn));

// accepted=false → 打诊断 + 走 DOM 兜底（不再出现"重扫成功"假象）
var E = load({ imgSrcs: IMG });
E.fire('RESCAN_DONE', {
  noteId: NOTE_ID, ok: true, accepted: false, pendingSoftRefresh: false,
  diag: { navSeq: 5, softRefresh: 'failed', hookInstalled: false }
});
ok('SPA-5', 'accepted=false 时打印「未取到源」并带上诊断快照',
  E.logs.warn.some(function (l) { return /未取到源/.test(l) && /navSeq/.test(l); }),
  JSON.stringify(E.logs.warn));
ok('SPA-5b', 'accepted=false 时不再打印「重扫成功」（消除自相矛盾的日志）',
  !E.all().some(function (l) { return /重扫成功/.test(l); }), JSON.stringify(E.all()));
ok('SPA-5c', 'accepted=false 且无数据时走 DOM 兜底（弹出降级横幅）',
  E.ui.setBanner.some(function (b) { return /降级为 DOM 提取/.test(b.text); }),
  JSON.stringify(E.ui.setBanner));

/* 旧协议兼容：同事还没发 accepted 时回退到 ok，不得崩 */
var F = load();
F.fire('NOTE', noteRaw(NOTE_ID, 'inline-script'));
noThrow('SPA-6', '旧版 interceptor（无 accepted 字段）不崩', function () {
  F.fire('RESCAN_DONE', { noteId: NOTE_ID, ok: true, diag: { navSeq: 1 } });
});
ok('SPA-6b', '无 accepted 时按 ok=true 判定为取到源',
  F.logs.log.some(function (l) { return /已取到源数据（来源=inline-script）/.test(l); }),
  JSON.stringify(F.logs.log));

var G = load();
noThrow('SPA-6c', 'payload 完全缺失时也不崩', function () {
  G.fire('RESCAN_DONE', undefined);
});

var Hh = load({ imgSrcs: IMG });
noThrow('SPA-6d', '旧版 ok=false（无 accepted）走兜底不崩', function () {
  Hh.fire('RESCAN_DONE', { noteId: NOTE_ID, ok: false, diag: { navSeq: 2 } });
});
ok('SPA-6e', '旧版 ok=false 打印「未取到源」',
  Hh.logs.warn.some(function (l) { return /未取到源/.test(l); }), JSON.stringify(Hh.logs.warn));

/* ================================================================== */
H.suite('SPA 取源 — ROUTE_CHANGE 后必须再要一次数据');

var I = load();
I.fire('NOTE', noteRaw(NOTE_ID, 'initial-state'));
eq('SPA-7', '切路由前有数据', I.ui.setNote.length, 1);
var beforeCount = I.postMessages.length;
I.fire('ROUTE_CHANGE', {});
eq('SPA-7b', 'ROUTE_CHANGE 会清空面板', I.ui.clearNote, 1);
eq('SPA-7c', 'ROUTE_CHANGE 当下不直接发请求（等清空后的下一个 tick）',
  I.postMessages.length, beforeCount);
I.flush(0);
var rescan = I.postMessages.filter(function (m) { return m.msg.type === 'REQUEST_RESCAN'; });
eq('SPA-7d', '清空后立刻补发一次 REQUEST_RESCAN（面板不再永久空窗）', rescan.length, 1);
ok('SPA-7e', 'REQUEST_RESCAN 走同页面 targetOrigin',
  rescan.length === 1 && rescan[0].targetOrigin === ORIGIN,
  JSON.stringify(rescan.map(function (m) { return m.targetOrigin; })));

/* ================================================================== */
H.suite('SPA 取源 — 诊断快照 __XHS_DL_DIAG__');

var J = load();
ok('SPA-8', '暴露 window.__XHS_DL_DIAG__', typeof J.diag === 'function');
var d0 = J.diag() || {};
deepEq('SPA-8b', '无数据时的快照字段齐全且为空', d0, {
  noteId: null, source: null, imageCount: 0, hasVideo: false,
  commentCount: 0, degraded: false, navSeq: 0, softRefresh: 'idle'
});
J.fire('NOTE', noteRaw(NOTE_ID, 'initial-state'));
J.fire('RESCAN_DONE', { noteId: NOTE_ID, ok: true, accepted: true, diag: { navSeq: 42, softRefresh: 'idle' } });
var d1 = J.diag() || {};
eq('SPA-8c', '快照读出当前 noteId', d1.noteId, NOTE_ID);
eq('SPA-8d', '快照读出来源', d1.source, 'initial-state');
eq('SPA-8e', '快照读出图片数', d1.imageCount, 1);
eq('SPA-8f', '快照读出 navSeq（来自 RESCAN_DONE.diag）', d1.navSeq, 42);
eq('SPA-8g', '非 dom 来源时 degraded=false', d1.degraded, false);

var K = load({ imgSrcs: IMG });
K.fire('RESCAN_DONE', { noteId: NOTE_ID, ok: true, accepted: false, diag: { navSeq: 9, softRefresh: 'failed' } });
var d2 = K.diag() || {};
eq('SPA-9', 'DOM 降级后快照 degraded=true', d2.degraded, true);
eq('SPA-9b', 'DOM 降级后快照 source=dom', d2.source, 'dom');
eq('SPA-9c', 'DOM 降级后快照图数来自 DOM 兜底', d2.imageCount, 2);

/* ================================================================== */
H.suite('SPA 取源 — 软刷新失败只在本次真的试过时才提示');

var L = load({ imgSrcs: IMG });
L.fire('RESCAN_DONE', { noteId: NOTE_ID, ok: true, accepted: false, diag: { navSeq: 1, softRefresh: 'failed' } });
var bannerL = L.ui.setBanner.filter(function (b) { return /降级为 DOM 提取/.test(b.text); })[0];
ok('SPA-10', 'softRefresh=failed 时横幅追加「已尝试自动重新取源但失败」',
  !!bannerL && /（已尝试自动重新取源但失败）/.test(bannerL.text),
  bannerL ? bannerL.text : '（未找到降级横幅）');
ok('SPA-10b', '追加后仍保留原有降级说明（不改原意）',
  !!bannerL && /已降级为 DOM 提取/.test(bannerL.text) && /滚动页面让图片加载完成/.test(bannerL.text),
  bannerL ? bannerL.text : '');

var M = load({ imgSrcs: IMG });
M.fire('RESCAN_DONE', { noteId: NOTE_ID, ok: true, accepted: false, diag: { navSeq: 1, softRefresh: 'ok' } });
var bannerM = M.ui.setBanner.filter(function (b) { return /降级为 DOM 提取/.test(b.text); })[0];
ok('SPA-10c', 'softRefresh=ok（不是 failed）时不追加该句',
  !!bannerM && !/已尝试自动重新取源/.test(bannerM.text),
  bannerM ? bannerM.text : '（未找到降级横幅）');

// 关键回归：横幅不能读"上一次导航"留下的粘性状态，否则信号在撒谎
var N = load({ imgSrcs: IMG });
N.fire('RESCAN_DONE', { noteId: NOTE_ID, ok: true, accepted: false, diag: { navSeq: 1, softRefresh: 'failed' } });
N.fire('ROUTE_CHANGE', {});
N.flush(0);
N.ui.setBanner.length = 0;
N.runtime({ type: 'GET_NOTE' });   // 非重扫路径触发的兜底，没有 diag
var bannerN = N.ui.setBanner.filter(function (b) { return /降级为 DOM 提取/.test(b.text); })[0];
ok('SPA-11', '非重扫路径（无 diag）不沿用上一次的 softRefresh=failed 提示',
  !!bannerN && !/已尝试自动重新取源/.test(bannerN.text),
  bannerN ? bannerN.text : '（未找到降级横幅）');

var S = H.summary('test-content-spa.js');
process.exit(S.fail ? 1 : 0);
