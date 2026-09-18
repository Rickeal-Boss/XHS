/**
 * 单元测试：src/content/downloader.js
 * 运行： TZ=UTC node test-downloader.js
 */
'use strict';

process.env.TZ = process.env.TZ || 'UTC';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var H = require('./_harness');
var eq = H.eq, deepEq = H.deepEq, ok = H.ok, noThrow = H.noThrow;

var SRC = path.join(__dirname, '..', 'src', 'content', 'downloader.js');
var src = fs.readFileSync(SRC, 'utf8');
var ctx = vm.createContext({ console: console });
vm.runInContext(src, ctx, { filename: SRC });
var D = ctx.XHS_DL_DOWNLOADER;

/* ------------------------------------------------------------------ */
/* 前置：确认时区为 UTC，否则时间断言无意义                              */
/* ------------------------------------------------------------------ */
H.suite('前置条件');
ok('PRE-1', 'TZ 已固定为 UTC（保证时间断言确定性）',
  new Date(1711612800 * 1000).getUTCHours() === 8 &&
  new Date(1711612800 * 1000).getFullYear() === 2024,
  'TZ=' + (process.env.TZ || '(unset)') + ' localHour=' + new Date(1711612800 * 1000).getHours());
ok('PRE-2', '模块导出存在', !!(D && D.formatTime && D.sanitize && D.renderName && D.buildTasks && D.guessExt));

/* ------------------------------------------------------------------ */
/* 1. formatTime                                                       */
/* ------------------------------------------------------------------ */
H.suite('formatTime — 时间格式化');

eq('FT-1', '秒级时间戳 + 完整格式', D.formatTime(1711612800, 'YYYY-MM-DD HH:mm:ss'), '2024-03-28 08:00:00');
eq('FT-2', '毫秒级时间戳（>1e12）自动识别', D.formatTime(1711612800000, 'YYYY-MM-DD HH:mm:ss'), '2024-03-28 08:00:00');
eq('FT-3', '默认格式（中文模板）', D.formatTime(1711612800), '2024年03月28日08时00分00秒');
eq('FT-4', 'YYYYMMDD', D.formatTime(1711612800, 'YYYYMMDD'), '20240328');
eq('FT-5', 'YY 两位年', D.formatTime(1711612800, 'YY'), '24');
eq('FT-6', '单字符 token M/D/H/m/s', D.formatTime(1711612800, 'M/D/H/m/s'), '3/28/8/0/0');
eq('FT-7', '单数字月/日补零验证（2024-01-01T00:00:00Z）',
  D.formatTime(1704067200, 'YYYY-MM-DD HH:mm:ss'), '2024-01-01 00:00:00');
eq('FT-8', '单字符 token 于 1 月 1 日', D.formatTime(1704067200, 'M/D/H/m/s'), '1/1/0/0/0');
eq('FT-9', 'token 替换顺序：MMM 不应被 M 抢占', D.formatTime(1711612800, 'MMM'), '033',
  '期望 MM→03 后接 M→3 = "033"；若为 "333" 则说明 M 抢先匹配');
eq('FT-10', 'token 替换顺序：DDDD', D.formatTime(1711612800, 'DDDD'), '2828');
eq('FT-11', 'token 替换顺序：HHmmss 连写', D.formatTime(1711612800, 'HHmmss'), '080000');
eq('FT-12', '0 视为空（falsy 短路）', D.formatTime(0, 'YYYY'), '');
eq('FT-13', 'null 输入', D.formatTime(null, 'YYYY'), '');
eq('FT-14', 'undefined 输入', D.formatTime(undefined, 'YYYY'), '');
eq('FT-15', '非法字符串输入', D.formatTime('not-a-number', 'YYYY'), '');
eq('FT-16', 'NaN 输入', D.formatTime(NaN, 'YYYY'), '');
eq('FT-17', '空格式串回落到默认格式', D.formatTime(1711612800, ''), '2024年03月28日08时00分00秒');
eq('FT-18', '格式串无 token 时原样返回', D.formatTime(1711612800, 'abc'), 'abc');
eq('FT-19', '观察项：恰好 1e12 落在「秒」分支（阈值是严格大于 >1e12）',
  D.formatTime(1e12, 'YYYY'), String(new Date(1e12 * 1000).getFullYear()),
  '真实 ms 时间戳约 1.7e12，不受影响，仅记录阈值语义');

