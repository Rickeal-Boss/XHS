/**
 * pickBase 的 CDN 域名分布检查。
 * 运行： node tools/check_base_spread.js
 *
 * 背景：pickBase 原本用 Math.random() 选 CDN 域名，导致
 *   (a) background.js 按 URL 建的去重表永远命中不了（同一张图每次 URL 都变）；
 *   (b) 导出 JSON 与测试断言不可复现。
 * 改成对 key 做 djb2 哈希取模后 (a)(b) 都解决了，但必须确认没有
 * 把「不同图片分散到不同 CDN」这个好处一起丢掉 —— 如果哈希分布退化，
 * 所有图片都会挤在同一个域名上。
 *
 * 这里直接从源码抽取真实的 pickBase 求值，而不是复制一份实现，
 * 避免工具与源码漂移。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var SRC = path.join(path.dirname(__dirname), 'src', 'page-interceptor.js');
var src = fs.readFileSync(SRC, 'utf8');

var mImg = src.match(/var IMG_BASES = \[[\s\S]*?\];/);
var mVid = src.match(/var VIDEO_BASES = \[[\s\S]*?\];/);
var mPick = src.match(/function pickBase\s*\(bases, key\) \{[\s\S]*?\n  \}/);

var missing = [];
if (!mImg) missing.push('IMG_BASES');
if (!mVid) missing.push('VIDEO_BASES');
if (!mPick) missing.push('pickBase');
if (missing.length) {
  console.error('无法从源码抽取：' + missing.join(', ') + ' —— 源码结构变了，请同步本工具的抽取正则。');
  process.exit(1);
}

var ctx = vm.createContext({});
vm.runInContext([
  mImg[0], mVid[0], mPick[0],
  'this.__pick = pickBase; this.__img = IMG_BASES; this.__vid = VIDEO_BASES;'
].join('\n'), ctx);

var pickBase = ctx.__pick;
var IMG_BASES = ctx.__img;
var VIDEO_BASES = ctx.__vid;

/* ============================ 样本 ============================ */

function rndKey(prefix, n) {
  var A = 'abcdefghijklmnopqrstuvwxyz0123456789';
  var s = '';
  for (var i = 0; i < n; i++) s += A[Math.floor(Math.random() * A.length)];
  return prefix + s;
}

var GROUPS = [
  { label: '真实形状 fileKey（随机 24 位）', n: 20000, gen: function () { return rndKey('1040g2sg31', 16); } },
  { label: '真实形状 fileKey（带 notes_pre_post/ 前缀）', n: 20000, gen: function () { return 'notes_pre_post/' + rndKey('1040g2sg31', 16); } },
  { label: '顺序编号 key（最坏情况：只差最后几位）', n: 2000, gen: function (i) { return '1040g2sg31img' + i; } },
  { label: '连续递增 key（更极端）', n: 2000, gen: function (i) { return 'k' + i; } },
  { label: '中文标题派生的 key', n: 2000, gen: function (i) { return '标题_' + i + '_第几张'; } }
];

console.log('================================================================');
console.log('pickBase — CDN 域名分布检查');
console.log('  IMG_BASES   = ' + IMG_BASES.length + ' 个：' + IMG_BASES.map(function (b) { return b.replace(/^https:\/\//, '').replace(/\/$/, ''); }).join(', '));
console.log('  VIDEO_BASES = ' + VIDEO_BASES.length + ' 个：' + VIDEO_BASES.map(function (b) { return b.replace(/^https:\/\//, '').replace(/\/$/, ''); }).join(', '));
console.log('----------------------------------------------------------------');

var bad = [];

GROUPS.forEach(function (g) {
  var counts = {};
  IMG_BASES.forEach(function (b) { counts[b] = 0; });
  var first = null;
  var stable = true;

  for (var i = 0; i < g.n; i++) {
    var key = g.gen(i);
    var b1 = pickBase(IMG_BASES, key);
    var b2 = pickBase(IMG_BASES, key);      // 同 key 必须永远同结果
    if (b1 !== b2) stable = false;
    if (!(b1 in counts)) {
      bad.push(g.label + '：返回了不在 IMG_BASES 中的域名 ' + b1);
      continue;
    }
    counts[b1]++;
    if (first === null) first = b1;
  }

  var vals = IMG_BASES.map(function (b) { return counts[b]; });
  var used = vals.filter(function (v) { return v > 0; }).length;
  var min = Math.min.apply(null, vals);
  var max = Math.max.apply(null, vals);
  var expect = g.n / IMG_BASES.length;
  // 均匀性：最多与最少之比不超过 1.5 视为可接受（仅对随机样本有意义）
  var skew = min === 0 ? Infinity : max / min;

  console.log('  ' + g.label);
  console.log('    ' + vals.join(' / ') + '   （期望各 ≈ ' + Math.round(expect) + '）');
  console.log('    命中域名数=' + used + '/' + IMG_BASES.length + '   同 key 结果稳定=' + (stable ? '是' : '否') + '   最多/最少=' + (skew === Infinity ? '∞（有域名为 0）' : skew.toFixed(2)));

  if (!stable) bad.push(g.label + '：同一 key 两次调用结果不一致（确定性被破坏）');
  if (used < 2 && g.n >= IMG_BASES.length * 4) bad.push(g.label + '：只命中 ' + used + ' 个域名，分布退化');
});

console.log('----------------------------------------------------------------');
console.log('确定性：同一 key 在任何时刻都返回同一域名 —— 上面各组均为「是」才算通过');
console.log('分散性：大量不同 key 应命中全部 ' + IMG_BASES.length + ' 个域名');

if (bad.length) {
  console.log('');
  console.log('失败 ' + bad.length + ' 项：');
  bad.forEach(function (b) { console.log('  ✗ ' + b); });
} else {
  console.log('');
  console.log('全部通过 ✅');
}
console.log('================================================================');

process.exit(bad.length ? 1 : 0);
