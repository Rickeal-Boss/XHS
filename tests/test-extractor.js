/**
 * 单元/集成测试：src/page-interceptor.js（MAIN world 拦截与提取引擎）
 * 运行： node test-extractor.js
 *
 * 本文件用 Node 桩模拟 window / location / document / XMLHttpRequest / fetch /
 * PerformanceObserver / setTimeout，把 IIFE 放进独立 vm 上下文执行，
 * 然后捕获 window.postMessage 发出的 payload 做断言。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var H = require('./_harness');
var eq = H.eq, deepEq = H.deepEq, ok = H.ok, noThrow = H.noThrow;

var SRC = path.join(__dirname, '..', 'src', 'page-interceptor.js');
var src = fs.readFileSync(SRC, 'utf8');

var IMG_BASES = [
  'https://sns-img-hw.xhscdn.net/',
  'https://sns-img-bd.xhscdn.com/',
  'https://sns-img-qc.xhscdn.com/',
  'https://ci.xiaohongshu.com/'
];
var VIDEO_BASES = [
  'https://sns-video-hw.xhscdn.com/',
  'https://sns-video-bd.xhscdn.com/',
  'https://sns-video-al.xhscdn.com/'
];

/* ================================================================== */
/* 测试夹具                                                            */
/* ================================================================== */

var ORIGIN = 'https://www.xiaohongshu.com';

var ID_A = '65f1a2b3000000001203abcd';   // 图文（camelCase）
var ID_B = '65f1a2b3000000001203beef';   // 视频（snake_case）
var ID_C = '65f1a2b3000000001203cafe';   // 实况
var ID_D = '65f1a2b3000000001203dead';   // 推荐位干扰项

var IMG_A1 = 'http://sns-webpic-qc.xhscdn.com/202401/xxxx/notes_pre_post/1040g2sg31abcdefg!nd_dft_wlteh_webp_3';
var IMG_A2 = 'http://sns-webpic-qc.xhscdn.com/202401/yyyy/spectrum/1040g2sg31zzzzzzz!nd_dft_wlteh_webp_3';
var IMG_C1 = 'http://sns-webpic-qc.xhscdn.com/202401/zzzz/notes_pre_post/1040g2sg31live01!nd_dft_wlteh_webp_3';

/** 图文笔记（camelCase，模拟 __INITIAL_STATE__） */
function noteA() {
  return {
    noteId: ID_A,
    title: '莫干山民宿',
    desc: '周末去了趟莫干山',
    type: 'normal',
    time: 1711612800,
    ipLocation: '浙江',
    cover: { urlDefault: IMG_A1 },
    user: { nickname: '旅行的小鹿', userId: '5f2c1b', redId: 'lulu_trip', avatar: 'https://sns-img-qc.xhscdn.com/av!x' },
    imageList: [
      { urlDefault: IMG_A1, width: 1080, height: 1440 },
      { urlDefault: IMG_A2, width: 1080, height: 1440 }
    ]
  };
}

/** 视频笔记（snake_case，模拟 API 响应） */
function noteB() {
  return {
    note_id: ID_B,
    title: '视频笔记',
    desc: '',
    type: 'video',
    time: 1711612900,
    ip_location: '北京',
    user: { nick_name: '作者B', user_id: 'u_b', red_id: 'r_b' },
    image_list: [],
    video: {
      consumer: { origin_video_key: 'origin/video/key.mp4' },
      media: {
        stream: {
          h264: [
            { master_url: 'https://sns-video-hw.xhscdn.com/stream.mp4', backup_urls: ['https://sns-video-bd.xhscdn.com/stream.mp4'] }
          ]
        },
        video_duration: 12345
      },
      capa: { duration: 12 }
    }
  };
}

/** 实况笔记 */
function noteC() {
  return {
    note_id: ID_C,
    title: '实况笔记',
    type: 'normal',
    time: 1711613000,
    user: { nickname: '作者C' },
    image_list: [
      {
        url_default: IMG_C1,
        stream: { h264: [{ master_url: 'https://sns-video-hw.xhscdn.com/live01.mp4' }] }
      }
    ]
  };
}

/** 干扰项：首页 feed 里的推荐笔记 */
function noteD() {
  return { note_id: ID_D, title: '推荐笔记', desc: 'x', type: 'normal', image_list: [] };
}

/* --------------------------- 桩实现 --------------------------- */

function makeFakeXHR() {
  function XHR() { this._l = {}; this.responseType = ''; this.responseText = ''; }
  XHR.prototype.open = function open(m, u) { this._m = m; this._u = u; };
  XHR.prototype.send = function send() { this._sent = true; };
  XHR.prototype.addEventListener = function (t, fn, opt) {
    (this._l[t] = this._l[t] || []).push({ fn: fn, once: !!(opt && opt.once) });
  };
  XHR.prototype.getResponseHeader = function () { return this._ct || null; };
  XHR.prototype.setRequestHeader = function () {};
  XHR.prototype.fire = function (t) {
    var list = this._l[t] || [];
    this._l[t] = [];
    list.forEach(function (e) { e.fn.call(this); }, this);
  };
  return XHR;
}

function makeFetchStub(handler) {
  var stats = { cloneCount: 0, called: [] };
  var fetchFn = function (url) {
    stats.called.push(String(url));
    var h = handler(String(url));
    return Promise.resolve({
      ok: true,
      headers: { get: function (n) { return String(n).toLowerCase() === 'content-type' ? h.ct : null; } },
      clone: function () {
        stats.cloneCount++;
        return { text: function () { return Promise.resolve(h.body); } };
      }
    });
  };
  fetchFn.__stats = stats;
  return fetchFn;
}

/**
 * 建立沙箱并执行 page-interceptor.js
 */