/* ------------------------------------------------------------------ */
/* 2. sanitize                                                         */
/* ------------------------------------------------------------------ */
H.suite('sanitize — 文件名清洗');

eq('SN-1', '全部非法字符 \\/:*?"<>| → _', D.sanitize('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
eq('SN-2', '控制字符 0x00-0x1f → _', D.sanitize('a\u0000b\u001fc\u001ed'), 'a_b_c_d');
eq('SN-3', 'DEL 0x7f → _', D.sanitize('a\u007fb'), 'a_b');
eq('SN-4', '换行/制表/回车先被控制字符规则替换为 _（其后的 [\\r\\n\\t]→空格 规则为死代码，见观察项 O-02）',
  D.sanitize('a\nb\tc\rd'), 'a_b_c_d');
eq('SN-5', '连续空白折叠', D.sanitize('a     b'), 'a b');
eq('SN-6', '首尾点与空格剥离', D.sanitize('  ..name..  '), 'name');
eq('SN-7', '仅由点/空格构成 → 空串', D.sanitize(' ...  '), '');
eq('SN-8', '空字符串', D.sanitize(''), '');
eq('SN-9', 'null', D.sanitize(null), '');
eq('SN-10', 'undefined', D.sanitize(undefined), '');
eq('SN-11', '数字输入被字符串化', D.sanitize(12345), '12345');
eq('SN-12', '恰好 80 字符不截断', D.sanitize('x'.repeat(80)).length, 80);
eq('SN-13', '81 字符截断到 80', D.sanitize('x'.repeat(81)).length, 80);
eq('SN-14', '超长（200）截断到 80', D.sanitize('y'.repeat(200)).length, 80);
eq('SN-15', '截断后不留尾部点/空格', D.sanitize('z'.repeat(79) + '. '), 'z'.repeat(79));
ok('SN-16', '超长且第 80 位是空格时不产生尾部空格',
  !/[ .]$/.test(D.sanitize('a'.repeat(79) + '  b')), 'result=' + JSON.stringify(D.sanitize('a'.repeat(79) + '  b')));
eq('SN-17', 'emoji 保留', D.sanitize('标题🎉🌊'), '标题🎉🌊');
eq('SN-18', '中文全角标点保留（非非法字符）', D.sanitize('标题，。！？；：'), '标题，。！？；：');
ok('SN-19', '观察项：RTL 覆写符 U+202E 不属于非法字符集，会被原样保留',
  D.sanitize('a\u202eb.txt') === 'a\u202eb.txt',
  '低危观察项：可在文件名中造成显示顺序错乱，但不影响下载');

/* ------------------------------------------------------------------ */
/* 3. renderName                                                       */
/* ------------------------------------------------------------------ */
H.suite('renderName — 命名模板渲染');

var VARS = {
  index: 3,
  noteId: '65f1a2b3000000001203abcd',
  title: '莫干山民宿',
  publishTime: '20240328',
  ipLocation: '浙江',
  nickname: '旅行的小鹿',
  redId: 'lulu_trip',
  userId: '5f2c1b'
};

eq('RN-1', '8 个占位符全部替换',
  D.renderName('<序号>|<笔记id>|<标题>|<发布时间>|<ip归属地>|<发布者昵称>|<小红书号>|<发布者id>', VARS),
  '3|65f1a2b3000000001203abcd|莫干山民宿|20240328|浙江|旅行的小鹿|lulu_trip|5f2c1b');
eq('RN-2', '默认模板', D.renderName('', VARS), '[旅行的小鹿]莫干山民宿(20240328)');
eq('RN-3', 'rule 为 null 时用默认模板', D.renderName(null, VARS), '[旅行的小鹿]莫干山民宿(20240328)');
eq('RN-4', '未识别短占位符 <xxx> 被清除', D.renderName('a<未知>b<foo>c', VARS), 'abc');
eq('RN-5', '变量为 null 时替换为空串', D.renderName('<标题>', { title: null }), '');
eq('RN-6', '变量缺失时替换为空串', D.renderName('[<发布者昵称>]<标题>', { title: 'T' }), '[]T');
eq('RN-7', '变量为空字符串', D.renderName('[<发布者昵称>]<标题>', { title: 'T', nickname: '' }), '[]T');
eq('RN-8', '重复占位符全部替换', D.renderName('<标题>-<标题>', VARS), '莫干山民宿-莫干山民宿');
eq('RN-9', '结果折叠连续空白并 trim', D.renderName('  a    b  ', VARS), 'a b');
eq('RN-10', '观察项：超过 20 字的未识别占位符不会被清除',
  D.renderName('x<不存在的很长的占位符超过二十个字符长度限制>y', VARS),
  'x<不存在的很长的占位符超过二十个字符长度限制>y');
eq('RN-11', '数字型变量被字符串化', D.renderName('<序号>', { index: 7 }), '7');

/* ------------------------------------------------------------------ */
/* 4. guessExt                                                         */
/* ------------------------------------------------------------------ */
H.suite('guessExt — 扩展名推断');

eq('GE-1', '带扩展名', D.guessExt('https://a.com/b/c.mp4', '.jpg'), '.mp4');
eq('GE-2', '大写扩展名被归一为小写', D.guessExt('https://a.com/b/c.JPG', '.bin'), '.jpg');
eq('GE-3', '带 query 仍能取扩展名', D.guessExt('https://a.com/b/c.webp?x=1&y=2', '.jpg'), '.webp');
eq('GE-4', '无扩展名 → fallback', D.guessExt('https://sns-img-qc.xhscdn.com/1040g2sg31abc', '.jpg'), '.jpg');
eq('GE-5', '空值 → fallback', D.guessExt('', '.jpg'), '.jpg');
eq('GE-6', 'null → fallback', D.guessExt(null, '.jpg'), '.jpg');
eq('GE-7', 'undefined 且无 fallback → 空串', D.guessExt(undefined), '');
eq('GE-8', 'm3u8 不在白名单 → fallback', D.guessExt('https://a.com/v.m3u8', '.mp4'), '.mp4');
eq('GE-9', 'mov 在白名单', D.guessExt('https://a.com/v.mov', '.mp4'), '.mov');
eq('GE-10', '路径中的 .mp4 目录名不误判（c.mp4/d）',
  D.guessExt('https://a.com/c.mp4/d', '.jpg'), '.jpg');
eq('GE-11', 'heic', D.guessExt('https://a.com/i.heic', '.jpg'), '.heic');

/* ------------------------------------------------------------------ */
/* 5. buildTasks                                                       */
/* ------------------------------------------------------------------ */
H.suite('buildTasks — 下载任务构建');

function baseSettings(over) {
  return Object.assign({
    nameRule: '<序号>-<标题>',
    timeFormat: 'YYYYMMDD',
    imageFormat: 'origin',
    videoQuality: 'origin',
    liveMode: 'both',
    dirByAuthor: false,
    dirByTitle: false,
    baseDir: ''
  }, over || {});
}

function img(i, over) {
  return Object.assign({
    index: i,
    urlDefault: 'https://sns-img-qc.xhscdn.com/def' + i + '?imageView2/2/w/1080',
    urlOrigin: 'https://sns-img-qc.xhscdn.com/ori' + i,
    urlJpg: 'https://sns-img-qc.xhscdn.com/ori' + i + '?imageView2/2/w/format/jpg',
    liveVideoUrl: '',
    isLive: false,
    width: 1080,
    height: 1440
  }, over || {});
}

function note(over) {
  return Object.assign({
    noteId: 'n0001',
    title: '标题',
    desc: '',
    publishTime: 1711612800,
    ipLocation: '浙江',
    author: { nickname: '作者', redId: 'r1', userId: 'u1' },
    images: [img(0), img(1)],
    video: null
  }, over || {});
}

var videoNote = note({
  video: {
    urlOrigin: 'https://sns-video-hw.xhscdn.com/origin.mp4',
    originKey: 'origin/key.mp4',
    urlStream: 'https://sns-video-hw.xhscdn.com/stream.mp4'
  }
});

/* --- 视频笔记 --- */
var t = D.buildTasks(videoNote, [-1, 0, 1], baseSettings());
eq('BT-1', '视频笔记任务数 = 1 视频 + 2 图', t.length, 3);
eq('BT-2', '视频排在最前', t[0].kind, 'video');
eq('BT-3', '视频命名取序号 1', t[0].name, '1-标题.mp4');
eq('BT-4', '视频 url 为原画质', t[0].url, 'https://sns-video-hw.xhscdn.com/origin.mp4');
eq('BT-5', '图片序号顺延为 2', t[1].name, '2-标题.jpg');
eq('BT-6', '图片序号顺延为 3', t[2].name, '3-标题.jpg');
deepEq('BT-7', '视频 fallbacks 含 stream 直链', t[0].fallbacks, ['https://sns-video-hw.xhscdn.com/stream.mp4']);
ok('BT-8', '图片任务标记 live=false', t[1].live === false, 'live=' + t[1].live);

var t2 = D.buildTasks(videoNote, [-1, 0, 1], baseSettings({ videoQuality: 'default' }));
eq('BT-9', 'videoQuality=default → 取 urlStream', t2[0].url, 'https://sns-video-hw.xhscdn.com/stream.mp4');

/* --- 只勾视频 --- */
var t3 = D.buildTasks(videoNote, [-1], baseSettings());
eq('BT-10', '只勾视频 → 仅 1 条任务', t3.length, 1);
eq('BT-11', '只勾视频 → kind=video', t3[0].kind, 'video');

/* --- 只勾图片 --- */
var t4 = D.buildTasks(videoNote, [1], baseSettings());
eq('BT-12', '只勾图片 → 仅 1 条任务', t4.length, 1);
eq('BT-13', '只勾图片 → 序号从 1 重新开始', t4[0].name, '1-标题.jpg');

/* --- imageFormat 三档 --- */
var t5 = D.buildTasks(note({ video: null }), [0], baseSettings({ imageFormat: 'origin' }));
eq('BT-14', 'imageFormat=origin → urlOrigin', t5[0].url, 'https://sns-img-qc.xhscdn.com/ori0');
eq('BT-15', 'imageFormat=origin → 扩展名 .jpg（原图直链无扩展名，走 fallback）', t5[0].name, '1-标题.jpg');

var t6 = D.buildTasks(note(), [0], baseSettings({ imageFormat: 'default' }));
eq('BT-16', 'imageFormat=default → urlDefault', t6[0].url, 'https://sns-img-qc.xhscdn.com/def0?imageView2/2/w/1080');

var t7 = D.buildTasks(note(), [0], baseSettings({ imageFormat: 'jpg' }));
eq('BT-17', 'imageFormat=jpg → urlJpg', t7[0].url, 'https://sns-img-qc.xhscdn.com/ori0?imageView2/2/w/format/jpg');
eq('BT-18', 'imageFormat=jpg → 强制 .jpg 后缀', t7[0].name, '1-标题.jpg');

/* --- 实况照片 --- */
var liveNote = note({
  images: [
    img(0, { liveVideoUrl: 'https://sns-video-hw.xhscdn.com/live0.mp4', isLive: true }),
    img(1, { liveVideoUrl: 'https://sns-video-hw.xhscdn.com/live1.mp4', isLive: true })
  ]
});

var t8 = D.buildTasks(liveNote, [0, 1], baseSettings({ liveMode: 'both' }));
eq('BT-19', 'liveMode=both → 2 图 + 2 实况 = 4 条', t8.length, 4);
eq('BT-20', '实况配对：图 1 与实况 1 同序号', t8[0].name, '1-标题.jpg');
eq('BT-21', '实况配对：实况 1 带 _live 后缀', t8[1].name, '1-标题_live.mp4');
eq('BT-22', '实况配对：图 2 与实况 2 同序号', t8[2].name, '2-标题.jpg');
eq('BT-23', '实况配对：实况 2 带 _live 后缀', t8[3].name, '2-标题_live.mp4');
eq('BT-24', '实况任务 kind=live', t8[1].kind, 'live');
eq('BT-25', '实况任务 url 正确', t8[1].url, 'https://sns-video-hw.xhscdn.com/live0.mp4');
deepEq('BT-26', '实况任务无 fallbacks', t8[1].fallbacks, []);

var t9 = D.buildTasks(liveNote, [0, 1], baseSettings({ liveMode: 'image-only' }));
eq('BT-27', 'liveMode=image-only → 仅 2 张图', t9.length, 2);
ok('BT-28', 'liveMode=image-only → 无 live 任务', t9.every(function (x) { return x.kind === 'image'; }));

var t10 = D.buildTasks(liveNote, [0, 1], baseSettings({ liveMode: 'video-only' }));
eq('BT-29', 'liveMode=video-only → 期望仅 2 条实况视频（缺陷 D-02）', t10.length, 2);
ok('BT-30', 'liveMode=video-only → 期望不含静态图（缺陷 D-02）',
  t10.every(function (x) { return x.kind === 'live'; }),
  '实际 kinds=' + JSON.stringify(t10.map(function (x) { return x.kind; })));

/* --- 空 / 无媒体 --- */
eq('BT-31', 'selected 为空 → 无任务', D.buildTasks(note(), [], baseSettings()).length, 0);
eq('BT-32', 'note 无任何媒体 → 无任务',
  D.buildTasks(note({ images: [], video: null }), [-1, 0], baseSettings()).length, 0);
eq('BT-33', '视频笔记但未勾选 -1 → 不含视频',
  D.buildTasks(videoNote, [0], baseSettings()).filter(function (x) { return x.kind === 'video'; }).length, 0);
eq('BT-34', '图片所有直链为空 → 跳过该图',
  D.buildTasks(note({ images: [img(0, { urlOrigin: '', urlDefault: '', urlJpg: '' })], video: null }),
    [0], baseSettings()).length, 0);
eq('BT-35', '视频笔记 urlOrigin 与 urlStream 皆空 → 不产出视频任务',
  D.buildTasks(note({ video: { urlOrigin: '', urlStream: '' } }), [-1], baseSettings()).length, 0);

/* --- 30 张图 --- */
var many = note({ images: [] , video: null });
for (var i = 0; i < 30; i++) many.images.push(img(i));
var t30 = D.buildTasks(many, many.images.map(function (x) { return x.index; }), baseSettings());
eq('BT-36', '30 张图 → 30 条任务', t30.length, 30);
eq('BT-37', '30 张图 → 序号 1..30', t30[0].name, '1-标题.jpg');
eq('BT-38', '30 张图 → 末条序号 30', t30[29].name, '30-标题.jpg');

/* --- 目录 --- */
var tDir = D.buildTasks(note(), [0], baseSettings({ baseDir: '小红书下载', dirByAuthor: true, dirByTitle: true }));
eq('BT-39', 'baseDir + 作者 + 标题 三级目录（buildDir 自带尾部 /）',
  tDir[0].dir, '小红书下载/作者/标题/');
ok('BT-40', '目录以 / 结尾', /\/$/.test(tDir[0].dir), 'dir=' + tDir[0].dir);

/* --- 无标题 --- */
eq('BT-41', '标题为空 → 使用 image_<index> 兜底',
  D.buildTasks(note({ title: '', video: null, images: [img(0)] }), [0], baseSettings()).length, 1);

/* --- 作者昵称为空 --- */
var tNoAuthor = D.buildTasks(note({ author: { nickname: '', redId: '', userId: '' }, video: null }), [0],
  baseSettings({ nameRule: '[<发布者昵称>]<标题>', dirByAuthor: true }));
eq('BT-42', '作者昵称为空 → 模板中为空', tNoAuthor[0].name, '[]标题.jpg');
eq('BT-43', '作者昵称为空 + dirByAuthor → 不建作者目录', tNoAuthor[0].dir, '');

/* --- images 缺失（健壮性） --- */
noThrow('BT-44', 'note.images 为 undefined 时 buildTasks 不崩溃（防御性编程缺失）', function () {
  return D.buildTasks({ noteId: 'x', title: 't', video: null }, [0], baseSettings());
}, 'content.js 的 sanitizeNote 总是补齐 images:[]，故生产路径不可达，属低危');

/* ------------------------------------------------------------------ */
/* 6. 常量                                                             */
/* ------------------------------------------------------------------ */
H.suite('常量');
eq('CT-1', 'PLACEHOLDERS 共 8 项', D.PLACEHOLDERS.length, 8);
eq('CT-2', 'DEFAULT_RULE 与 content.js 默认设置一致', D.DEFAULT_RULE, '[<发布者昵称>]<标题>(<发布时间>)');

var S = H.summary('test-downloader.js');
process.exit(S.fail ? 1 : 0);
