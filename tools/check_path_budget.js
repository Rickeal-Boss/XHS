/**
 * buildPath 长度预算的不变式检查（属性测试）。
 * 运行： node tools/check_path_budget.js
 *
 * 背景：MAX_PATH 约束的是**全路径**，而 baseDir / 作者 / 标题 三级目录
 * 本身就可能吃掉全部预算。缺陷 D-04 就是「只截文件名主体、目录超长时
 * 整条路径依然超标」。单元测试只覆盖了少数几个固定组合，这里用
 * 组合矩阵 + 随机模糊把不变式钉死。
 *
 * 断言的不变式（对任意输入都成立）：
 *   I1  相对路径长度 ≤ MAX_PATH_LEN
 *   I2  扩展名被保留（输入有扩展名时）
 *   I3  不出现空段 / 连续分隔符 / 首尾分隔符
 *   I4  任一段不以点或空格结尾（Windows 会静默剥离）
 *   I5  不抛异常
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.dirname(__dirname);
var SRC = path.join(ROOT, 'src', 'background.js');
var src = fs.readFileSync(SRC, 'utf8');

/**
 * 自动补全的 chrome 桩。
 * background.js 顶层会注册 onMessage / onInstalled / onChanged 等多个监听，
 * 逐个手写容易在源码新增 API 时崩掉。这里用一个 Proxy 递归生成
 * 「任意属性都是可调用对象」的桩 —— 本检查只关心 buildPath，
 * 不依赖任何 chrome API 的真实语义。
 */
function anyApi() {
  var fn = function () { return undefined; };
  return new Proxy(fn, {
    get: function (t, k) {
      if (typeof k === 'symbol') return t[k];
      if (!(k in t)) t[k] = anyApi();
      return t[k];
    },
    apply: function () { return undefined; },
    has: function () { return true; }
  });
}

function loadBackground() {
  var sandbox = {
    chrome: anyApi(),
    console: console,
    Promise: Promise,
    URL: URL,
    setTimeout: function () { return 0; },
    clearTimeout: function () {},
    setInterval: function () { return 0; },
    clearInterval: function () {}
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: SRC });
  return sandbox;
}

var sb = loadBackground();
var buildPath = sb.buildPath;
var MAX_PATH_LEN = sb.MAX_PATH_LEN;

if (typeof buildPath !== 'function') {
  console.error('无法从 vm 上下文取到 buildPath —— 源码顶层声明方式变了？');
  process.exit(1);
}

/* ============================ 用例矩阵 ============================ */

var R = function (ch, n) { return ch.repeat(n); };

var DIRS = [
  '',
  '小红书下载',
  '小红书下载/作者昵称',
  '小红书下载/作者昵称/标题',
  R('a', 70) + '/' + R('b', 70) + '/' + R('c', 70),          // D-04 原始用例
  R('d', 80) + '/' + R('e', 80) + '/' + R('标题', 20),       // D-04 真实场景
  R('x', 500),                                                // 单段超长
  R('y', 40) + '/' + R('y', 40) + '/' + R('y', 40) + '/' + R('y', 40) + '/' + R('y', 40),
  Array(200).join('s/'),                                      // 段数爆炸
  'base/../etc/passwd',                                       // 路径穿越尝试
  'con/prn/aux',                                              // 保留设备名
  'a./b /c..',                                                // 尾部点空格
  '很长的中文目录名'.repeat(20) + '/' + '很长的中文标题'.repeat(20),
  '/',
  '//',
  'a//b',
  R('z', 179),
  R('z', 180),
  R('z', 181)
];

var NAMES = [
  'x.mp4',
  'title.mp4',
  R('x', 300) + '.mp4',                                       // 超长名
  R('y', 200) + '.jpg',
  'noext',
  '.bashrc',
  'a.b.c.d.mp4',
  'con.mp4',                                                  // 保留设备名
  '中文标题_第1张.jpg',
  'a/b\\c:d*e?f"g<h>i|j.mp4',                                 // 非法字符
  R('n', 200) + '.',                                          // 尾部点
  R('n', 200) + '. ',
  '',
  '.',
  '..',
  R('w', 1000) + '.webm'
];

/* ============================ 断言 ============================ */

var fails = [];
var total = 0;

function check(dirLabel, dir, name, out) {
  total++;
  var tag = dirLabel + ' + ' + JSON.stringify(name.slice(0, 30)) + (name.length > 30 ? '…' : '');

  if (out.length > MAX_PATH_LEN) {
    fails.push({ tag: tag, inv: 'I1 长度', detail: 'len=' + out.length + ' 超出 ' + (out.length - MAX_PATH_LEN) });
  }
  // I2：输入以「真实媒体扩展名」结尾时，输出必须保留它。
  // 口径要点（否则会误报）：
  //   - 不能用 lastIndexOf('.') —— '.mp4' / '..mp4' / ' .mp4' 这些名的
  //     前导点/空格会被 sanitizeSegment 按设计剥掉（Windows 隐藏文件），
  //     它们本来就没有可保留的扩展名；
  //   - 所以要求扩展名前面必须是「真实的文件名字符」。
  var mExt = name.match(/^(?:.*[^.\s])\.(mp4|mov|webm|m4v|jpg|jpeg|png|webp|heic|gif|avif)$/i);
  var wantExt = mExt ? '.' + mExt[1] : '';
  if (wantExt && out.slice(-wantExt.length) !== wantExt) {
    fails.push({ tag: tag, inv: 'I2 扩展名', detail: '期望结尾 ' + wantExt + '，实际 ' + JSON.stringify(out.slice(-12)) });
  }
  if (out === '') {
    fails.push({ tag: tag, inv: 'I3 空结果', detail: '返回空路径' });
  } else {
    if (out[0] === '/' || out.slice(-1) === '/') {
      fails.push({ tag: tag, inv: 'I3 首尾分隔符', detail: JSON.stringify(out.slice(0, 20)) });
    }
    if (out.indexOf('//') !== -1) {
      fails.push({ tag: tag, inv: 'I3 连续分隔符', detail: JSON.stringify(out.slice(0, 40)) });
    }
    out.split('/').forEach(function (seg, i) {
      if (!seg) {
        fails.push({ tag: tag, inv: 'I3 空段', detail: '第 ' + i + ' 段为空' });
      }
      if (/[.\s]$/.test(seg)) {
        fails.push({ tag: tag, inv: 'I4 段尾点/空格', detail: '第 ' + i + ' 段=' + JSON.stringify(seg) });
      }
    });
  }
}

