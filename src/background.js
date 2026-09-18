/**
 * 小红书下载助手 — 后台 Service Worker
 * ------------------------------------------------------------------
 * 职责：
 *   1. 接收内容脚本下发的下载批次，串行执行 chrome.downloads.download
 *   2. 单个文件失败时自动尝试备用直链（origin ↔ stream 互换）
 *   3. 按 URL 去重：同一会话内已下过的资源直接跳过，避免产出 (1)(2) 垃圾
 *   4. 进度回传**必须使用发起方 sender.tab.id**，绝不用 tabs.query({active:true})
 *      —— 否则用户切了标签页会把进度打到错误的页面上
 *
 * MV3 注意：Service Worker 随时可能被回收，因此所有需要跨唤醒存活的
 * 状态都放在 chrome.storage.session，不依赖模块级变量。
 */

'use strict';

/* ============================ 常量 ============================ */

/** Windows 保留设备名，作为文件名会直接失败 */
var RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** 全路径长度上限。Windows MAX_PATH=260，需预留用户下载目录本身与临时后缀 */
var MAX_PATH_LEN = 180;

var DONE_KEY = 'xhs_dl_done_urls';
var DONE_LIMIT = 3000;

/** downloadId -> {resolve, task, tabId} */
var pending = new Map();
/** 当前批次的活跃状态 */
var active = null;

/* ========================= URL 白名单 ========================= */
/**
 * 纵深防御：内容脚本已经过滤过一遍，但 Service Worker 是最终执行者，
 * 这里必须独立再校验一次，确保扩展永远不会去下载
 * file:// / javascript: / data: 等危险 scheme，或第三方域名的文件
 * —— 否则扩展就成了「任意文件下发器」。
 */
var ALLOWED_HOST_RE = /(^|\.)(xhscdn\.com|xhscdn\.net|xiaohongshu\.com)$/i;

function isDownloadableUrl(u) {
  if (typeof u !== 'string' || !u) return false;
  try {
    var url = new URL(u);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    return ALLOWED_HOST_RE.test(url.hostname);
  } catch (e) {
    return false;
  }
}

/* ========================= 路径 / 文件名 ========================= */

/**
 * 需要替换掉的字符：
 *   - ASCII 非法字符 \ / : * ? " < > |
 *   - 控制字符
 *   - Unicode 里外形酷似「路径分隔符」的字符（／＼．․∕⁄⧸），
 *     防止某些平台的 NFC/NFKC 规范化把它们折叠成真分隔符后造成路径穿越。
 *     注意不含全角冒号「：」等中文常用标点 —— 它们不是分隔符，
 *     替换掉只会让中文文件名变得难看。
 */
