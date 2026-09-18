/**
 * manifest.json 完整性检查。
 * 运行： node tools/check_manifest.js
 *
 * 目的：manifest 里写的路径如果和实际文件对不上，扩展在本地「加载已解压的
 * 扩展」时才会报错，而这一步在 CI 里没人做。这里把最常见的几类低级错误
 * 提前拦住：
 *   - JSON 语法错误
 *   - content_scripts / background / popup / options / icons 指向的文件不存在
 *   - MV3 必填字段缺失或写法错误
 *   - 版本号不符合 x.y.z
 *   - 声明了 host_permissions 却没有对应的 content_scripts matches（反之亦然），
 *     这类不一致会让扩展在部分页面静默失效
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.dirname(__dirname);
var fails = [];
var total = 0;

function ok(id, desc, cond, detail) {
  total++;
  if (cond) {
    console.log('[PASS] ' + id + ' ' + desc);
  } else {
    console.log('[FAIL] ' + id + ' ' + desc + (detail ? '\n        ' + detail : ''));
    fails.push(id + ' ' + desc + (detail ? ' — ' + detail : ''));
  }
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

/* ------------------------------ 读取 ------------------------------ */
var raw;
try {
  raw = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
} catch (e) {
  console.error('无法读取 manifest.json：' + e.message);
  process.exit(1);
}

// 去掉 UTF-8 BOM，否则 JSON.parse 会抛错
if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

var m;
try {
  m = JSON.parse(raw);
} catch (e) {
  console.error('manifest.json 不是合法 JSON：' + e.message);
  process.exit(1);
}

console.log('=== manifest 结构 ===');
ok('MF-1', 'manifest_version 为 3', m.manifest_version === 3, '实际 ' + m.manifest_version);
ok('MF-2', '存在 name', typeof m.name === 'string' && !!m.name);
ok('MF-3', '存在 version', typeof m.version === 'string' && !!m.version);
ok('MF-4', 'version 符合 x.y.z', /^\d+\.\d+\.\d+$/.test(m.version || ''), '实际 ' + m.version);
ok('MF-5', '存在 description', typeof m.description === 'string' && !!m.description);
ok('MF-6', '声明了 default_locale 或未使用 __MSG_ 占位（避免未本地化的原始字符串）',
  typeof m.default_locale === 'string' || raw.indexOf('__MSG_') === -1,
  '出现了 __MSG_ 但没有 default_locale');

/* ------------------------------ 图标 ------------------------------ */
console.log('');
console.log('=== 图标 ===');
var iconSizes = m.icons ? Object.keys(m.icons) : [];
ok('MF-7', '声明了 icons', iconSizes.length > 0);
var iconMissing = iconSizes.filter(function (s) { return !exists(m.icons[s]); });
ok('MF-8', 'icons 指向的文件均存在', iconMissing.length === 0,
  '缺失：' + JSON.stringify(iconMissing));

/* ------------------------------ 后台 ------------------------------ */
console.log('');
console.log('=== 后台 ===');
ok('MF-9', 'MV3 使用 service_worker', !!(m.background && m.background.service_worker),
  'MV3 不支持 background.scripts/persistent');
ok('MF-10', '未声明已废弃的 background.persistent',
  !(m.background && m.background.persistent));
if (m.background && m.background.service_worker) {
  ok('MF-11', 'service_worker 文件存在', exists(m.background.service_worker),
    m.background.service_worker);
}

/* ------------------------------ 内容脚本 ------------------------------ */
console.log('');
console.log('=== 内容脚本 ===');
var cs = m.content_scripts || [];
ok('MF-12', '至少声明一组 content_scripts', cs.length > 0);
var jsMissing = [];
cs.forEach(function (c) {
  (c.js || []).forEach(function (f) { if (!exists(f)) jsMissing.push(f); });
  (c.css || []).forEach(function (f) { if (!exists(f)) jsMissing.push(f); });
});
ok('MF-13', 'content_scripts 引用的文件均存在', jsMissing.length === 0,
  '缺失：' + JSON.stringify(jsMissing));