DIRS.forEach(function (dir, di) {
  NAMES.forEach(function (name) {
    var out;
    try {
      out = buildPath(dir, name);
    } catch (e) {
      total++;
      fails.push({ tag: 'dir#' + di + ' + ' + JSON.stringify(name.slice(0, 30)), inv: 'I5 抛异常', detail: String(e && e.message) });
      return;
    }
    if (typeof out !== 'string') {
      total++;
      fails.push({ tag: 'dir#' + di + ' + ' + JSON.stringify(name.slice(0, 30)), inv: 'I5 返回非字符串', detail: String(out) });
      return;
    }
    check('dir#' + di + '(' + dir.length + '字符)', dir, name, out);
  });
});

/* ============================ 随机模糊 ============================ */

var ALPHA = 'abcXYZ019_. -/\\:*?"<>|中文很长的';
function rnd(n) {
  var s = '';
  for (var i = 0; i < n; i++) s += ALPHA[Math.floor(Math.random() * ALPHA.length)];
  return s;
}

var SEED = 20260918;
// 固定序列的伪随机（mulberry32），保证可复现
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
var rand = mulberry32(SEED);

var fuzzTotal = 3000;
for (var k = 0; k < fuzzTotal; k++) {
  var segCount = 1 + Math.floor(rand() * 8);
  var parts = [];
  for (var j = 0; j < segCount; j++) parts.push(rnd(Math.floor(rand() * 120)));
  var fdir = parts.join('/');
  var fname = rnd(Math.floor(rand() * 150)) + (rand() < 0.6 ? '.mp4' : '');
  var fout;
  try {
    fout = buildPath(fdir, fname);
  } catch (e) {
    total++;
    fails.push({ tag: 'fuzz#' + k, inv: 'I5 抛异常', detail: String(e && e.message) });
    continue;
  }
  if (typeof fout !== 'string') {
    total++;
    fails.push({ tag: 'fuzz#' + k, inv: 'I5 返回非字符串', detail: String(fout) });
    continue;
  }
  check('fuzz#' + k, fdir, fname, fout);
}

/* ============================ 报告 ============================ */

console.log('================================================================');
console.log('buildPath 长度预算不变式检查');
console.log('  MAX_PATH_LEN = ' + MAX_PATH_LEN);
console.log('  矩阵用例 ' + DIRS.length + ' × ' + NAMES.length + ' = ' + (DIRS.length * NAMES.length));
console.log('  随机模糊 ' + fuzzTotal + ' 例（种子 ' + SEED + '，可复现）');
console.log('  合计断言 ' + total + ' 项');
console.log('----------------------------------------------------------------');

// 按不变式归类，避免同类问题刷屏
var byInv = {};
fails.forEach(function (f) { byInv[f.inv] = (byInv[f.inv] || 0) + 1; });

if (!fails.length) {
  console.log('全部通过 ✅  所有输入下路径长度均 ≤ ' + MAX_PATH_LEN + '，且扩展名保留、无空段、无尾部点空格');
} else {
  console.log('失败 ' + fails.length + ' 项：');
  Object.keys(byInv).forEach(function (inv) {
    console.log('  ' + inv + ' × ' + byInv[inv]);
  });
  console.log('');
  console.log('前 15 条明细：');
  fails.slice(0, 15).forEach(function (f) {
    console.log('  ✗ [' + f.inv + '] ' + f.tag + ' — ' + f.detail);
  });
}
/* ============================ 关键用例回放 ============================ */

console.log('');
console.log('关键用例回放（D-04 的现场）：');
[
  [R('a', 70) + '/' + R('b', 70) + '/' + R('c', 70), 'title.mp4', 'BP-22 目录三段各 70'],
  [R('d', 80) + '/' + R('e', 80) + '/' + '标题'.repeat(20), 'x.mp4', 'BP-23 baseDir(80)+作者(80)+标题(40)'],
  ['小红书下载/作者昵称', R('y', 200) + '.jpg', 'BP-20 两层目录 + 超长名'],
  ['', R('x', 300) + '.mp4', 'BP-17 纯超长名']
].forEach(function (c) {
  var out = buildPath(c[0], c[1]);
  console.log('  ' + c[2]);
  console.log('    dir=' + c[0].length + ' 字符  name=' + c[1].length + ' 字符  →  路径 ' + out.length + ' 字符');
  console.log('    ' + JSON.stringify(out.length > 60 ? out.slice(0, 30) + '…' + out.slice(-25) : out));
});

console.log('================================================================');

process.exit(fails.length ? 1 : 0);