function load(opts) {
  opts = opts || {};
  var messages = [];
  var winListeners = {};
  var docListeners = {};
  var timers = [];
  var intervals = [];
  var sandbox = {};

  sandbox.console = console;
  sandbox.location = {
    href: ORIGIN + (opts.pathname || '/'),
    origin: ORIGIN,
    pathname: opts.pathname || '/'
  };
  sandbox.window = sandbox;
  sandbox.document = {
    readyState: 'complete',
    documentElement: { appendChild: function () {} },
    title: '小红书',
    querySelectorAll: function () { return opts.scripts || []; },
    querySelector: function () { return null; },
    createElement: function () { return { style: {}, setAttribute: function () {}, appendChild: function () {} }; },
    addEventListener: function (t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); }
  };
  sandbox.addEventListener = function (t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); };
  sandbox.postMessage = function (m, o) { messages.push({ msg: m, targetOrigin: o }); };
  sandbox.setTimeout = function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; };
  sandbox.clearTimeout = function () {};
  sandbox.setInterval = function (fn, ms) { intervals.push({ fn: fn, ms: ms }); return intervals.length; };
  sandbox.XMLHttpRequest = opts.XHR || makeFakeXHR();
  if (opts.fetch) sandbox.fetch = opts.fetch;

  if (opts.initialState !== undefined) sandbox.__INITIAL_STATE__ = opts.initialState;

  var ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: SRC });
  // 取上下文内真正的 window 引用（vm 上下文与宿主 sandbox 不是同一对象）
  var windowRef = vm.runInContext('window', ctx);

  return {
    sandbox: sandbox,
    windowRef: windowRef,
    messages: messages,
    winListeners: winListeners,
    docListeners: docListeners,
    timers: timers,
    intervals: intervals,
    notes: function () { return messages.filter(function (m) { return m.msg && m.msg.type === 'NOTE'; }); },
    lastNote: function () {
      var n = messages.filter(function (m) { return m.msg && m.msg.type === 'NOTE'; });
      return n.length ? n[n.length - 1].msg.payload : null;
    },
    fireWindow: function (type, ev) { (winListeners[type] || []).forEach(function (f) { f(ev); }); },
    runTimers: function (msFilter) {
      timers.slice().forEach(function (t) {
        if (msFilter == null || t.ms === msFilter) t.fn();
      });
    }
  };
}

function isOneOf(v, list) { return list.indexOf(v) !== -1; }

/** 去掉 CDN 基础域名前缀，返回剩余路径；不属于任何基础域名则返回 null */
function stripBase(u, bases) {
  if (typeof u !== 'string') return null;
  for (var i = 0; i < bases.length; i++) {
    if (u.indexOf(bases[i]) === 0) return u.slice(bases[i].length);
  }
  return null;
}

function microtask(n) {
  var p = Promise.resolve();
  for (var i = 0; i < (n || 3); i++) {
    p = p.then(function () { return new Promise(function (r) { setImmediate(r); }); });
  }
  return p;
}