// 页面世界脚本必须在隔离世界脚本之前注入（document_start 时顺序由数组顺序决定）
var hasMain = cs.some(function (c) { return c.world === 'MAIN'; });
ok('MF-14', '存在 world=MAIN 的拦截器（零签名旁路监听的前提）', hasMain);
var mainEntry = cs.filter(function (c) { return c.world === 'MAIN'; })[0];
if (mainEntry) {
  ok('MF-15', 'MAIN 世界脚本在 document_start 注入', mainEntry.run_at === 'document_start',
    '实际 ' + mainEntry.run_at);
}

/* ------------------------------ 页面 ------------------------------ */
console.log('');
console.log('=== 页面 ===');
if (m.action && m.action.default_popup) {
  ok('MF-16', 'popup 文件存在', exists(m.action.default_popup), m.action.default_popup);
}
if (m.options_page) {
  ok('MF-17', 'options 文件存在', exists(m.options_page), m.options_page);
}
if (m.options_ui && m.options_ui.page) {
  ok('MF-18', 'options_ui.page 文件存在', exists(m.options_ui.page), m.options_ui.page);
}

/* ------------------------------ 权限一致性 ------------------------------ */
console.log('');
console.log('=== 权限一致性 ===');
var perms = m.permissions || [];
ok('MF-19', '声明了 downloads 权限', perms.indexOf('downloads') !== -1);
ok('MF-20', '未声明 <all_urls>（最小权限原则）', perms.indexOf('<all_urls>') === -1,
  '实际 permissions=' + JSON.stringify(perms));

var hosts = m.host_permissions || [];
var matchHosts = {};
cs.forEach(function (c) { (c.matches || []).forEach(function (p) { matchHosts[p] = 1; }); });

// 每个 content_scripts match 都应落在 host_permissions 覆盖范围内
function hostOf(pattern) {
  var mm = pattern.match(/^[a-z*]+:\/\/([^/]+)/i);
  return mm ? mm[1] : '';
}
var permHosts = hosts.map(hostOf);
var uncovered = Object.keys(matchHosts).filter(function (p) {
  var h = hostOf(p);
  if (!h) return false;
  return !permHosts.some(function (ph) {
    if (ph === h) return true;
    // host_permissions 用 *.example.com 覆盖 a.example.com
    if (ph.indexOf('*.') === 0) {
      var tail = ph.slice(1);            // ".example.com"
      return h === ph.slice(2) || h.indexOf(tail) !== -1;
    }
    return false;
  });
});
ok('MF-21', 'content_scripts 的每个 match 都被 host_permissions 覆盖',
  uncovered.length === 0, '未覆盖：' + JSON.stringify(uncovered));

var unusedPerm = permHosts.filter(function (ph) {
  return !Object.keys(matchHosts).some(function (p) {
    var h = hostOf(p);
    if (h === ph) return true;
    if (ph.indexOf('*.') === 0) {
      var tail = ph.slice(1);
      return h.indexOf(tail) !== -1 || h === ph.slice(2);
    }
    return false;
  });
});
ok('MF-22', 'host_permissions 没有多余声明（最小权限）', unusedPerm.length === 0,
  '多余：' + JSON.stringify(unusedPerm));

ok('MF-23', '未声明 webRequest / declarativeNetRequest（CDN 实测不需要改写请求头）',
  perms.indexOf('webRequest') === -1 && perms.indexOf('webRequestBlocking') === -1 &&
  perms.indexOf('declarativeNetRequest') === -1,
  '实际 permissions=' + JSON.stringify(perms));

ok('MF-24', '未声明 tabs 权限（进度回传走 sender.tab.id，不需要它）',
  perms.indexOf('tabs') === -1 && perms.indexOf('activeTab') === -1);

/* ------------------------------ 汇总 ------------------------------ */
console.log('');
console.log('================================================================');
console.log('check-manifest — 共 ' + total + ' 条断言：通过 ' + (total - fails.length) + '，失败 ' + fails.length);
if (fails.length) {
  console.log('');
  console.log('失败明细：');
  fails.forEach(function (f) { console.log('  ✗ ' + f); });
}
console.log('================================================================');
process.exit(fails.length ? 1 : 0);
