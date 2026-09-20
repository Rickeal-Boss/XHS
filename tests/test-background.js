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
/* background.js 未导出 sanitizeSegment / buildPath，这里整段抽取
   「RESERVED_RE 声明 → buildPath 函数结束」的源码区域后求值。
   抽取失败会显式报错，不会静默跳过。 */
var startIdx = src.indexOf('var RESERVED_RE');
if (startIdx === -1) startIdx = src.indexOf('/** Windows 保留设备名');
var bpIdx = src.indexOf('function buildPath');
var endIdx = bpIdx === -1 ? -1 : src.indexOf('\n}', bpIdx);
var region = (startIdx !== -1 && endIdx !== -1) ? src.slice(startIdx, endIdx + 2) : '';

ok('PRE-1', '成功定位 RESERVED_RE 声明', startIdx !== -1);
ok('PRE-2', '成功定位 buildPath 结束位置', endIdx !== -1);
ok('PRE-3', '抽取区域包含 sanitizeSegment', region.indexOf('function sanitizeSegment') !== -1);
ok('PRE-4', '抽取区域包含 buildPath', region.indexOf('function buildPath') !== -1);
ok('PRE-5', '抽取区域包含 MAX_PATH_LEN 与 RESERVED_RE',
  region.indexOf('MAX_PATH_LEN') !== -1 && region.indexOf('RESERVED_RE') !== -1);

var ctx = vm.createContext({ console: console, URL: URL });
vm.runInContext([
  region,
  'this.__sanitizeSegment = sanitizeSegment; this.__buildPath = buildPath; this.__MAX = MAX_PATH_LEN;'
].join('\n'), ctx);
var sanitizeSegment = ctx.__sanitizeSegment;
var buildPath = ctx.__buildPath;
var MAX_PATH_LEN = ctx.__MAX;
eq('PRE-6', 'MAX_PATH_LEN = 180', MAX_PATH_LEN, 180);
ok('PRE-7', 'sanitizeSegment / buildPath 抽取成功',
  typeof sanitizeSegment === 'function' && typeof buildPath === 'function');

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

/* Unicode 形似分隔符 */
eq('SS-30', '全角斜杠 ／ (U+FF0F) → _', sanitizeSegment('a\uFF0Fb'), 'a_b');
eq('SS-31', '全角反斜杠 ＼ (U+FF3C) → _', sanitizeSegment('a\uFF3Cb'), 'a_b');
eq('SS-32', '全角句点 ． (U+FF0E) → _', sanitizeSegment('a\uFF0Eb'), 'a_b');
eq('SS-33', 'one dot leader ․ (U+2024) → _', sanitizeSegment('a\u2024b'), 'a_b');
eq('SS-34', 'division slash ∕ (U+2215) → _', sanitizeSegment('a\u2215b'), 'a_b');
eq('SS-35', 'fraction slash ⁄ (U+2044) → _', sanitizeSegment('a\u2044b'), 'a_b');
eq('SS-36', 'big solidus ⧸ (U+29F8) → _', sanitizeSegment('a\u29F8b'), 'a_b');
eq('SS-37', '中文全角冒号「：」不在拦截集内，保持原样', sanitizeSegment('标题：测试'), '标题：测试');
eq('SS-38', '全角斜杠构造的穿越无法逃逸',
  /[\/\\]/.test(sanitizeSegment('..\uFF0F..\uFF0Fetc')), false);

/* ---------------- buildPath ---------------- */
H.suite('buildPath — 完整路径组装');