var ILLEGAL_RE = /[\\/:*?"<>|\u0000-\u001f\u007f\uFF0F\uFF3C\uFF0E\u2024\u2215\u2044\u29F8]/g;

function sanitizeSegment(seg) {
  var out = String(seg == null ? '' : seg)
    .replace(ILLEGAL_RE, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')                              // 开头点/空格
    .replace(/[.\s]+$/, '');                             // 结尾点/空格（Windows 禁用）
  if (!out) out = '_';
  if (RESERVED_RE.test(out)) out = '_' + out;           // 保留设备名
  return out;
}

/**
 * 组装安全的下载相对路径。
 * 注意：MAX_PATH 约束的是**全路径**，只截文件名是不够的，
 * 因此这里在拼好之后统一做长度兜底。
 */
function buildPath(dir, name) {
  var segs = String(dir || '')
    .split('/')
    .map(sanitizeSegment)
    .filter(function (s) { return s && s !== '_'; });

  var fileName = sanitizeSegment(name);
  // 分离扩展名，截断时保留后缀
  var dot = fileName.lastIndexOf('.');
  var base = dot > 0 ? fileName.slice(0, dot) : fileName;
  var ext = dot > 0 ? fileName.slice(dot) : '';

  var full = segs.concat([base + ext]).join('/');
  if (full.length > MAX_PATH_LEN) {
    var room = MAX_PATH_LEN - (segs.join('/').length + segs.length) - ext.length;
    if (room < 8) room = 8;
    base = base.slice(0, room);
    full = segs.concat([base + ext]).join('/');
  }
  return full;
}

/* ========================= 已下载去重表 ========================= */

function getDone() {
  return new Promise(function (resolve) {
    chrome.storage.session.get(DONE_KEY, function (r) {
      resolve((r && r[DONE_KEY]) || []);
    });
  });
}

function markDone(url) {
  return getDone().then(function (list) {
    if (list.indexOf(url) !== -1) return;
    list.push(url);
    if (list.length > DONE_LIMIT) list = list.slice(list.length - DONE_LIMIT);
    return new Promise(function (resolve) {
      chrome.storage.session.set({ [DONE_KEY]: list }, resolve);
    });
  });
}

/* ========================= 消息下发 ========================= */

/**
 * 把进度回传给**发起下载的那个标签页**。
 * sender.tab.id 是唯一可靠的定位方式，切标签页不会串台。
 */
function notify(tabId, type, payload) {
  if (tabId == null) return;
  try {
    chrome.tabs.sendMessage(tabId, { type: type, payload: payload }, function () {
      // 标签页可能已关闭或未注入内容脚本，忽略最后一个错误
      void chrome.runtime.lastError;
    });
  } catch (e) { /* 忽略 */ }
}

/* ========================= 下载核心 ========================= */

function waitForDownload(id) {
  return new Promise(function (resolve) {
    var entry = pending.get(id);
    if (!entry) {
      resolve({ ok: false, error: 'unknown-download' });
      return;
    }
    entry.resolve = resolve;
    // 兜底超时：20 分钟仍未结束视为失败，避免批次永久挂起
    entry.timer = setTimeout(function () {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }
    }, 20 * 60 * 1000);
  });
}

chrome.downloads.onChanged.addListener(function (delta) {
  var entry = pending.get(delta.id);
  if (!entry) return;

  if (!delta.state) return;
  var s = delta.state.current;
  if (s === 'complete') {
    clearTimeout(entry.timer);
    pending.delete(delta.id);
    entry.resolve({ ok: true });
  } else if (s === 'interrupted') {
    clearTimeout(entry.timer);
    pending.delete(delta.id);
    entry.resolve({
      ok: false,
      error: (delta.error && delta.error.current) || 'interrupted'
    });
  }
});

/**
 * 单文件字节级进度轮询。
 * 只有条目级进度时，下载一个大视频进度条会长时间停在 0%，体验很差，
 * 因此对「当前正在下的这一个」做 800ms 轮询，拿到真实字节进度。
 */
function pollBytes(id, tabId, name, state) {
  var stopped = false;
  function tick() {
    if (stopped) return;
    chrome.downloads.search({ id: id }, function (items) {
      if (stopped) return;
      var it = items && items[0];
      if (it && it.totalBytes > 0) {
        notify(tabId, 'DL_ITEM_PROGRESS', {
          name: name,
          pct: Math.round((it.bytesReceived / it.totalBytes) * 100),
          done: state.done,
          totalItems: state.total
        });
      }
      if (!stopped) setTimeout(tick, 800);
    });
  }
  setTimeout(tick, 800);
  return function () { stopped = true; };
}

/**
 * 下载单个任务，失败时按 fallbacks 顺序重试其他直链。
 * @returns {Promise<boolean>} 是否成功
 */
async function downloadOne(task, tabId, state) {
  var urls = [task.url].concat(task.fallbacks || []).filter(function (u, i, a) {
    return isDownloadableUrl(u) && a.indexOf(u) === i;
  });

  if (!urls.length) {
    state.failed.push(task.name || 'unknown');
    state.lastError = 'url-rejected';
    return false;
  }

  for (var i = 0; i < urls.length; i++) {
    var path = buildPath(task.dir, task.name);
    var id;
    try {
      id = await chrome.downloads.download({
        url: urls[i],
        filename: path,
        conflictAction: 'uniquify',
        saveAs: false
      });
    } catch (e) {
      // 文件名非法 / URL 非法：换下一个直链或直接放弃
      continue;
    }

    if (id == null) continue;

    pending.set(id, { task: task, tabId: tabId });

    var stopPoll = pollBytes(id, tabId, task.name, state);
    var res = await waitForDownload(id);
    stopPoll();
    if (res.ok) {
      await markDone(urls[i]);
      return true;
    }
    // 失败：把原因记下来，换备用直链再试
    state.lastError = res.error;
  }

  state.failed.push(task.name);
  return false;
}

/**
 * 串行执行一批下载。串行是刻意的：并发下载会被 CDN 限频，
 * 且串行更容易给出准确的进度反馈。
 */
async function runBatch(tabId, tasks, noteId) {
  var state = { done: 0, total: tasks.length, failed: [], lastError: '', noteId: noteId };

  // 去重：同一会话内已成功下载过的 URL 直接跳过
  var doneList = await getDone();
  var todo = tasks.filter(function (t) { return doneList.indexOf(t.url) === -1; });
  var skipped = tasks.length - todo.length;

  if (skipped) {
    notify(tabId, 'DL_SKIPPED', { count: skipped });
  }

  state.total = todo.length;
  notify(tabId, 'DL_START', { total: tasks.length, pending: todo.length, skipped: skipped });

  for (var i = 0; i < todo.length; i++) {
    if (!active || active.cancelled) break;
    var task = todo[i];
    notify(tabId, 'DL_PROGRESS', {
      done: state.done,
      total: todo.length,
      current: task.name,
      skipped: skipped
    });
    await downloadOne(task, tabId, state);
    state.done++;
  }

  notify(tabId, 'DL_ALL_DONE', {
    ok: state.done - state.failed.length,
    failed: state.failed.slice(),
    total: tasks.length,
    skipped: skipped,
    lastError: state.lastError
  });
  return state;
}

/* ========================= 消息入口 ========================= */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return false;

  // 只接受来自本扩展自身（内容脚本 / popup / options）的消息
  if (!sender || sender.id !== chrome.runtime.id) return false;

  // 一律以 sender.tab.id 为准，绝不信任消息里传来的 tabId
  var tabId = sender.tab ? sender.tab.id : null;

  switch (msg.type) {
    case 'DOWNLOAD_BATCH': {
      if (active) {
        sendResponse({ ok: false, error: 'busy' });
        return false;
      }
      var tasks = (msg.payload && msg.payload.tasks) || [];
      if (!tasks.length) {
        sendResponse({ ok: false, error: 'empty' });
        return false;
      }
      // 防御性上限：单批次不超过 300 个文件，避免被页面脚本诱导
      // 发起海量下载请求（相当于滥用扩展的下载能力）
      if (tasks.length > 300) {
        sendResponse({ ok: false, error: 'too-many' });
        return false;
      }
      active = { cancelled: false };
      sendResponse({ ok: true, accepted: tasks.length });
      runBatch(tabId, tasks, msg.payload.noteId).then(function () {
        active = null;
      }).catch(function () {
        active = null;
        notify(tabId, 'DL_ALL_DONE', { ok: 0, failed: tasks.map(function (t) { return t.name; }), total: tasks.length });
      });
      return false;
    }

    case 'CANCEL_BATCH': {
      if (active) active.cancelled = true;
      sendResponse({ ok: true });
      return false;
    }

    case 'PING':
      sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
      return false;

    default:
      return false;
  }
});

/* ========================= 安装初始化 ========================= */

chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.local.get('xhs_settings', function (r) {
    if (!r || !r.xhs_settings) {
      chrome.storage.local.set({
        xhs_settings: {
          nameRule: '[<发布者昵称>] <标题>_<序号>',
          timeFormat: 'YYYYMMDD',
          imageFormat: 'origin',
          videoQuality: 'origin',
          liveMode: 'both',
          dirByAuthor: false,
          dirByTitle: false,
          baseDir: '小红书下载',
          useTimeInName: false,
          hookEnabled: true
        }
      });
    }
  });
});
