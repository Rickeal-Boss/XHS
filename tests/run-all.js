/**
 * 一键运行全部测试套件并汇总
 * 运行： node run-all.js
 */
'use strict';
var cp = require('child_process');
var path = require('path');

var NODE = process.execPath;
var suites = [
  ['test-downloader.js', ['TZ=UTC']],
  ['test-background.js', []],
  ['test-extractor.js', []],
  ['test-static.js', []]
];

var totals = { total: 0, pass: 0, fail: 0 };
var failedLines = [];

suites.forEach(function (s) {
  var file = path.join(__dirname, s[0]);
  var env = Object.assign({}, process.env, { TZ: 'UTC' });
  var r = cp.spawnSync(NODE, [file], { encoding: 'utf8', env: env });
  var out = (r.stdout || '') + (r.stderr || '');
  var m = out.match(/共 (\d+) 条断言：通过 (\d+)，失败 (\d+)/);
  if (m) {
    totals.total += Number(m[1]);
    totals.pass += Number(m[2]);
    totals.fail += Number(m[3]);
    console.log(pad(s[0], 22) + ' 断言 ' + pad(m[1], 5) + ' 通过 ' + pad(m[2], 5) + ' 失败 ' + m[3]);
  } else {
    console.log(pad(s[0], 22) + ' 运行异常（未产出汇总）');
    console.log(out.split('\n').slice(-15).join('\n'));
  }
  out.split('\n').forEach(function (l) {
    if (/^\s*✗/.test(l)) failedLines.push(s[0] + ' ' + l.trim());
  });
});

function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

console.log('');
console.log('总计：' + totals.total + ' 条断言，通过 ' + totals.pass + '，失败 ' + totals.fail +
  '，通过率 ' + (totals.total ? (totals.pass / totals.total * 100).toFixed(1) : '0') + '%');
if (failedLines.length) {
  console.log('\n失败明细：');
  failedLines.forEach(function (l) { console.log('  ' + l); });
}
process.exit(totals.fail ? 1 : 0);