eq('BP-1', '无目录', buildPath('', 'a.jpg'), 'a.jpg');
eq('BP-2', '单层目录', buildPath('dir', 'a.jpg'), 'dir/a.jpg');
eq('BP-3', '多层目录', buildPath('a/b/c', 'x.mp4'), 'a/b/c/x.mp4');
eq('BP-4', '空目录段被丢弃', buildPath('a//b/', 'f.jpg'), 'a/b/f.jpg');
eq('BP-5', '全部为空的目录', buildPath('///', 'f.jpg'), 'f.jpg');
eq('BP-6', '目录段清洗为 _ 后被丢弃', buildPath('a/../b', 'f.jpg'), 'a/b/f.jpg');
eq('BP-7', '目录穿越无法逃逸', buildPath('../../etc', 'passwd'), 'etc/passwd');
ok('BP-8', '反斜杠目录穿越无法逃逸（反斜杠被替换为 _，无分隔符残留）',
  buildPath('..\\..\\windows', 'x.txt') === '_.._windows/x.txt',
  'actual=' + buildPath('..\\..\\windows', 'x.txt'));
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
    cancelled: [],     // chrome.downloads.cancel 调用记录（downloadId）
    localWrites: [],   // chrome.storage.local.set 写入记录
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
      search: function (q, cb) { cb([{ id: q.id, bytesReceived: 512, totalBytes: 1024 }]); },
      // 真实 Chrome 里 cancel 会让下载转入 interrupted 状态，桩同样补一次 onChanged
      cancel: function (id, cb) {
        st.cancelled.push(id);
        setImmediate(function () {
          fireChanged({ id: id, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } });
        });
        if (cb) cb();
      }
    },
    runtime: {
      id: 'test-ext-id',
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
        set: function (o, cb) { st.localWrites.push(o); if (cb) cb(); }
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
    URL: URL,               // vm 上下文默认不含 WHATWG URL，必须显式注入
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
async function dispatchBatch(st, tabId, tasks, noteId, senderId) {
  var before = st.sent.length;
  var resp = null;
  st.listeners.message(
    { type: 'DOWNLOAD_BATCH', payload: { tasks: tasks, noteId: noteId } },
    { id: senderId === undefined ? 'test-ext-id' : senderId, tab: { id: tabId } },
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

var HOST = 'https://sns-img-qc.xhscdn.com/';
var VHOST = 'https://sns-video-hw.xhscdn.com/';

async function main() {
  H.suite('background — 消息入口与参数校验');

  /* ---- PING ---- */
  var st0 = makeChromeStub();
  loadBackground(st0);
  var r0 = null;
  st0.listeners.message({ type: 'PING' }, { id: 'test-ext-id', tab: { id: 1 } }, function (r) { r0 = r; });
  eq('BG-1', 'PING 返回版本号', r0 && r0.version, '1.0.0');

  /* ---- 空任务 ---- */
  var r1 = null;
  st0.listeners.message({ type: 'DOWNLOAD_BATCH', payload: { tasks: [] } }, { id: 'test-ext-id', tab: { id: 1 } }, function (r) { r1 = r; });
  eq('BG-2', '空任务 → error=empty', r1 && r1.error, 'empty');

  /* ---- 无 type 的消息 ---- */
  var ret = st0.listeners.message({}, { id: 'test-ext-id', tab: { id: 1 } }, function () {});
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
    { id: 'test-ext-id', tab: { id: 2002 } }, function (r) { busyResp = r; });
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
  var res3a = await dispatchBatch(st3, 5, [task('1.jpg', HOST + 'a'), task('2.jpg', HOST + 'b')], 'n');
  eq('BG-22', '首批下载 2 个', st3.downloads.length, 2);
  ok('BG-23', '去重表写入 session', Array.isArray(st3.session.xhs_dl_done_urls) && st3.session.xhs_dl_done_urls.length === 2,
    'done=' + JSON.stringify(st3.session.xhs_dl_done_urls));

  var res3b = await dispatchBatch(st3, 5, [task('1.jpg', HOST + 'a'), task('2.jpg', HOST + 'b'), task('3.jpg', HOST + 'c')], 'n');
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
    task('1.jpg', HOST + 'BAD/x', [HOST + 'ok1'])
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
    task('1.jpg', HOST + '1'), task('2.jpg', HOST + '2'),
    task('3.jpg', HOST + '3'), task('4.jpg', HOST + '4')
  ], 'n');
  await tick(1);
  var cancelResp = null;
  st6.listeners.message({ type: 'CANCEL_BATCH' }, { id: 'test-ext-id', tab: { id: 3 } }, function (r) { cancelResp = r; });
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

  /* ---- 下载 URL 白名单（纵深防御） ---- */
  H.suite('background — 下载 URL 白名单');
  var st8 = makeChromeStub();
  loadBackground(st8);
  var res8 = await dispatchBatch(st8, 11, [
    task('file.jpg', 'file:///etc/passwd'),
    task('js.jpg', 'javascript:alert(1)'),
    task('data.jpg', 'data:text/html;base64,PHNjcmlwdD4='),
    task('evil.jpg', 'https://evil.example.com/a.jpg'),
    task('ok.jpg', HOST + 'a')
  ], 'n');
  var d8 = res8.messages.filter(function (m) { return m.msg.type === 'DL_ALL_DONE'; })[0];
  eq('BG-45', '仅放行白名单域名的 http(s) URL', st8.downloads.length, 1);
  eq('BG-46', 'file:// 被拒', st8.downloads[0].url, HOST + 'a');
  eq('BG-47', '失败项包含 4 个非法 URL', d8.msg.payload.failed.length, 4);
  ok('BG-48', 'failed 列表含 file.jpg', d8.msg.payload.failed.indexOf('file.jpg') !== -1,
    'failed=' + JSON.stringify(d8.msg.payload.failed));
  eq('BG-49', 'lastError = url-rejected', d8.msg.payload.lastError, 'url-rejected');
  eq('BG-50', 'ok 计数为 1', d8.msg.payload.ok, 1);

  var st9 = makeChromeStub();
  loadBackground(st9);
  var res9 = await dispatchBatch(st9, 12, [
    task('x.jpg', 'https://www.xiaohongshu.com/a.jpg'),
    task('y.jpg', 'https://sns-img-hw.xhscdn.net/b'),
    task('z.jpg', 'https://ci.xiaohongshu.com/c'),
    task('w.jpg', 'https://xhscdn.com/d'),
    task('v.jpg', 'https://notxhscdn.com/e')
  ], 'n');
  eq('BG-51', 'xiaohongshu.com / xhscdn.net / xhscdn.com / ci.xiaohongshu.com 均放行，仿冒域名被拒',
    st9.downloads.length, 4);
  ok('BG-52', '仿冒域名 notxhscdn.com 未通过',
    st9.downloads.every(function (d) { return d.url.indexOf('notxhscdn') === -1; }));

  /* ---- 批次规模上限 ---- */
  H.suite('background — 批次规模上限');
  var st10 = makeChromeStub();
  loadBackground(st10);
  var big = [];
  for (var bi = 0; bi < 301; bi++) big.push(task('f' + bi + '.jpg', HOST + 'f' + bi));
  var bigResp = null;
  st10.listeners.message({ type: 'DOWNLOAD_BATCH', payload: { tasks: big } },
    { id: 'test-ext-id', tab: { id: 13 } }, function (r) { bigResp = r; });
  eq('BG-53', '>300 个任务被拒绝', bigResp && bigResp.error, 'too-many');
  eq('BG-54', '被拒后未产生下载', st10.downloads.length, 0);

  var st11 = makeChromeStub();
  loadBackground(st11);
  var exactly300 = [];
  for (var bi2 = 0; bi2 < 300; bi2++) exactly300.push(task('g' + bi2 + '.jpg', HOST + 'g' + bi2));
  var okResp = null;
  st11.listeners.message({ type: 'DOWNLOAD_BATCH', payload: { tasks: exactly300 } },
    { id: 'test-ext-id', tab: { id: 14 } }, function (r) { okResp = r; });
  eq('BG-55', '恰好 300 个任务被接受', okResp && okResp.accepted, 300);

  /* ---- 消息来源校验 ---- */
  H.suite('background — 消息来源校验');
  var st12 = makeChromeStub();
  loadBackground(st12);
  var foreignResp = null;
  var ret12 = st12.listeners.message({ type: 'DOWNLOAD_BATCH', payload: { tasks: [task('a.jpg', HOST + 'a')] } },
    { id: 'other-extension', tab: { id: 15 } }, function (r) { foreignResp = r; });
  eq('BG-56', '非本扩展来源的消息被丢弃（返回 false）', ret12, false);
  eq('BG-57', '非本扩展来源的消息不应答', foreignResp, null);
  await tick(3);
  eq('BG-58', '非本扩展来源的消息不触发下载', st12.downloads.length, 0);

  var ret13 = st12.listeners.message({ type: 'PING' }, {}, function () {});
  eq('BG-59', '无 sender.id 的消息被丢弃', ret13, false);

  /* ---- 消息里伪造 tabId 不被信任 ---- */
  H.suite('background — 不信任消息内伪造的 tabId');
  var st14 = makeChromeStub();
  loadBackground(st14);
  var res14 = await dispatchBatch(st14, 4242,
    [task('a.jpg', HOST + 'a')], 'n');
  ok('BG-60', '消息内若带 tabId 字段也不被采用（一律用 sender.tab.id）',
    res14.messages.every(function (m) { return m.tabId === 4242; }),
    'tabIds=' + JSON.stringify(res14.messages.map(function (m) { return m.tabId; })));

  /* ---- MV3 Service Worker 回收 —— 静态分析 ---- */
  H.suite('background — MV3 状态持久化静态分析');
  ok('BG-42', 'active 为模块级变量（SW 回收后丢失，见缺陷 D-03）',
    /^var active = null;$/m.test(src), 'active 未落 storage.session');
  ok('BG-43', 'pending Map 为模块级变量（SW 回收后丢失）',
    /^var pending = new Map\(\);$/m.test(src), 'pending 未落 storage.session');
  ok('BG-44', '去重表已落 storage.session（符合 MV3 要求）',
    src.indexOf("chrome.storage.session.get(DONE_KEY") !== -1);

  /* ================================================================== */
  /* MV3 Service Worker 回收 —— 行为验证                                  */
  /* ================================================================== */

  H.suite('background — SW 被回收后的启动自检');
  /* 模拟「上一批执行到一半时 SW 被回收」：session 里残留批次记录。
     startedAt 必须落在新鲜度阈值（60s）之前，才算「真的被中断」——
     刚刚写入的记录会被自检当作可能正在跑的新批次而原样保留（见 F-3）。 */
  var st15 = makeChromeStub();
  st15.session.xhs_dl_batch = {
    tabId: 8888, noteId: 'note-x', startedAt: Date.now() - 120000,
    total: 5, cancelled: false, currentId: null
  };
  loadBackground(st15);
  await tick(4);
  var resume = st15.sent.filter(function (m) { return m.msg.type === 'DL_ALL_DONE'; });
  eq('BG-61', 'SW 启动自检补发一条 DL_ALL_DONE', resume.length, 1);
  eq('BG-62', '补发的 DL_ALL_DONE 发往残留批次记录的 tabId', resume[0].tabId, 8888);
  eq('BG-63', '补发的 DL_ALL_DONE payload.interrupted = true', resume[0].msg.payload.interrupted, true);
  ok('BG-64', '残留的 xhs_dl_batch 已被清除', st15.session.xhs_dl_batch === undefined,
    'batch=' + JSON.stringify(st15.session.xhs_dl_batch));

  var st16 = makeChromeStub();
  loadBackground(st16);
  await tick(4);
  eq('BG-65', '无残留批次时不补发任何消息', st16.sent.length, 0);

  /* ================================================================== */
  /* F-3：启动自检与新一轮 runBatch 的竞态                                */
  /* ================================================================== */
  H.suite('background — F-3 启动自检不得误删新批次标记或误报中断');

  /* 场景 1：残留标记是「刚刚」写入的 —— 很可能是正在跑的新批次。
     自检既不能宣告中断，也不能清掉它的存续标记（否则它若再被 SW 回收，
     下次启动找不到标记，自愈失效、UI 永久 busy）。 */
  var stF = makeChromeStub();
  stF.session.xhs_dl_batch = {
    tabId: 9101, noteId: 'fresh', startedAt: Date.now(),
    total: 3, cancelled: false, currentId: null
  };
  loadBackground(stF);
  await tick(4);
  ok('BG-82', '新批次先 setBatch、自检后跑：新批次的存续标记不被自检清掉',
    !!(stF.session.xhs_dl_batch && stF.session.xhs_dl_batch.tabId === 9101),
    'batch=' + JSON.stringify(stF.session.xhs_dl_batch));
  eq('BG-83', '新批次正在跑时自检不发出 interrupted（不误报）',
    stF.sent.filter(function (m) { return m.msg.type === 'DL_ALL_DONE'; }).length, 0);

  /* 场景 2：阈值内（刚过去 5 秒）仍视为在跑 */
  var stF2 = makeChromeStub();
  stF2.session.xhs_dl_batch = {
    tabId: 9102, noteId: 'fresh2', startedAt: Date.now() - 5000,
    total: 2, cancelled: false, currentId: null
  };
  loadBackground(stF2);
  await tick(4);
  eq('BG-84', '阈值内（刚过去 5s）的批次不宣告中断',
    stF2.sent.filter(function (m) { return m.msg.type === 'DL_ALL_DONE'; }).length, 0);

  /* 场景 3：真正陈旧的残留（> 60s）→ 仍然正常宣告中断并通知（回归保护） */
  var stS = makeChromeStub();
  stS.session.xhs_dl_batch = {
    tabId: 9200, noteId: 'stale', startedAt: Date.now() - 60001,
    total: 7, cancelled: false, currentId: null
  };
  loadBackground(stS);
  await tick(4);
  var staleMsgs = stS.sent.filter(function (m) { return m.msg.type === 'DL_ALL_DONE'; });
  eq('BG-85', '超过 60s 的陈旧残留仍宣告中断', staleMsgs.length, 1);
  ok('BG-86', '陈旧残留通知携带 interrupted=true 且保留 total',
    staleMsgs[0].tabId === 9200 &&
    staleMsgs[0].msg.payload.interrupted === true &&
    staleMsgs[0].msg.payload.total === 7,
    'msg=' + JSON.stringify(staleMsgs[0] && staleMsgs[0].msg));
  ok('BG-87', '陈旧残留的存续标记被清除',
    stS.session.xhs_dl_batch === undefined,
    'batch=' + JSON.stringify(stS.session.xhs_dl_batch));

  /* 场景 4：startedAt 缺失 → 按陈旧处理（保守宣告中断，保持原自愈能力） */
  var stM = makeChromeStub();
  stM.session.xhs_dl_batch = {
    tabId: 9300, noteId: 'nofield', total: 4, cancelled: false, currentId: null
  };
  loadBackground(stM);
  await tick(4);
  var mMsgs = stM.sent.filter(function (m) { return m.msg.type === 'DL_ALL_DONE'; });
  ok('BG-88', 'startedAt 缺失时按陈旧处理：宣告中断并清除标记',
    mMsgs.length === 1 && mMsgs[0].msg.payload.interrupted === true &&
    stM.session.xhs_dl_batch === undefined,
    'msgs=' + mMsgs.length + ' batch=' + JSON.stringify(stM.session.xhs_dl_batch));

  /* 场景 5：自检只执行一次 —— 后续批次不会重复 notify */
  var stOnce = makeChromeStub();
  stOnce.session.xhs_dl_batch = {
    tabId: 9400, noteId: 'once', startedAt: Date.now() - 120000,
    total: 1, cancelled: false, currentId: null
  };
  loadBackground(stOnce);
  await tick(4);
  eq('BG-89', '自检只执行一次（启动时恰好 1 条 interrupted）',
    stOnce.sent.filter(function (m) {
      return m.msg.type === 'DL_ALL_DONE' && m.msg.payload.interrupted;
    }).length, 1);
  await dispatchBatch(stOnce, 9401, [task('a.jpg', HOST + 'a')], 'n');
  eq('BG-90', '后续批次不会再次触发自检 notify',
    stOnce.sent.filter(function (m) {
      return m.msg.type === 'DL_ALL_DONE' && m.msg.payload.interrupted;
    }).length, 1);

  /* 场景 6：runBatch 确实先等待自检 —— 残留中断通知早于新批次的 DL_ALL_DONE */
  var stOrder = makeChromeStub();
  stOrder.session.xhs_dl_batch = {
    tabId: 9500, noteId: 'prev', startedAt: Date.now() - 120000,
    total: 2, cancelled: false, currentId: null
  };
  loadBackground(stOrder);
  await dispatchBatch(stOrder, 9501, [task('a.jpg', HOST + 'a')], 'n');
  var iIdx = -1, dIdx = -1;
  stOrder.sent.forEach(function (m, i) {
    if (m.msg.type !== 'DL_ALL_DONE') return;
    if (m.tabId === 9500 && iIdx === -1) iIdx = i;
    if (m.tabId === 9501 && dIdx === -1) dIdx = i;
  });
  ok('BG-91', 'runBatch 先等自检：残留中断通知早于新批次的 DL_ALL_DONE',
    iIdx !== -1 && dIdx !== -1 && iIdx < dIdx,
    'interrupted@' + iIdx + ' batchDone@' + dIdx);
  eq('BG-92', '等待自检不影响新批次正常完成',
    stOrder.sent.filter(function (m) {
      return m.msg.type === 'DL_ALL_DONE' && m.tabId === 9501;
    })[0].msg.payload.ok, 1);

  H.suite('background — 批次存续标记的写入与清理');
  var st17 = makeChromeStub({ completeDelay: 10 });
  loadBackground(st17);
  var p17 = dispatchBatch(st17, 21, [
    task('1.jpg', HOST + 'a'),
    task('2.jpg', HOST + 'b')
  ], 'note17');
  await tick(2);
  ok('BG-66', '批次执行中 session 里存在 xhs_dl_batch 且 tabId 正确',
    !!(st17.session.xhs_dl_batch && st17.session.xhs_dl_batch.tabId === 21),
    'batch=' + JSON.stringify(st17.session.xhs_dl_batch));
  var res17 = await p17;
  ok('BG-67', '批次正常结束后 session 里不再有 xhs_dl_batch',
    st17.session.xhs_dl_batch === undefined,
    'batch=' + JSON.stringify(st17.session.xhs_dl_batch));
  var done17 = res17.messages.filter(function (m) { return m.msg.type === 'DL_ALL_DONE'; });
  ok('BG-68', '批次正常结束且 DL_ALL_DONE 不带 interrupted 标记',
    done17.length === 1 && done17[0].msg.payload.interrupted === undefined,
    'DL_ALL_DONE 数量=' + done17.length);

  H.suite('background — 取消真正中断当前文件');
  var st18 = makeChromeStub({ completeDelay: 30 });
  loadBackground(st18);
  var p18 = dispatchBatch(st18, 31, [
    task('1.jpg', HOST + '1'), task('2.jpg', HOST + '2'),
    task('3.jpg', HOST + '3'), task('4.jpg', HOST + '4')
  ], 'note18');
  await tick(4);
  st18.listeners.message({ type: 'CANCEL_BATCH' }, { id: 'test-ext-id', tab: { id: 31 } }, function () {});
  await tick(3);
  ok('BG-69', 'CANCEL_BATCH 对当前 downloadId 调用 chrome.downloads.cancel',
    st18.cancelled.length >= 1 && st18.cancelled[0] === st18.downloads[0].id,
    'cancelled=' + JSON.stringify(st18.cancelled) +
    ' downloads=' + JSON.stringify(st18.downloads.map(function (d) { return d.id; })));
  ok('BG-70', '未调用 chrome.downloads.erase（保留文件以便用户找回）',
    src.indexOf('chrome.downloads.erase(') === -1);
  var res18 = await p18;
  ok('BG-71', '取消后仍发出 DL_ALL_DONE',
    res18.messages.some(function (m) { return m.msg.type === 'DL_ALL_DONE'; }));
  ok('BG-72', '取消后不再继续下载后续任务', st18.downloads.length < 4,
    'downloads=' + st18.downloads.length);
  ok('BG-73', '取消后 session 里的 xhs_dl_batch 被清理',
    st18.session.xhs_dl_batch === undefined,
    'batch=' + JSON.stringify(st18.session.xhs_dl_batch));

  H.suite('background — 去重按主直链记录（fallback 后不再重复下载）');
  var st19 = makeChromeStub({ throwOn: ['/BAD'] });
  loadBackground(st19);
  var main19 = HOST + 'BAD/x';
  var fb19 = HOST + 'ok1';
  var res19 = await dispatchBatch(st19, 41, [task('1.jpg', main19, [fb19])], 'note19');
  var dl19 = st19.session.xhs_dl_done_urls || [];
  ok('BG-74', 'fallback 成功后主直链也被写入去重表', dl19.indexOf(main19) !== -1,
    'done=' + JSON.stringify(dl19));
  ok('BG-75', '实际成功的备用直链同样在去重表里', dl19.indexOf(fb19) !== -1,
    'done=' + JSON.stringify(dl19));
  eq('BG-76', '主直链失败 + fallback 成功，本批 ok=1',
    res19.messages.filter(function (m) { return m.msg.type === 'DL_ALL_DONE'; })[0].msg.payload.ok, 1);

  var before19 = st19.downloads.length;
  var res19b = await dispatchBatch(st19, 41, [task('1.jpg', main19, [fb19])], 'note19');
  eq('BG-77', '重跑同一任务时被去重跳过，不再发起任何下载',
    st19.downloads.length, before19);
  eq('BG-78', '重跑时 DL_SKIPPED count=1',
    res19b.messages.filter(function (m) { return m.msg.type === 'DL_SKIPPED'; })[0].msg.payload.count, 1);

  H.suite('background — onInstalled 默认设置与其它入口对齐');
  var st20 = makeChromeStub();
  loadBackground(st20);
  st20.listeners.installed();
  var def20 = (st20.localWrites[0] && st20.localWrites[0].xhs_settings) || {};
  eq('BG-79', '默认设置含 streamPreference=compat', def20.streamPreference, 'compat');
  ok('BG-80', '默认设置不再包含死字段 useTimeInName', !('useTimeInName' in def20),
    'keys=' + Object.keys(def20).join(','));

  /* 与 options.js 的 DEFAULTS 做字段集比对：两份默认值必须完全一致 */
  var optSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'options', 'options.js'), 'utf8');
  var dStart = optSrc.indexOf('var DEFAULTS = {');
  var dEnd = dStart === -1 ? -1 : optSrc.indexOf('\n  };', dStart);
  var optDefaults = null;
  if (dStart !== -1 && dEnd !== -1) {
    var objText = optSrc.slice(dStart + 'var DEFAULTS = '.length, dEnd + 4);
    try { optDefaults = vm.runInNewContext('(' + objText + ')'); } catch (e) { optDefaults = null; }
  }
  ok('BG-81', '默认设置字段集与 options.js DEFAULTS 完全一致',
    optDefaults !== null &&
    Object.keys(optDefaults).sort().join(',') === Object.keys(def20).sort().join(','),
    'options=' + (optDefaults && Object.keys(optDefaults).sort().join(',')) +
    ' | background=' + Object.keys(def20).sort().join(','));

  var S = H.summary('test-background.js');
  process.exit(S.fail ? 1 : 0);
}

main().catch(function (e) {
  console.error('测试运行异常：', e);
  process.exit(2);
});
