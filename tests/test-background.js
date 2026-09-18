/**
 * 单元测试 + 消息流集成测试：src/background.js
 * 运行： node test-background.js
 *
 * 说明：sanitizeSegment / buildPath 未导出，因此从源码中正则抽取函数体后
 * 在独立 vm 上下文中求值（抽取失败会显式报错，不会静默跳过）。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var H = require('./_harness');
var eq = H.eq, deepEq = H.deepEq, ok = H.ok, noThrow = H.noThrow;

var SRC = path.join(__dirname, '..', 'src', 'background.js');
var src = fs.readFileSync(SRC, 'utf8');

/* ================================================================== */
/* PART 1 — 从源码抽取 sanitizeSegment / buildPath 并测试               */
/* ================================================================== */

H.suite('前置条件 — 函数抽取');
var mRe = src.match(/var RESERVED_RE = .*?;/);
var mMax = src.match(/var MAX_PATH_LEN = \d+;/);
var mSeg = src.match(/function sanitizeSegment\s*\([\s\S]*?\n\}/);
var mPath = src.match(/function buildPath\s*\([\s\S]*?\n\}/);
ok('PRE-1', '成功抽取 RESERVED_RE', !!mRe);
ok('PRE-2', '成功抽取 MAX_PATH_LEN', !!mMax);
ok('PRE-3', '成功抽取 sanitizeSegment', !!mSeg);
ok('PRE-4', '成功抽取 buildPath', !!mPath);

var ctx = vm.createContext({ console: console });
vm.runInContext([
  mRe[0], mMax[0], mSeg[0], mPath[0],
  'this.__sanitizeSegment = sanitizeSegment; this.__buildPath = buildPath; this.__MAX = MAX_PATH_LEN;'
].join('\n'), ctx);
var sanitizeSegment = ctx.__sanitizeSegment;
var buildPath = ctx.__buildPath;
var MAX_PATH_LEN = ctx.__MAX;
eq('PRE-5', 'MAX_PATH_LEN = 180', MAX_PATH_LEN, 180);

/* ---------------- sanitizeSegment ---------------- */
H.suite('sanitizeSegment — 路径段清洗');

