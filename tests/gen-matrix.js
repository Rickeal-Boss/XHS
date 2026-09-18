/**
 * 从各套件的真实输出中解析断言，生成 Markdown 用例矩阵
 * 运行： node gen-matrix.js > _matrix.md
 */
'use strict';
var fs = require('fs');
var path = require('path');

var files = [
  ['_out-downloader.txt', 'A. downloader.js 纯函数'],
  ['_out-background.txt', 'B. background.js 路径处理与下载队列'],
  ['_out-extractor.txt', 'C. page-interceptor.js 提取引擎'],
  ['_out-static.txt', 'D. 静态一致性 / 内容脚本装配']
];

var lines = [];
lines.push('| 用例 | 用例说明 | 预期 | 实际 | 结论 |');
lines.push('|---|---|---|---|---|');

var total = 0, pass = 0, fail = 0;

files.forEach(function (f) {
  var txt = fs.readFileSync(path.join(__dirname, f[0]), 'utf8');
  lines.push('| | **' + f[1] + '** | | | |');
  var curSuite = '';
  txt.split('\n').forEach(function (l) {
    var ms = l.match(/^=== (.+) ===$/);
    if (ms) { curSuite = ms[1]; return; }
    var m = l.match(/^\[(PASS|FAIL)\] (\S+) (.+)$/);
    if (!m) return;
    total++;
    var okFlag = m[1] === 'PASS';
    if (okFlag) pass++; else fail++;
    lines.push('| `' + m[2] + '` | ' + (curSuite ? curSuite + ' — ' : '') + esc(m[3]) +
      ' | 符合规范 | ' + (okFlag ? '符合规范' : '**不符合规范**') +
      ' | ' + (okFlag ? '✅ 通过' : '❌ 失败') + ' |');
  });
});

function esc(s) { return String(s).replace(/\|/g, '\\|'); }

lines.push('');
lines.push('> 合计 **' + total + '** 条断言：通过 **' + pass + '**，失败 **' + fail + '**。');
process.stdout.write(lines.join('\n') + '\n');
