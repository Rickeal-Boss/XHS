/**
 * 极简测试框架（无外部依赖）
 * 用法： node test-xxx.js
 */
'use strict';

var results = [];
var currentSuite = '(root)';

function suite(name) {
  currentSuite = name;
  console.log('\n=== ' + name + ' ===');
}

function record(id, name, expected, actual, ok, note) {
  results.push({
    suite: currentSuite,
    id: id,
    name: name,
    expected: expected,
    actual: actual,
    ok: ok,
    note: note || ''
  });
  var mark = ok ? 'PASS' : 'FAIL';
  console.log('[' + mark + '] ' + id + ' ' + name);
  if (!ok) {
    console.log('        expected: ' + fmt(expected));
    console.log('        actual  : ' + fmt(actual));
    if (note) console.log('        note    : ' + note);
  }
}

function fmt(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

/** 严格相等断言 */
function eq(id, name, actual, expected, note) {
  record(id, name, expected, actual, actual === expected, note);
}

/** 深比较断言（JSON 序列化） */
function deepEq(id, name, actual, expected, note) {
  var a = JSON.stringify(actual);
  var b = JSON.stringify(expected);
  record(id, name, expected, actual, a === b, note);
}

/** 真值断言 */
function ok(id, name, cond, note, actual) {
  record(id, name, true, cond, !!cond, note || ('actual=' + fmt(actual)));
}

/** 断言函数不抛异常，返回 [ok, valueOrError] */
function noThrow(id, name, fn, note) {
  try {
    var v = fn();
    record(id, name, '<no throw>', '<no throw>', true, note);
    return [true, v];
  } catch (e) {
    record(id, name, '<no throw>', 'THREW: ' + e.message, false, note);
    return [false, e];
  }
}

function summary(title) {
  var pass = results.filter(function (r) { return r.ok; }).length;
  var fail = results.length - pass;
  console.log('\n' + '='.repeat(64));
  console.log(title + ' — 共 ' + results.length + ' 条断言：通过 ' + pass + '，失败 ' + fail);
  if (fail) {
    console.log('\n失败用例：');
    results.filter(function (r) { return !r.ok; }).forEach(function (r) {
      console.log('  ✗ [' + r.suite + '] ' + r.id + ' ' + r.name);
      console.log('      expected=' + fmt(r.expected) + '  actual=' + fmt(r.actual));
      if (r.note) console.log('      note=' + r.note);
    });
  }
  console.log('='.repeat(64));
  return { total: results.length, pass: pass, fail: fail, results: results };
}

module.exports = { suite: suite, eq: eq, deepEq: deepEq, ok: ok, noThrow: noThrow, summary: summary, fmt: fmt };