eq('SS-1', '普通名保留', sanitizeSegment('正常标题'), '正常标题');
eq('SS-2', '非法字符 → _', sanitizeSegment('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
eq('SS-3', '控制字符 → _', sanitizeSegment('a\u0000b\u001fc'), 'a_b_c');
eq('SS-4', '连续空白折叠', sanitizeSegment('a    b'), 'a b');
eq('SS-5', '首尾点剥离', sanitizeSegment('..name..'), 'name');
eq('SS-6', '首尾空格剥离', sanitizeSegment('   name   '), 'name');
eq('SS-7', '仅点/空格 → 占位 _', sanitizeSegment('  ...  '), '_');
eq('SS-8', '空串 → 占位 _', sanitizeSegment(''), '_');
eq('SS-9', 'null → 占位 _', sanitizeSegment(null), '_');
eq('SS-10', 'undefined → 占位 _', sanitizeSegment(undefined), '_');
eq('SS-11', '数字 → 字符串', sanitizeSegment(42), '42');

/* 路径穿越 */
eq('SS-12', '路径穿越 ../../etc → / 变 _ 且首部点被剥离',
  sanitizeSegment('../../etc'), '_.._etc');
eq('SS-13', '穿越段中不含 / 或 \\',
  /[\/\\]/.test(sanitizeSegment('../../etc/passwd')), false);
eq('SS-14', 'Windows 穿越 ..\\..\\windows\\system32 不含分隔符',
  /[\/\\]/.test(sanitizeSegment('..\\..\\windows\\system32')), false);
eq('SS-15', '绝对路径 /etc → 无前导 /',
  sanitizeSegment('/etc/x'), '_etc_x');
eq('SS-16', '绝对路径 C:\\Windows → 无冒号反斜杠',
  sanitizeSegment('C:\\Windows'), 'C__Windows');

/* Windows 保留设备名 */
eq('SS-17', 'CON → 加前缀', sanitizeSegment('CON'), '_CON');
eq('SS-18', 'con.jpg → 加前缀', sanitizeSegment('con.jpg'), '_con.jpg');
eq('SS-19', 'COM1 → 加前缀', sanitizeSegment('COM1'), '_COM1');
eq('SS-20', 'LPT9 → 加前缀', sanitizeSegment('LPT9'), '_LPT9');
eq('SS-21', 'NUL.txt → 加前缀', sanitizeSegment('NUL.txt'), '_NUL.txt');
eq('SS-22', 'PRN', sanitizeSegment('PRN'), '_PRN');
eq('SS-23', 'AUX', sanitizeSegment('AUX'), '_AUX');
eq('SS-24', 'COM0（0 也在规则内）', sanitizeSegment('COM0'), '_COM0');
eq('SS-25', 'CONSOLE 不是保留名，不加前缀', sanitizeSegment('CONSOLE'), 'CONSOLE');
eq('SS-26', 'CONS 不是保留名', sanitizeSegment('CONS'), 'CONS');

/* 结尾点/空格 */
eq('SS-27', 'title... → title', sanitizeSegment('title...'), 'title');
eq('SS-28', 'title   → title', sanitizeSegment('title   '), 'title');
eq('SS-29', 'title. . → title', sanitizeSegment('title. .'), 'title');

/* ---------------- buildPath ---------------- */
H.suite('buildPath — 完整路径组装');

eq('BP-1', '无目录', buildPath('', 'a.jpg'), 'a.jpg');
eq('BP-2', '单层目录', buildPath('dir', 'a.jpg'), 'dir/a.jpg');
eq('BP-3', '多层目录', buildPath('a/b/c', 'x.mp4'), 'a/b/c/x.mp4');
eq('BP-4', '空目录段被丢弃', buildPath('a//b/', 'f.jpg'), 'a/b/f.jpg');
eq('BP-5', '全部为空的目录', buildPath('///', 'f.jpg'), 'f.jpg');
eq('BP-6', '目录段清洗为 _ 后被丢弃', buildPath('a/../b', 'f.jpg'), 'a/b/f.jpg');
eq('BP-7', '目录穿越无法逃逸', buildPath('../../etc', 'passwd'), 'etc/passwd');
eq('BP-8', '反斜杠目录穿越无法逃逸',
  /\.\./.test(buildPath('..\\..\\windows', 'x.txt')), false);
eq('BP-9', '绝对目录被去根', buildPath('/etc', 'x'), 'etc/x');
eq('BP-10', '盘符目录被清洗', buildPath('C:\\Windows', 'x'), 'C__Windows/x');
eq('BP-11', '空文件名 → _', buildPath('', ''), '_');
eq('BP-12', '文件名保留设备名防护', buildPath('', 'CON'), '_CON');
eq('BP-13', '文件名结尾点被剥离', buildPath('', 'title...'), 'title');
eq('BP-14', '扩展名保留（.mp4）', buildPath('', 'a.mp4'), 'a.mp4');
eq('BP-15', '无扩展名', buildPath('', 'a'), 'a');
eq('BP-16', '隐藏文件名（.bashrc）不视为扩展名分割点',
  buildPath('', '.bashrc'), 'bashrc', 'dot>0 才分割，dot=0 时 base=.bashrc，但前导点已被 sanitize 剥离');

/* 长度约束 */
var longName = 'x'.repeat(300) + '.mp4';
var p1 = buildPath('', longName);
ok('BP-17', '300 字符标题被截断到 ≤ MAX_PATH_LEN', p1.length <= MAX_PATH_LEN,
  'len=' + p1.length);
ok('BP-18', '截断后扩展名 .mp4 被保留', /\.mp4$/.test(p1), 'path=' + p1);
ok('BP-19', '截断后仍为纯文件名（无多余分隔符）', p1.indexOf('//') === -1, 'path=' + p1);

var p2 = buildPath('小红书下载/作者昵称', 'y'.repeat(200) + '.jpg');
ok('BP-20', '带两层目录 + 超长名 ≤ MAX_PATH_LEN', p2.length <= MAX_PATH_LEN,
  'len=' + p2.length + ' path=' + p2.slice(0, 60) + '...');
ok('BP-21', '带目录时扩展名仍保留', /\.jpg$/.test(p2), 'tail=' + p2.slice(-12));

/* 目录本身超长（缺陷验证） */
var longDir = 'a'.repeat(70) + '/' + 'b'.repeat(70) + '/' + 'c'.repeat(70);
var p3 = buildPath(longDir, 'title.mp4');
ok('BP-22', '目录本身超长时整条路径仍应 ≤ MAX_PATH_LEN（缺陷 D-04）',
  p3.length <= MAX_PATH_LEN, 'len=' + p3.length + '（超出 ' + (p3.length - MAX_PATH_LEN) + ' 字符）');

var p4 = buildPath('d'.repeat(80) + '/' + 'e'.repeat(80) + '/' + '标题'.repeat(20), 'x.mp4');
ok('BP-23', '真实场景：baseDir(80)+作者(80)+标题(40) 组合下 ≤ MAX_PATH_LEN（缺陷 D-04）',
  p4.length <= MAX_PATH_LEN, 'len=' + p4.length);

/* ================================================================== */
/* PART 2 — 用 chrome 桩加载整个 background.js，测试消息流              */
/* ================================================================== */

function makeChromeStub(opts) {
  opts = opts || {};
  var st = {
    sent: [],          // {tabId, msg}
    downloads: [],     // 下载调用记录
    session: {},
    listeners: {},
    nextId: 1,
    throwOn: opts.throwOn || [],
    interruptOn: opts.interruptOn || [],
    timerBudget: 400
  };

  function fireChanged(delta) {
    if (st.listeners.downloadChanged) st.listeners.downloadChanged(delta);
  }
  st.fireChanged = fireChanged;

  // 让 onChanged 延后若干宏任务触发，从而给 pollBytes（800ms 轮询）留出至少一次 tick
  var COMPLETE_DELAY = opts.completeDelay == null ? 2 : opts.completeDelay;
  function scheduleChanged(delta, hops) {
    if (hops <= 0) { fireChanged(delta); return; }
    setImmediate(function () { scheduleChanged(delta, hops - 1); });
  }

  st.chrome = {
    downloads: {
      onChanged: { addListener: function (fn) { st.listeners.downloadChanged = fn; } },
      download: function (o) {
        var id = st.nextId++;
        st.downloads.push({ id: id, url: o.url, filename: o.filename, conflictAction: o.conflictAction, saveAs: o.saveAs });
        if (st.throwOn.some(function (s) { return o.url.indexOf(s) !== -1; })) {
          return Promise.reject(new Error('invalid filename or url'));
        }
        setImmediate(function () {
          var bad = st.interruptOn.some(function (s) { return o.url.indexOf(s) !== -1; });
          scheduleChanged(bad
            ? { id: id, state: { current: 'interrupted' }, error: { current: 'SERVER_BAD_CONTENT' } }
            : { id: id, state: { current: 'complete' } }, COMPLETE_DELAY);
        });
        return Promise.resolve(id);
      },
      search: function (q, cb) { cb([{ id: q.id, bytesReceived: 512, totalBytes: 1024 }]); }
    },
    runtime: {
      onMessage: { addListener: function (fn) { st.listeners.message = fn; } },
      onInstalled: { addListener: function (fn) { st.listeners.installed = fn; } },
      getManifest: function () { return { version: '1.0.0' }; },
      lastError: undefined
    },
    storage: {
      session: {
        get: function (k, cb) { var o = {}; o[k] = st.session[k]; cb(o); },
        set: function (o, cb) { Object.keys(o).forEach(function (k) { st.session[k] = o[k]; }); if (cb) cb(); },
        remove: function (k, cb) { delete st.session[k]; if (cb) cb(); }
      },
      local: {
        get: function (k, cb) { cb({}); },
        set: function (o, cb) { if (cb) cb(); }
      },
      onChanged: { addListener: function () {} }
    },
    tabs: {
      sendMessage: function (tabId, msg, cb) {
        st.sent.push({ tabId: tabId, msg: msg });
        if (cb) cb();
      }
    }
  };
  return st;
}

function loadBackground(st) {
  var sandbox = {
    chrome: st.chrome,
    console: console,
    Promise: Promise,
    setTimeout: function (fn, ms) {
      // 20 分钟兜底超时 / 800ms 轮询：用小预算模拟，避免测试挂死
      if (ms >= 20 * 60 * 1000) return 0;
      if (st.timerBudget-- <= 0) return 0;
      setImmediate(fn);
      return 0;
    },
    clearTimeout: function () {},
    setInterval: function () { return 0; }
  };
  var c = vm.createContext(sandbox);
  vm.runInContext(src, c, { filename: SRC });
  return sandbox;
}

function tick(n) {
  var p = Promise.resolve();
  for (var i = 0; i < (n || 5); i++) {
    p = p.then(function () { return new Promise(function (r) { setImmediate(r); }); });
  }
  return p;
}

/** 以指定 tabId 发起一批下载，等待 DL_ALL_DONE */
async function dispatchBatch(st, tabId, tasks, noteId) {
  var before = st.sent.length;
  var resp = null;
  st.listeners.message(
    { type: 'DOWNLOAD_BATCH', payload: { tasks: tasks, noteId: noteId } },
    { tab: { id: tabId } },
    function (r) { resp = r; }
  );
  for (var i = 0; i < 60; i++) {
    await tick(1);
    var done = st.sent.slice(before).some(function (m) {
      return m.tabId === tabId && m.msg.type === 'DL_ALL_DONE';
    });
    if (done) break;
  }
  return { resp: resp, messages: st.sent.slice(before) };
}

function task(name, url, fallbacks, dir) {
  return { kind: 'image', name: name, url: url, dir: dir || 'dir', fallbacks: fallbacks || [] };
}

async function main() {
  H.suite('background — 消息入口与参数校验');

  /* ---- PING ---- */
  var st0 = makeChromeStub();
  loadBackground(st0);
  var r0 = null;
  st0.listeners.message({ type: 'PING' }, { tab: { id: 1 } }, function (r) { r0 = r; });
  eq('BG-1', 'PING 返回版本号', r0 && r0.version, '1.0.0');

  /* ---- 空任务 ---- */
  var r1 = null;
  st0.listeners.message({ type: 'DOWNLOAD_BATCH', payload: { tasks: [] } }, { tab: { id: 1 } }, function (r) { r1 = r; });
  eq('BG-2', '空任务 → error=empty', r1 && r1.error, 'empty');

  /* ---- 无 type 的消息 ---- */
  var ret = st0.listeners.message({}, { tab: { id: 1 } }, function () {});
  eq('BG-3', '无 type 消息返回 false 且不应答', ret, false);

  /* ---- 正常批次 ---- */
  H.suite('background — 正常批次执行');
  var st = makeChromeStub();
  loadBackground(st);
  var res = await dispatchBatch(st, 777, [
    task('1.jpg', 'https://sns-img-qc.xhscdn.com/a'),
    task('2.jpg', 'https://sns-img-qc.xhscdn.com/b'),
    task('3.mp4', 'https://sns-video-hw.xhscdn.com/c')
  ], 'note1');

  eq('BG-4', 'DOWNLOAD_BATCH 立即应答 ok', res.resp && res.resp.ok, true);
  eq('BG-5', 'DOWNLOAD_BATCH 应答含 accepted 数', res.resp && res.resp.accepted, 3);
  eq('BG-6', '实际调用 chrome.downloads.download 3 次', st.downloads.length, 3);
  eq('BG-7', '串行下载顺序与任务顺序一致',
    st.downloads.map(function (d) { return d.url.split('/').pop(); }).join(','), 'a,b,c');
  eq('BG-8', 'conflictAction=uniquify', st.downloads[0].conflictAction, 'uniquify');
  eq('BG-9', 'saveAs=false', st.downloads[0].saveAs, false);
  eq('BG-10', 'filename 使用 buildPath 结果', st.downloads[0].filename, 'dir/1.jpg');

  var types = res.messages.map(function (m) { return m.msg.type; });
  ok('BG-11', '消息序列以 DL_START 开始', types[0] === 'DL_START', 'types=' + types.join(','));
  eq('BG-12', '消息序列以 DL_ALL_DONE 结束', types[types.length - 1], 'DL_ALL_DONE');
  ok('BG-13', '包含 DL_PROGRESS', types.indexOf('DL_PROGRESS') !== -1);

  var allDone = res.messages.filter(function (m) { return m.msg.type === 'DL_ALL_DONE'; })[0];
  eq('BG-14', 'DL_ALL_DONE ok=3', allDone.msg.payload.ok, 3);
  deepEq('BG-15', 'DL_ALL_DONE failed 为空', allDone.msg.payload.failed, []);
  eq('BG-16', 'DL_ALL_DONE total=3', allDone.msg.payload.total, 3);

  /* ---- 进度回传定向 ---- */
  H.suite('background — 进度定向回传 sender.tab.id（切标签页不串台）');
  ok('BG-17', '所有回传消息 tabId 均为发起方 777',
    res.messages.every(function (m) { return m.tabId === 777; }),
    'tabIds=' + JSON.stringify(res.messages.map(function (m) { return m.tabId; })));
  ok('BG-18', '从未向其他 tabId 发送', res.messages.every(function (m) { return m.tabId !== 1; }));

  var st2 = makeChromeStub();
  loadBackground(st2);
  var busyResp = null;
  var p = dispatchBatch(st2, 1001, [task('a.jpg', 'https://sns-img-qc.xhscdn.com/a')], 'n1');
  // 立刻再发一批（模拟用户切标签页后另一页触发）
  await tick(1);
  st2.listeners.message({ type: 'DOWNLOAD_BATCH', payload: { tasks: [task('b.jpg', 'https://sns-img-qc.xhscdn.com/b')] } },
    { tab: { id: 2002 } }, function (r) { busyResp = r; });
  eq('BG-19', '批次进行中时新批次被拒（busy）', busyResp && busyResp.error, 'busy');
  var res2 = await p;
  ok('BG-20', '并发被拒后原批次仍只向 1001 回传',
    res2.messages.every(function (m) { return m.tabId === 1001; }),
    'tabIds=' + JSON.stringify(res2.messages.map(function (m) { return m.tabId; })));
  ok('BG-21', '被拒批次未产生任何下载', st2.downloads.length === 1, 'downloads=' + st2.downloads.length);

  /* ---- 去重 ---- */
  H.suite('background — URL 去重（storage.session）');
  var st3 = makeChromeStub();
  loadBackground(st3);
  var res3a = await dispatchBatch(st3, 5, [task('1.jpg', 'https://x/a'), task('2.jpg', 'https://x/b')], 'n');
  eq('BG-22', '首批下载 2 个', st3.downloads.length, 2);
  ok('BG-23', '去重表写入 session', Array.isArray(st3.session.xhs_dl_done_urls) && st3.session.xhs_dl_done_urls.length === 2,
    'done=' + JSON.stringify(st3.session.xhs_dl_done_urls));

  var res3b = await dispatchBatch(st3, 5, [task('1.jpg', 'https://x/a'), task('2.jpg', 'https://x/b'), task('3.jpg', 'https://x/c')], 'n');
  eq('BG-24', '第二批仅下载未去重的 1 个', st3.downloads.length, 3);
  var skipped = res3b.messages.filter(function (m) { return m.msg.type === 'DL_SKIPPED'; });
  ok('BG-25', '发出 DL_SKIPPED 提示', skipped.length === 1, 'count=' + (skipped[0] && skipped[0].msg.payload.count));
  eq('BG-26', 'DL_SKIPPED count=2', skipped[0].msg.payload.count, 2);
  var start3 = res3b.messages.filter(function (m) { return m.msg.type === 'DL_START'; })[0];
  eq('BG-27', 'DL_START total=3（原始任务数）', start3.msg.payload.total, 3);
  eq('BG-28', 'DL_START pending=1（实际待下）', start3.msg.payload.pending, 1);
  eq('BG-29', 'DL_START skipped=2', start3.msg.payload.skipped, 2);

  /* ---- fallback 重试 ---- */
  H.suite('background — 失败回退到备用直链');
  var st4 = makeChromeStub({ throwOn: ['BAD'] });
  loadBackground(st4);
  var res4 = await dispatchBatch(st4, 9, [
    task('1.jpg', 'https://BAD/x', ['https://sns-img-qc.xhscdn.com/ok1'])
  ], 'n');
  eq('BG-30', '首个直链抛错后尝试备用直链', st4.downloads.length, 2);
  eq('BG-31', '备用直链成功完成', res4.messages.filter(function (m) { return m.msg.type === 'DL_ALL_DONE'; })[0].msg.payload.ok, 1);
  deepEq('BG-32', '无失败项', res4.messages.filter(function (m) { return m.msg.type === 'DL_ALL_DONE'; })[0].msg.payload.failed, []);

  /* ---- interrupted ---- */
  H.suite('background — 中断（interrupted）处理');
  var st5 = makeChromeStub({ interruptOn: ['/bad'] });
  loadBackground(st5);
  var res5 = await dispatchBatch(st5, 9, [
    task('1.jpg', 'https://sns-img-qc.xhscdn.com/bad'),
    task('2.jpg', 'https://sns-img-qc.xhscdn.com/good')
  ], 'n');
  var done5 = res5.messages.filter(function (m) { return m.msg.type === 'DL_ALL_DONE'; })[0];
  eq('BG-33', 'ok=1', done5.msg.payload.ok, 1);
  deepEq('BG-34', 'failed 记录失败文件名', done5.msg.payload.failed, ['1.jpg']);
  eq('BG-35', 'lastError 记录中断原因', done5.msg.payload.lastError, 'SERVER_BAD_CONTENT');
  ok('BG-36', '失败不影响后续任务', st5.downloads.length === 2, 'downloads=' + st5.downloads.length);

  /* ---- CANCEL ---- */
  H.suite('background — 取消批次');
  var st6 = makeChromeStub();
  loadBackground(st6);
  var pc = dispatchBatch(st6, 3, [
    task('1.jpg', 'https://x/1'), task('2.jpg', 'https://x/2'),
    task('3.jpg', 'https://x/3'), task('4.jpg', 'https://x/4')
  ], 'n');
  await tick(1);
  var cancelResp = null;
  st6.listeners.message({ type: 'CANCEL_BATCH' }, { tab: { id: 3 } }, function (r) { cancelResp = r; });
  eq('BG-37', 'CANCEL_BATCH 应答 ok', cancelResp && cancelResp.ok, true);
  var res6 = await pc;
  ok('BG-38', '取消后下载数 < 4（批次被中断）', st6.downloads.length < 4,
    'downloads=' + st6.downloads.length);
  ok('BG-39', '取消后仍发出 DL_ALL_DONE', res6.messages.some(function (m) { return m.msg.type === 'DL_ALL_DONE'; }));

  /* ---- 单文件字节进度 ---- */
  H.suite('background — 单文件字节进度轮询');
  ok('BG-40', '发出 DL_ITEM_PROGRESS 且携带字节百分比',
    res.messages.some(function (m) {
      return m.msg.type === 'DL_ITEM_PROGRESS' && m.msg.payload.pct === 50;
    }),
    'DL_ITEM_PROGRESS 数量=' + res.messages.filter(function (m) { return m.msg.type === 'DL_ITEM_PROGRESS'; }).length);

  /* ---- 安装初始化 ---- */
  H.suite('background — onInstalled 默认设置');
  var st7 = makeChromeStub();
  loadBackground(st7);
  ok('BG-41', 'onInstalled 监听已注册', typeof st7.listeners.installed === 'function');

  /* ---- MV3 Service Worker 回收 —— 静态分析 ---- */
  H.suite('background — MV3 状态持久化静态分析');
  ok('BG-42', 'active 为模块级变量（SW 回收后丢失，见缺陷 D-03）',
    /^var active = null;$/m.test(src), 'active 未落 storage.session');
  ok('BG-43', 'pending Map 为模块级变量（SW 回收后丢失）',
    /^var pending = new Map\(\);$/m.test(src), 'pending 未落 storage.session');
  ok('BG-44', '去重表已落 storage.session（符合 MV3 要求）',
    src.indexOf("chrome.storage.session.get(DONE_KEY") !== -1);

  var S = H.summary('test-background.js');
  process.exit(S.fail ? 1 : 0);
}

main().catch(function (e) {
  console.error('测试运行异常：', e);
  process.exit(2);
});