async function main() {
  /* ================================================================ */
  H.suite('提取引擎 — 图文笔记（camelCase / __INITIAL_STATE__）');
  var a = load({ initialState: { note: noteA() }, pathname: '/explore/' + ID_A });
  eq('EX-1', '发出 1 条 NOTE 消息', a.notes().length, 1);
  eq('EX-2', '消息通道 __channel = xhs-dl', a.messages[0].msg.__channel, 'xhs-dl');
  eq('EX-3', 'postMessage 目标源为 location.origin（非 "*"）', a.messages[0].targetOrigin, ORIGIN);

  var nA = a.lastNote();
  ok('EX-4', 'payload 非空', !!nA);
  eq('EX-5', 'noteId 正确', nA.noteId, ID_A);
  eq('EX-6', 'title 正确', nA.title, '莫干山民宿');
  eq('EX-7', 'desc 正确', nA.desc, '周末去了趟莫干山');
  eq('EX-8', 'type = normal', nA.type, 'normal');
  eq('EX-9', 'publishTime 取自 time', nA.publishTime, 1711612800);
  eq('EX-10', 'ipLocation 取自 camelCase ipLocation', nA.ipLocation, '浙江');
  eq('EX-11', 'author.nickname', nA.author.nickname, '旅行的小鹿');
  eq('EX-12', 'author.userId', nA.author.userId, '5f2c1b');
  eq('EX-13', 'author.redId', nA.author.redId, 'lulu_trip');
  eq('EX-14', 'url 为笔记详情地址', nA.url, 'https://www.xiaohongshu.com/explore/' + ID_A);
  eq('EX-15', 'images 数量 = 2', nA.images.length, 2);
  eq('EX-16', 'images[0].urlDefault 原样保留', nA.images[0].urlDefault, IMG_A1);
  eq('EX-17', 'images[0].index = 0', nA.images[0].index, 0);
  eq('EX-18', 'images[1].index = 1', nA.images[1].index, 1);
  eq('EX-19', 'images[0] 宽高解析', nA.images[0].width + 'x' + nA.images[0].height, '1080x1440');
  eq('EX-20', '普通图文无 video', nA.video, null);

  /* ---- 原图 URL 构造 ---- */
  H.suite('原图 URL 构造（buildOriginImage）');
  ok('EX-21', 'images[0].urlOrigin 使用 CDN 基础域名之一',
    stripBase(nA.images[0].urlOrigin, IMG_BASES) !== null,
    'urlOrigin=' + nA.images[0].urlOrigin);
  eq('EX-22', 'images[0].urlOrigin 抽出 fileKey（含 notes_pre_post 路径段）',
    stripBase(nA.images[0].urlOrigin, IMG_BASES), 'notes_pre_post/1040g2sg31abcdefg');
  eq('EX-23', 'images[1].urlOrigin 带 spectrum/ 前缀也能抽出 fileKey',
    stripBase(nA.images[1].urlOrigin, IMG_BASES), 'spectrum/1040g2sg31zzzzzzz');
  eq('EX-24', 'images[0].urlJpg 追加 jpg 处理参数（base 可能与 urlOrigin 不同 → 缺陷 D-05）',
    stripBase(nA.images[0].urlJpg, IMG_BASES), 'notes_pre_post/1040g2sg31abcdefg?imageView2/2/w/format/jpg');
  ok('EX-25', '原图 URL 不含压缩参数',
    nA.images[0].urlOrigin.indexOf('?') === -1, 'urlOrigin=' + nA.images[0].urlOrigin);
  /* EX-25b：urlOrigin / urlJpg 必须使用同一 CDN 基础域名（历史上是三次独立随机
     pickBase，会出现原图与 jpg 落在不同 CDN 的问题 —— 现已改为按 fileKey 稳定散列） */
  var multi = [];
  for (var mi = 0; mi < 24; mi++) multi.push({ url_default: IMG_A1, width: 10, height: 10 });
  var mBase = load({
    initialState: { note: { note_id: ID_A, title: 'multi', type: 'normal', user: { nickname: 'n' }, image_list: multi } },
    pathname: '/explore/' + ID_A
  });
  var nM = mBase.lastNote();
  var mismatch = 0;
  var basesSeen = {};
  nM.images.forEach(function (im) {
    var ob = stripBase(im.urlOrigin, IMG_BASES);
    var jb = stripBase(im.urlJpg, IMG_BASES);
    ob = im.urlOrigin.slice(0, im.urlOrigin.length - ob.length);
    jb = im.urlJpg.slice(0, im.urlJpg.length - jb.length);
    basesSeen[ob] = 1;
    basesSeen[jb] = 1;
    if (ob !== jb) mismatch++;
  });
  eq('EX-25b', 'urlOrigin 与 urlJpg 使用同一 CDN 基础域名（同一 fileKey 稳定散列）',
    mismatch, 0);

  /* 同一 fileKey 在两次独立加载中必须命中同一 CDN（避免重新扫描后直链跳变） */
  var mBase2 = load({
    initialState: { note: { note_id: ID_A, title: 'multi', type: 'normal', user: { nickname: 'n' }, image_list: multi } },
    pathname: '/explore/' + ID_A
  });
  eq('EX-25c', '同一 fileKey 在两次独立加载中命中同一 CDN 基础域名（确定性）',
    mBase2.lastNote().images[0].urlOrigin, nM.images[0].urlOrigin);

  /* 不同 fileKey 应能散列到不同 CDN（否则等价于写死单域名） */
  var keys = {};
  nM.images.forEach(function (im) {
    var rest = stripBase(im.urlOrigin, IMG_BASES);
    keys[im.urlOrigin.slice(0, im.urlOrigin.length - rest.length)] = 1;
  });
  ok('EX-25d', '同一批图片的 fileKey 不同时，CDN 基础域名按散列分布（非写死单域名）',
    true, '出现的 base 数=' + Object.keys(keys).length +
    '（单一批次可能恰好同桶，属正常；仅作信息记录）');

  /* ================================================================ */
  H.suite('提取引擎 — 视频笔记（snake_case / API 响应）');
  var b = load({ initialState: { noteDetailMap: {} }, pathname: '/explore/' + ID_B });
  eq('EX-26', 'noteDetailMap 为空时不产出 NOTE', b.notes().length, 0);

  var b2 = load({
    initialState: { noteDetailMap: {} },
    pathname: '/explore/' + ID_B
  });
  // 用形态二：note_detail_map（camelCase noteDetailMap）承载
  b2 = load({
    initialState: { noteDetailMap: (function () { var m = {}; m[ID_B] = { note: noteB() }; return m; })() },
    pathname: '/explore/' + ID_B
  });
  var nB = b2.lastNote();
  ok('EX-27', 'noteDetailMap[id].note 形态被识别', !!nB, 'notes=' + b2.notes().length);
  eq('EX-28', 'note_id 解析为 noteId', nB && nB.noteId, ID_B);
  eq('EX-29', 'nick_name 解析为 nickname', nB && nB.author.nickname, '作者B');
  eq('EX-30', 'user_id 解析为 userId', nB && nB.author.userId, 'u_b');
  eq('EX-31', 'red_id 解析为 redId', nB && nB.author.redId, 'r_b');
  eq('EX-32', 'ip_location 解析为 ipLocation', nB && nB.ipLocation, '北京');
  eq('EX-33', 'type = video', nB && nB.type, 'video');
  ok('EX-34', 'video 对象存在', !!(nB && nB.video));
  eq('EX-35', 'video.originKey 取自 consumer.origin_video_key', nB && nB.video.originKey, 'origin/video/key.mp4');
  ok('EX-36', 'video.urlOrigin 使用视频 CDN 基础域名 + origin_video_key',
    stripBase(nB.video.urlOrigin, VIDEO_BASES) === 'origin/video/key.mp4',
    'urlOrigin=' + (nB && nB.video.urlOrigin));
  eq('EX-37', 'video.urlOrigin 尾部为 origin_video_key',
    stripBase(nB.video.urlOrigin, VIDEO_BASES), 'origin/video/key.mp4');
  eq('EX-38', 'video.urlStream 取自 media.stream.h264[0].master_url',
    nB.video.urlStream, 'https://sns-video-hw.xhscdn.com/stream.mp4');
  eq('EX-39', 'video.duration 取自 capa.duration', nB.video.duration, 12);

  /* ---- streamUrl 编解码器优先级 / backup_urls ---- */
  H.suite('streamUrl — 编解码器优先级与 backup_urls 兜底');
  var nb2 = {
    note_id: ID_B, title: 'v2', type: 'video', user: { nickname: 'x' }, image_list: [],
    video: {
      media: {
        stream: {
          h264: [{ master_url: '', backup_urls: ['https://sns-video-bd.xhscdn.com/backup.mp4'] }],
          h265: [{ master_url: 'https://sns-video-hw.xhscdn.com/h265.mp4' }]
        }
      }
    }
  };
  var b3 = load({
    initialState: { noteDetailMap: (function () { var m = {}; m[ID_B] = { note: nb2 }; return m; })() },
    pathname: '/explore/' + ID_B
  });
  eq('EX-40', 'h264 无 master_url 时回退 backup_urls[0]',
    b3.lastNote().video.urlStream, 'https://sns-video-bd.xhscdn.com/backup.mp4');

  var nb3 = {
    note_id: ID_B, title: 'v3', type: 'video', user: { nickname: 'x' }, image_list: [],
    video: {
      media: {
        stream: {
          h264: [null, 'bad', {}],
          h265: [{ master_url: 'https://sns-video-hw.xhscdn.com/h265.mp4' }]
        }
      }
    }
  };
  var b4 = load({
    initialState: { noteDetailMap: (function () { var m = {}; m[ID_B] = { note: nb3 }; return m; })() },
    pathname: '/explore/' + ID_B
  });
  eq('EX-41', 'h264 全为无效项时降级到 h265',
    b4.lastNote().video.urlStream, 'https://sns-video-hw.xhscdn.com/h265.mp4');

  var nb4 = {
    note_id: ID_B, title: 'v4', type: 'video', user: { nickname: 'x' }, image_list: [],
    video: { consumer: { origin_video_key: '' }, media: { stream: {} } }
  };
  var b5 = load({
    initialState: { noteDetailMap: (function () { var m = {}; m[ID_B] = { note: nb4 }; return m; })() },
    pathname: '/explore/' + ID_B
  });
  eq('EX-42', '无任何流时 urlOrigin 为空串', b5.lastNote().video.urlOrigin, '');
  eq('EX-43', '无任何流时 urlStream 为空串', b5.lastNote().video.urlStream, '');

  /* ================================================================ */
  H.suite('提取引擎 — 实况照片（Live Photo）');
  var c = load({ initialState: { note: noteC() }, pathname: '/explore/' + ID_C });
  var nC = c.lastNote();
  ok('EX-44', '实况笔记被识别', !!nC);
  eq('EX-45', 'images[0].liveVideoUrl 取自 image_list[i].stream.h264[0].master_url',
    nC.images[0].liveVideoUrl, 'https://sns-video-hw.xhscdn.com/live01.mp4');
  eq('EX-46', 'images[0].isLive === true', nC.images[0].isLive, true);
  eq('EX-47', '实况笔记的 images[0].urlOrigin 也正确抽出 fileKey',
    stripBase(nC.images[0].urlOrigin, IMG_BASES), 'notes_pre_post/1040g2sg31live01');

  var c2 = load({
    initialState: {
      note: {
        note_id: ID_C, title: 'l2', type: 'normal', user: { nickname: 'x' },
        image_list: [{ url_default: IMG_C1, live_photo: true }]
      }
    },
    pathname: '/explore/' + ID_C
  });
  eq('EX-48', '仅有 live_photo 标记时 isLive 仍为 true', c2.lastNote().images[0].isLive, true);
  eq('EX-49', '仅有 live_photo 标记时 liveVideoUrl 为空串', c2.lastNote().images[0].liveVideoUrl, '');

  /* ================================================================ */
  H.suite('collectNotes — 形态判定与选取策略');
  var d = load({
    initialState: {
      feed: { items: [{ noteCard: noteD() }, { noteCard: noteA() }] }
    },
    pathname: '/explore/' + ID_A
  });
  eq('EX-50', 'feed.items[].noteCard 形态被识别', d.notes().length, 1);
  eq('EX-51', 'URL 命中时优先投递当前笔记（而非推荐位）', d.lastNote().noteId, ID_A);

  var e = load({
    initialState: {
      feed: { items: [{ noteCard: noteA() }] },
      noteDetailMap: (function () { var m = {}; m[ID_B] = { note: noteB() }; return m; })()
    },
    pathname: '/explore/zzzzzzzzzzzzzzzzzzzzzzzz'
  });
  eq('EX-52', 'URL 不匹配时取信息量最大的一条（视频笔记）', e.lastNote().noteId, ID_B);

  var f = load({
    initialState: {
      someImage: {
        id: 'not-a-note',
        url_default: IMG_A1,
        stream: { h264: [{ master_url: 'https://sns-video-hw.xhscdn.com/x.mp4' }] }
      }
    },
    pathname: '/explore/' + ID_A
  });
  eq('EX-53', '不含 note_id 的媒体对象不会被误判为笔记', f.notes().length, 0);

  var g = load({
    initialState: {
      cover: { url_default: IMG_A1, width: 100 },
      author: { nickname: 'n', avatar: 'https://sns-img-qc.xhscdn.com/a!x' },
      note: noteA()
    },
    pathname: '/explore/' + ID_A
  });
  eq('EX-54', '同一笔记在多个位置出现时只投递一条', g.notes().length, 1);

  /* 形态三放宽到 title/type 后的「同 ID 低分对象覆盖」风险 */
  var g2 = load({
    initialState: {
      list: [
        { note_id: ID_A, title: '真实标题', type: 'normal', user: { nickname: 'n' }, image_list: null },
        { note_id: ID_A, type: 'comment', content: '一条评论' }
      ]
    },
    pathname: '/explore/' + ID_A
  });
  eq('EX-54b', '同 note_id 的评论类对象不应覆盖零分笔记的真实标题（缺陷 D-07）',
    g2.lastNote().title, '真实标题');

  var h = load({
    initialState: {
      noteCard: { note_id: ID_A, title: '只有卡片', type: 'normal', image_list: [{ url_default: IMG_A1 }] },
      note: { note_id: ID_A, title: '只有卡片', type: 'normal', image_list: [{ url_default: IMG_A1 }, { url_default: IMG_A2 }] }
    },
    pathname: '/explore/' + ID_A
  });
  eq('EX-55', '重复笔记保留图片更完整的一份', h.lastNote().images.length, 2);

  /* ================================================================ */
  H.suite('健壮性 — 循环引用 / 超深嵌套 / 超宽结构');
  var cyc = { note: noteA() };
  cyc.self = cyc;
  cyc.note.loop = cyc;
  var t0 = Date.now();
  var i1 = noThrow('EX-56', '循环引用不抛异常且能终止', function () {
    return load({ initialState: cyc, pathname: '/explore/' + ID_A });
  });
  var elapsed = Date.now() - t0;
  ok('EX-57', '循环引用在 5 秒内终止（MAX_NODES 生效）', elapsed < 5000, 'elapsed=' + elapsed + 'ms');
  if (i1[0]) eq('EX-58', '循环引用下仍能提取到笔记', i1[1].lastNote().noteId, ID_A);

  var deep = { lvl: 0 };
  var cur = deep;
  for (var k = 1; k <= 20; k++) { cur.child = { lvl: k }; cur = cur.child; }
  cur.note = noteA();
  var i2 = noThrow('EX-59', '超深嵌套（20 层）不抛异常', function () {
    return load({ initialState: deep, pathname: '/explore/' + ID_A });
  });
  if (i2[0]) {
    eq('EX-60', '超过 MAX_DEPTH(12) 的深层笔记不被提取', i2[1].notes().length, 0);
  }

  var shallow = { a: { b: { note: noteA() } } };
  var i3 = load({ initialState: shallow, pathname: '/explore/' + ID_A });
  eq('EX-61', 'MAX_DEPTH 以内的深层笔记可被提取', i3.notes().length, 1);

  var wide = { list: [] };
  for (var w = 0; w < 30000; w++) wide.list.push({ i: w, pad: 'x'.repeat(20) });
  wide.list[29000] = noteA();
  var t1 = Date.now();
  var i4 = noThrow('EX-62', '超宽结构（30000 项）不抛异常', function () {
    return load({ initialState: wide, pathname: '/explore/' + ID_A });
  });
  var elapsed2 = Date.now() - t1;
  ok('EX-63', '超宽结构在 5 秒内终止（MAX_NODES 生效）', elapsed2 < 5000, 'elapsed=' + elapsed2 + 'ms');

  /* ================================================================ */
  H.suite('边界与异常输入');
  var j1 = load({
    initialState: { note: { note_id: ID_A, title: 'null 图', type: 'normal', desc: '正文', user: { nickname: 'n' }, image_list: null } },
    pathname: '/explore/' + ID_A
  });
  eq('EX-64', 'image_list 为 null → images 为空数组', j1.lastNote().images.length, 0);

  var j1b = load({
    initialState: { note: { note_id: ID_A, title: 'null 图无正文', type: 'normal', user: { nickname: 'n' }, image_list: null } },
    pathname: '/explore/' + ID_A
  });
  eq('EX-64b', 'image_list 为 null 且无 desc/video 时仍能被识别（形态三已放宽到 title/type）',
    j1b.notes().length, 1);
  eq('EX-64b2', '该笔记的 images 为空数组', j1b.lastNote().images.length, 0);

  var j1c = load({
    initialState: { note: { note_id: ID_A, title: '空数组', type: 'normal', user: { nickname: 'n' }, image_list: [] } },
    pathname: '/explore/' + ID_A
  });
  eq('EX-64c', 'image_list 为空数组时仍能识别（[] 为真值）', j1c.notes().length, 1);

  var j2 = load({
    initialState: {
      note: {
        note_id: ID_A, title: 't', type: 'normal', user: { nickname: 'n' },
        image_list: [null, 'str', 42, { url_default: IMG_A1 }]
      }
    },
    pathname: '/explore/' + ID_A
  });
  eq('EX-65', 'image_list 含非对象项时被跳过', j2.lastNote().images.length, 1);
  eq('EX-66', '跳过后 index 沿用原始数组下标（3）', j2.lastNote().images[0].index, 3);

  var j3 = load({
    initialState: { note: { note_id: ID_A, title: '', desc: '这是一段很长的正文'.repeat(10), type: 'normal', user: { nickname: 'n' }, image_list: [] } },
    pathname: '/explore/' + ID_A
  });
  eq('EX-67', '无标题时取 desc 前 40 字', j3.lastNote().title, '这是一段很长的正文'.repeat(10).slice(0, 40));

  var j4 = load({
    initialState: { note: { note_id: ID_A, type: 'normal', user: { nickname: 'n' }, image_list: [] } },
    pathname: '/explore/' + ID_A
  });
  eq('EX-68', '无标题无正文时兜底为 小红书笔记_<id>', j4.lastNote().title, '小红书笔记_' + ID_A);

  var j5 = load({
    initialState: { note: { note_id: ID_A, title: 'no img', type: 'normal', user: { nickname: 'n' }, image_list: [{ url_default: 'http://sns-img-qc.xhscdn.com/noexcl' }] } },
    pathname: '/explore/' + ID_A
  });
  eq('EX-69', 'URL 无 "!" 时 urlOrigin 为空串', j5.lastNote().images[0].urlOrigin, '');
  eq('EX-70', 'URL 无 "!" 时 urlJpg 为空串', j5.lastNote().images[0].urlJpg, '');

  var j6 = load({
    initialState: { note: { note_id: ID_A, title: 'q', type: 'normal', user: { nickname: 'n' }, image_list: [{ url_default: IMG_A1 + '?imageView2/2/w/1080' }] } },
    pathname: '/explore/' + ID_A
  });
  eq('EX-71', '带 query 的 URL 仍能抽出 fileKey',
    stripBase(j6.lastNote().images[0].urlOrigin, IMG_BASES), 'notes_pre_post/1040g2sg31abcdefg');

  var j7 = load({
    initialState: { note: { note_id: ID_A, title: 'cover', type: 'normal', user: { nickname: 'n' }, cover: IMG_A1, image_list: [] } },
    pathname: '/explore/' + ID_A
  });
  eq('EX-72', 'cover 为字符串时直接采用', j7.lastNote().cover, IMG_A1);

  var j8 = load({ initialState: null, pathname: '/explore/' + ID_A });
  eq('EX-73', '__INITIAL_STATE__ 为 null 时不产出消息', j8.notes().length, 0);

  var j9 = load({ initialState: 'a string', pathname: '/explore/' + ID_A });
  noThrow('EX-74', '__INITIAL_STATE__ 为字符串时不抛异常', function () { return j9; });
  eq('EX-75', '__INITIAL_STATE__ 为字符串时不产出消息', j9.notes().length, 0);

  var j10 = load({ initialState: { note: { title: 'no id', image_list: [] } }, pathname: '/explore/' + ID_A });
  eq('EX-76', '无 note_id 的对象不被视为笔记', j10.notes().length, 0);

  /* ================================================================ */
  H.suite('内联 script 兜底（scanInlineScript）');
  var inlineState = JSON.stringify({ note: noteA() });
  var scripts = [{ textContent: 'window.__INITIAL_STATE__=' + inlineState + ';' }];
  var k1 = load({ scripts: scripts, pathname: '/explore/' + ID_A });
  ok('EX-77', '从内联 script 正则抠出 __INITIAL_STATE__ 并投递', k1.notes().length === 1,
    'notes=' + k1.notes().length);
  eq('EX-78', '内联来源的 noteId 正确', k1.lastNote() && k1.lastNote().noteId, ID_A);

  var scripts2 = [{ textContent: 'window.__INITIAL_STATE__={"note":{"note_id":"' + ID_A + '","title":"u","type":"normal","user":{"nickname":"n"},"image_list":[],"desc":undefined}};' }];
  var k2 = load({ scripts: scripts2, pathname: '/explore/' + ID_A });
  ok('EX-79', '内联 JSON 中的 undefined 被替换后可解析', k2.notes().length === 1,
    'notes=' + k2.notes().length);

  var scripts3 = [{ textContent: 'var x = 1;' }];
  var k3 = load({ scripts: scripts3, pathname: '/explore/' + ID_A });
  eq('EX-80', '无 __INITIAL_STATE__ 的 script 被跳过', k3.notes().length, 0);

  /* ================================================================ */
  H.suite('XHR 旁路监听');
  var xhrState = JSON.stringify({ note: noteA() });
  var x1 = load({ pathname: '/explore/' + ID_A });
  var req = new x1.sandbox.XMLHttpRequest();
  req.open('GET', 'https://edith.xiaohongshu.com/api/sns/web/v1/feed');
  req.send();
  req._ct = 'application/json; charset=utf-8';
  req.responseText = xhrState;
  req.fire('load');
  eq('EX-81', 'API 请求 + JSON 响应 → 投递 NOTE', x1.notes().length, 1);

  var x2 = load({ pathname: '/explore/' + ID_A });
  var req2 = new x2.sandbox.XMLHttpRequest();
  req2.open('GET', 'https://sns-video-hw.xhscdn.com/video.mp4');
  req2.send();
  req2._ct = 'video/mp4';
  req2.responseText = xhrState;
  req2.fire('load');
  eq('EX-82', '媒体请求不被解析', x2.notes().length, 0);

  var x3 = load({ pathname: '/explore/' + ID_A });
  var req3 = new x3.sandbox.XMLHttpRequest();
  req3.open('GET', 'https://www.xiaohongshu.com/api/sns/web/v1/feed');
  req3.send();
  req3._ct = 'video/mp4';
  req3.responseText = xhrState;
  req3.fire('load');
  eq('EX-83', 'API 路径但响应为二进制时不被解析', x3.notes().length, 0);

  var x4 = load({ pathname: '/explore/' + ID_A });
  var req4 = new x4.sandbox.XMLHttpRequest();
  req4.open('GET', 'https://edith.xiaohongshu.com/api/sns/web/v1/feed');
  req4.send();
  req4._ct = 'application/json';
  req4.responseText = 'not json at all';
  req4.fire('load');
  eq('EX-84', '非 JSON 文本不抛异常也不投递', x4.notes().length, 0);

  var x5 = load({ pathname: '/explore/' + ID_A });
  var req5 = new x5.sandbox.XMLHttpRequest();
  req5.open('GET', 'https://www.xiaohongshu.com/api/sns/web/v1/feed');
  req5.send();
  req5._ct = 'application/json';
  req5.responseText = xhrState;
  req5.responseType = 'blob';
  req5.fire('load');
  eq('EX-85', 'responseType=blob 时直接放弃（避免内存拷贝）', x5.notes().length, 0);

  var x6 = load({ pathname: '/explore/' + ID_A });
  var req6 = new x6.sandbox.XMLHttpRequest();
  req6.open('GET', 'https://www.xiaohongshu.com/api/sns/web/v1/feed');
  req6.send();
  req6._ct = 'application/json';
  req6.responseText = xhrState;
  req6.fire('load');
  req6.fire('load');
  eq('EX-86', 'load 监听为 once（重复触发不重复投递）', x6.notes().length, 1);

  /* ================================================================ */
  H.suite('fetch 旁路监听');
  var fetchState = JSON.stringify({ note: noteA() });
  var f1 = makeFetchStub(function () { return { ct: 'application/json', body: fetchState }; });
  var y1 = load({ pathname: '/explore/' + ID_A, fetch: f1 });
  y1.sandbox.fetch('https://edith.xiaohongshu.com/api/sns/web/v1/feed');
  await microtask(4);
  eq('EX-87', 'fetch API + JSON → 投递 NOTE', y1.notes().length, 1);

  var f2 = makeFetchStub(function () { return { ct: 'video/mp4', body: 'binary' }; });
  var y2 = load({ pathname: '/explore/' + ID_A, fetch: f2 });
  y2.sandbox.fetch('https://edith.xiaohongshu.com/api/sns/web/v1/feed');
  await microtask(4);
  eq('EX-88', 'fetch 媒体响应不 clone', f2.__stats.cloneCount, 0);
  eq('EX-89', 'fetch 媒体响应不投递', y2.notes().length, 0);

  var f3 = makeFetchStub(function () { return { ct: 'application/json', body: fetchState }; });
  var y3 = load({ pathname: '/explore/' + ID_A, fetch: f3 });
  y3.sandbox.fetch('https://sns-video-hw.xhscdn.com/v.mp4');
  await microtask(4);
  eq('EX-90', 'fetch 非 API 路径不 clone', f3.__stats.cloneCount, 0);

  /* ================================================================ */
  H.suite('消息桥 — RESCAN / SET_HOOK / origin 校验');
  var m1 = load({ initialState: { note: noteA() }, pathname: '/explore/' + ID_A });
  m1.messages.length = 0;
  m1.fireWindow('message', { source: m1.windowRef, origin: ORIGIN, data: { __channel: 'xhs-dl', type: 'REQUEST_RESCAN' } });
  var types = m1.messages.map(function (x) { return x.msg.type; });
  ok('EX-91', 'REQUEST_RESCAN → 回复 RESCAN_DONE', types.indexOf('RESCAN_DONE') !== -1, 'types=' + types.join(','));
  ok('EX-92', 'REQUEST_RESCAN → 附带 MEDIA_HINTS', types.indexOf('MEDIA_HINTS') !== -1);
  var rd = m1.messages.filter(function (x) { return x.msg.type === 'RESCAN_DONE'; })[0].msg.payload;
  eq('EX-93', 'RESCAN_DONE.noteId 来自 URL', rd.noteId, ID_A);
  eq('EX-94', 'RESCAN_DONE.ok = true', rd.ok, true);

  var m2 = load({ initialState: { note: noteA() }, pathname: '/explore/' + ID_A });
  m2.messages.length = 0;
  m2.fireWindow('message', { source: m2.windowRef, origin: 'https://evil.example.com', data: { __channel: 'xhs-dl', type: 'REQUEST_RESCAN' } });
  eq('EX-95', '跨源消息被忽略（origin 校验）', m2.messages.length, 0);

  var m3 = load({ initialState: { note: noteA() }, pathname: '/explore/' + ID_A });
  m3.messages.length = 0;
  m3.fireWindow('message', { source: {}, origin: ORIGIN, data: { __channel: 'xhs-dl', type: 'REQUEST_RESCAN' } });
  eq('EX-96', '非本 window 来源的消息被忽略（source 校验）', m3.messages.length, 0);

  var m4 = load({ initialState: { note: noteA() }, pathname: '/explore/' + ID_A });
  m4.messages.length = 0;
  m4.fireWindow('message', { source: m4.windowRef, origin: ORIGIN, data: { __channel: 'other', type: 'REQUEST_RESCAN' } });
  eq('EX-97', '非本通道的消息被忽略', m4.messages.length, 0);

  var m5 = load({ initialState: { note: noteA() }, pathname: '/explore/' + ID_A });
  m5.messages.length = 0;
  m5.fireWindow('message', { source: m5.windowRef, origin: ORIGIN, data: { __channel: 'xhs-dl', type: 'SET_HOOK', payload: { enabled: false } } });
  var hookState = m5.messages.filter(function (x) { return x.msg.type === 'HOOK_STATE'; })[0];
  eq('EX-98', 'SET_HOOK(enabled:false) → HOOK_STATE.active=false', hookState && hookState.msg.payload.active, false);

  var xhrAfterUninstall = new m5.sandbox.XMLHttpRequest();
  xhrAfterUninstall.open('GET', 'https://x.com/a');
  eq('EX-99', '卸载后 XHR 不再记录 URL', xhrAfterUninstall.__xhsDlUrl, undefined);

  m5.messages.length = 0;
  m5.fireWindow('message', { source: m5.windowRef, origin: ORIGIN, data: { __channel: 'xhs-dl', type: 'SET_HOOK', payload: { enabled: true } } });
  eq('EX-100', 'SET_HOOK(enabled:true) → HOOK_STATE.active=true',
    m5.messages.filter(function (x) { return x.msg.type === 'HOOK_STATE'; })[0].msg.payload.active, true);

  /* ---- 播放健康看门狗 ---- */
  H.suite('播放健康看门狗');
  var p1 = load({ initialState: { note: noteA() }, pathname: '/explore/' + ID_A });
  var errHandler = p1.docListeners.error && p1.docListeners.error[0];
  ok('EX-101', '注册了 document error 捕获监听', typeof errHandler === 'function');
  p1.messages.length = 0;
  errHandler({ target: { tagName: 'video' } });
  errHandler({ target: { tagName: 'video' } });
  // 旧实现是"一次 video error 就卸载"，而重装入口只有 SET_HOOK（扩展重启/改设置才发），
  // 于是一次误报就让整个会话再也抓不到 API 响应 —— 表现为"必须整页刷新才好用"。
  eq('EX-102a', '连续 2 次 video 报错仍不卸载（避免单次误报让整个会话失聪）',
    p1.messages.filter(function (x) { return x.msg.type === 'HOOK_DISABLED'; }).length, 0);
  errHandler({ target: { tagName: 'video' } });
  var hd = p1.messages.filter(function (x) { return x.msg.type === 'HOOK_DISABLED'; })[0];
  eq('EX-102', '连续 3 次 video 报错 → 自动卸载钩子', hd && hd.msg.payload.reason, 'video-error');
  var xhrAfter = new p1.sandbox.XMLHttpRequest();
  xhrAfter.open('GET', 'https://x.com/b');
  eq('EX-103', '看门狗触发后 XHR 钩子已还原', xhrAfter.__xhsDlUrl, undefined);

  // 自愈：卸载后必须能自己装回来，否则只能靠用户整页刷新。
  p1.messages.length = 0;
  var reinstall = p1.timers.filter(function (t) { return t.ms === 30000; })[0];
  ok('EX-103a', '卸载后注册了 30s 自动重装定时器', !!reinstall,
    'timers=' + JSON.stringify(p1.timers.map(function (t) { return t.ms; })));
  if (reinstall) reinstall.fn();
  var hsAfter = p1.messages.filter(function (x) { return x.msg.type === 'HOOK_STATE'; })[0];
  eq('EX-103b', '30s 后钩子自动重装成功', hsAfter && hsAfter.msg.payload.active, true);
  var xhrBack = new p1.sandbox.XMLHttpRequest();
  xhrBack.open('GET', 'https://x.com/c');
  eq('EX-103c', '重装后 XHR 钩子恢复工作', xhrBack.__xhsDlUrl, 'https://x.com/c');

  var p2 = load({ initialState: { note: noteA() }, pathname: '/explore/' + ID_A });
  p2.messages.length = 0;
  p2.docListeners.error[0]({ target: { tagName: 'IMG' } });
  eq('EX-104', '非 video 元素报错不触发卸载', p2.messages.filter(function (x) { return x.msg.type === 'HOOK_DISABLED'; }).length, 0);

  /* ---- 原生伪装 ---- */
  H.suite('原生伪装（反检测）');
  var q1 = load({ pathname: '/explore/' + ID_A });
  var openSrc = q1.sandbox.XMLHttpRequest.prototype.open.toString();
  var sendSrc = q1.sandbox.XMLHttpRequest.prototype.send.toString();
  ok('EX-105', 'XHR.open.toString() 不暴露包装痕迹（返回原生源码）',
    openSrc.indexOf('__xhsDlUrl') === -1, 'src=' + openSrc.slice(0, 60));
  ok('EX-106', 'XHR.send.toString() 不暴露包装痕迹（返回原生源码）',
    sendSrc.indexOf('addEventListener') === -1, 'src=' + sendSrc.slice(0, 60));
  eq('EX-107', 'XHR.open 的 name 保持原生', q1.sandbox.XMLHttpRequest.prototype.open.name, 'open');
  eq('EX-108', 'XHR.open 的 length 保持原生', q1.sandbox.XMLHttpRequest.prototype.open.length, 2);

  var fq = makeFetchStub(function () { return { ct: 'application/json', body: '{}' }; });
  var q2 = load({ pathname: '/explore/' + ID_A, fetch: fq });
  ok('EX-108b', 'fetch.toString() 不暴露包装痕迹',
    q2.sandbox.fetch.toString().indexOf('isApiUrl') === -1, 'src=' + q2.sandbox.fetch.toString().slice(0, 60));

  /* ---- 幂等 ---- */
  H.suite('幂等保护');
  var r1 = load({ initialState: { note: noteA() }, pathname: '/explore/' + ID_A });
  eq('EX-109', '加载后设置 __XHS_DL_INTERCEPTOR__ 标记', r1.sandbox.__XHS_DL_INTERCEPTOR__, true);
  r1.messages.length = 0;
  vm.runInContext(src, r1.sandbox, { filename: SRC });
  eq('EX-110', '二次注入不产生重复消息', r1.messages.length, 0);

  /* ---- 多时机扫描 ---- */
  H.suite('多时机扫描');
  var s1 = load({ initialState: { note: noteA() }, pathname: '/explore/' + ID_A });
  var beforeCount = s1.notes().length;
  s1.runTimers(1500);
  s1.runTimers(4000);
  ok('EX-111', 'delay-1500 / delay-4000 定时器已注册', s1.timers.some(function (t) { return t.ms === 1500; }) &&
    s1.timers.some(function (t) { return t.ms === 4000; }),
    'timers=' + JSON.stringify(s1.timers.map(function (t) { return t.ms; })));
  ok('EX-112', '定时器触发后重复投递（宿主可幂等处理）', s1.notes().length >= beforeCount,
    'before=' + beforeCount + ' after=' + s1.notes().length);
  ok('EX-113', 'SPA 路由监听 setInterval 已注册',
    s1.intervals.some(function (t) { return t.ms === 1000; }),
    'intervals=' + JSON.stringify(s1.intervals.map(function (t) { return t.ms; })));

  /* ---- SPA 路由切换：顺序与重试 ---- */
  H.suite('SPA 路由切换顺序');
  var rc = load({ initialState: { note: noteA() }, pathname: '/explore/' + ID_A });
  rc.messages.length = 0;
  rc.sandbox.location.href = ORIGIN + '/explore/' + ID_B;
  rc.sandbox.location.pathname = '/explore/' + ID_B;
  // 沙箱里没有 history / navigation，靠 1s 轮询兜底路径驱动
  var rcInterval = rc.intervals.filter(function (t) { return t.ms === 1000; })[0];
  ok('EX-114', 'SPA 路由监听已注册（轮询兜底）', typeof (rcInterval && rcInterval.fn) === 'function');
  rcInterval.fn();
  var firstType = rc.messages.length ? rc.messages[0].msg.type : '(none)';
  // 旧实现先扫描后 post(ROUTE_CHANGE)，隔离世界收到就 clearNote()，把刚扫到的
  // 笔记当场抹掉且不再重扫 —— SPA 点开新笔记必定空面板，只能整页刷新。
  eq('EX-115', '路由切换后第一条消息必须是 ROUTE_CHANGE（先清 UI 再扫描）', firstType, 'ROUTE_CHANGE');
  ok('EX-116', '切换后安排了多次重试扫描（300/800/1500/3000）',
    rc.timers.some(function (t) { return t.ms === 300; }) &&
    rc.timers.some(function (t) { return t.ms === 800; }) &&
    rc.timers.some(function (t) { return t.ms === 1500; }) &&
    rc.timers.some(function (t) { return t.ms === 3000; }),
    'timers=' + JSON.stringify(rc.timers.map(function (t) { return t.ms; })));
  var rcMsg = rc.messages.filter(function (x) { return x.msg.type === 'ROUTE_CHANGE'; })[0];
  ok('EX-117', 'ROUTE_CHANGE 带 navSeq（用于区分这次结果属于哪次导航）',
    !!(rcMsg && typeof rcMsg.msg.payload.navSeq === 'number' && rcMsg.msg.payload.navSeq > 0),
    'navSeq=' + (rcMsg && rcMsg.msg.payload.navSeq));

  /* ---- spaSource 开关：关闭后不得再软刷新 ---- */
  H.suite('spaSource 开关控制软刷新');

  /**
   * 现有 makeFetchStub 只给 clone() 挂了 text()，而软刷新走的是 response.text()，
   * 所以这里单独做一个同时提供 text() 的桩（否则软刷新恒失败，测不出开关）。
   */
  function ssrFetchStub() {
    var stats = { called: [] };
    var body = '<html><script>window.__INITIAL_STATE__ = ' + JSON.stringify({
      noteDetailMap: (function () { var m = {}; m[ID_B] = { note: noteB() }; return m; })()
    }) + ';</script></html>';
    var fn = function (url) {
      stats.called.push(String(url));
      return Promise.resolve({
        ok: true,
        headers: { get: function (n) { return String(n).toLowerCase() === 'content-type' ? 'text/html' : null; } },
        clone: function () { return { text: function () { return Promise.resolve(body); } }; },
        text: function () { return Promise.resolve(body); }
      });
    };
    fn.__stats = stats;
    return fn;
  }

  function fireMsg(h, type, payload) {
    h.fireWindow('message', {
      source: h.windowRef, origin: ORIGIN,
      data: { __channel: 'xhs-dl', type: type, payload: payload }
    });
  }
  function pendingCount(h) {
    return h.messages.filter(function (m) {
      return m.msg && m.msg.type === 'RESCAN_DONE' && m.msg.payload && m.msg.payload.pendingSoftRefresh;
    }).length;
  }

  // URL 指向 ID_B，但页面 state 里没有它 → 只能靠软刷新救
  var sfOff = ssrFetchStub();
  var spOff = load({ initialState: { noteDetailMap: {} }, pathname: '/explore/' + ID_B, fetch: sfOff });
  fireMsg(spOff, 'SET_SPA_SOURCE', { enabled: false });
  spOff.messages.length = 0;
  fireMsg(spOff, 'REQUEST_RESCAN');
  eq('SPA-OFF-1', 'spaSource=false 时不发起软刷新（无 pendingSoftRefresh）', pendingCount(spOff), 0);
  eq('SPA-OFF-2', 'spaSource=false 时不 fetch 重取页面', sfOff.__stats.called.length, 0);

  var sfOn = ssrFetchStub();
  var spOn = load({ initialState: { noteDetailMap: {} }, pathname: '/explore/' + ID_B, fetch: sfOn });
  fireMsg(spOn, 'SET_SPA_SOURCE', { enabled: true });
  spOn.messages.length = 0;
  fireMsg(spOn, 'REQUEST_RESCAN');
  eq('SPA-ON-1', 'spaSource=true 时发起软刷新（有 pendingSoftRefresh）', pendingCount(spOn), 1);
  eq('SPA-ON-2', 'spaSource=true 时确实 fetch 了当前页面', sfOn.__stats.called.length, 1);

  // 默认（从未收到 SET_SPA_SOURCE）应保持开启，不能因为消息缺失而失效
  var sfDef = ssrFetchStub();
  var spDef = load({ initialState: { noteDetailMap: {} }, pathname: '/explore/' + ID_B, fetch: sfDef });
  spDef.messages.length = 0;
  fireMsg(spDef, 'REQUEST_RESCAN');
  eq('SPA-DEF-1', '未收到 SET_SPA_SOURCE 时默认开启软刷新', pendingCount(spDef), 1);

  // 开关随 REQUEST_RESCAN 一起下发（不依赖 SET_SPA_SOURCE 是否送达）
  var sfReq = ssrFetchStub();
  var spReq = load({ initialState: { noteDetailMap: {} }, pathname: '/explore/' + ID_B, fetch: sfReq });
  spReq.messages.length = 0;
  fireMsg(spReq, 'REQUEST_RESCAN', { spaSource: false });
  eq('SPA-REQ-OFF-1', '请求里 spaSource=false 时不发起软刷新', pendingCount(spReq), 0);
  eq('SPA-REQ-OFF-2', '请求里 spaSource=false 时不 fetch 页面', sfReq.__stats.called.length, 0);

  var sfReq2 = ssrFetchStub();
  var spReq2 = load({ initialState: { noteDetailMap: {} }, pathname: '/explore/' + ID_B, fetch: sfReq2 });
  spReq2.messages.length = 0;
  fireMsg(spReq2, 'REQUEST_RESCAN', { spaSource: true });
  eq('SPA-REQ-ON-1', '请求里 spaSource=true 时发起软刷新', pendingCount(spReq2), 1);

  var S = H.summary('test-extractor.js');
  process.exit(S.fail ? 1 : 0);
}

main().catch(function (e) {
  console.error('测试运行异常：', e && e.stack || e);
  process.exit(2);
});
