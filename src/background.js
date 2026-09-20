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

/**
 * 批次存续标记。批次开始时写入，正常结束时删除。
 * SW 每次启动都会执行文件末尾的自检：只要还残留这条记录，
 * 就说明上一批是在执行中途被回收打断的，需要补发 DL_ALL_DONE。
 */
var BATCH_KEY = 'xhs_dl_batch';

/** downloadId -> {resolve, task, tabId} */
var pending = new Map();
/** 当前批次的活跃状态（SW 回收后丢失，仅作缓存；权威值在 session） */
var active = null;

/* ========================= URL 白名单 ========================= */
/**
 * 纵深防御：内容脚本已经过滤过一遍，但 Service Worker 是最终执行者，
 * 这里必须独立再校验一次，确保扩展永远不会去下载
 * file:// / javascript: / data: 等危险 scheme，或第三方域名的文件
 * —— 否则扩展就成了「任意文件下发器」。
 */
/**
 * 小红书自家 CDN 与站点域名。
 * rednote.com 是小红书的国际站（同步一份代码，CDN 为 sns-web-i10.rednotecdn.com），
 * 早期白名单只认 xhscdn，会导致国际站的图片/视频直链被判定为「非本站资源」直接丢弃。
 */
var ALLOWED_HOST_RE = /(^|\.)(xhscdn\.com|xhscdn\.net|rednotecdn\.com|xiaohongshu\.com|rednote\.com)$/i;

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

/** 文件名主体至少保留的字符数（超出预算时也不会被压成空名） */
var MIN_BASE = 12;

/**
 * 截断收尾：Windows 会静默剥离段尾的点与空格，
 * 导致实际落盘的目录/文件名与预期不符。这里主动清掉。
 * 注意只会缩短或等长（空串补 '_' 恰好 1 字符），
 * 因此调用方的长度预算依然成立。
 */
function tidyTail(s) {
  return s.replace(/[.\s]+$/, '') || '_';
}

/**
 * 把目录段压到总长不超过 maxTotal。
 *
 * 采用「水位法」而不是按比例切：短段（如作者昵称）尽量完整保留，
 * 只把过长的那几段削到统一上限，这样截断结果更符合直觉。
 * 段数本身就超预算时，从尾部丢弃层级（保留更靠外的 baseDir）。
 */
function shrinkSegs(segs, maxTotal) {
  while (segs.length > 1 && segs.length > maxTotal) segs = segs.slice(0, segs.length - 1);

  var i, total = 0;
  for (i = 0; i < segs.length; i++) total += segs[i].length;
  if (total <= maxTotal) return segs;

  // 二分求统一上限 cap：使 sum(min(len, cap)) 尽可能大且不超过 maxTotal
  var lo = 1, hi = 0;
  for (i = 0; i < segs.length; i++) if (segs[i].length > hi) hi = segs[i].length;
  while (lo < hi) {
    var mid = Math.ceil((lo + hi) / 2);
    var sum = 0;
    for (i = 0; i < segs.length; i++) sum += Math.min(segs[i].length, mid);
    if (sum <= maxTotal) lo = mid; else hi = mid - 1;
  }

  var out = [];
  var used = 0;
  for (i = 0; i < segs.length; i++) {
    var cut = Math.min(segs[i].length, lo);
    out.push(segs[i].slice(0, cut));
    used += cut;
  }
  // 二分给的是「不超过」的上限，可能仍有零头，按顺序补给尚未被截断的段
  var spare = maxTotal - used;
  for (i = 0; i < out.length && spare > 0; i++) {
    var room = segs[i].length - out[i].length;
    if (room > 0) {
      var add = Math.min(spare, room);
      out[i] = segs[i].slice(0, out[i].length + add);
      spare -= add;
    }
  }
  // 截断可能让段以点或空格结尾（Windows 会静默剥离，导致实际目录名与预期不符）
  for (i = 0; i < out.length; i++) out[i] = tidyTail(out[i]);
  return out;
}

/**
 * 组装安全的下载相对路径。
 *
 * MAX_PATH 约束的是**全路径**，而且不只是文件名会超：
 * baseDir / 作者 / 标题 三级目录本身就可能吃掉全部预算。
 * 早期实现只截文件名主体，当目录总长已经超过 MAX_PATH_LEN 时
 * room 变负、被兜底成 8，整条路径依然严重超标
 * （缺陷 D-04：实测 222 / 208 字符，远超 180 的预算）。
 * 因此这里两级都要压，并保证不变式：
 *   sum(目录段长) + 段数 + 文件名主体长 + 扩展名长 ≤ MAX_PATH_LEN
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

  // 段数本身 + 分隔符就可能撑爆预算 → 先从尾部丢弃多余层级
  var maxSegs = MAX_PATH_LEN - MIN_BASE - 1 - ext.length;
  if (maxSegs < 1) maxSegs = 1;
  if (segs.length > maxSegs) segs = segs.slice(0, maxSegs);

  // 预算 = 目录段总长 + 文件名主体长（分隔符与扩展名是固定开销）
  var budget = MAX_PATH_LEN - segs.length - ext.length;

  var i, segTotal = 0;
  for (i = 0; i < segs.length; i++) segTotal += segs[i].length;

  // 1) 目录过长 → 先压目录，给文件名主体留出至少 nameMin
  var nameMin = Math.min(base.length, MIN_BASE);
  if (segTotal + nameMin > budget) {
    segs = shrinkSegs(segs, budget - nameMin);
    segTotal = 0;
    for (i = 0; i < segs.length; i++) segTotal += segs[i].length;
  }

  // 2) 再用剩余预算压文件名主体
  var room = budget - segTotal;
  if (room < 1) room = 1;
  if (base.length > room) base = base.slice(0, room);
  base = tidyTail(base);

  return segs.concat([base + ext]).join('/');
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

/* ========================= 批次存续标记 ========================= */

function getBatch() {
  return new Promise(function (resolve) {
    chrome.storage.session.get(BATCH_KEY, function (r) {
      resolve((r && r[BATCH_KEY]) || null);
    });
  });
}

function setBatch(info) {
  return new Promise(function (resolve) {
    var o = {};
    o[BATCH_KEY] = info;
    chrome.storage.session.set(o, resolve);
  });
}

function clearBatch() {
  return new Promise(function (resolve) {
    chrome.storage.session.remove(BATCH_KEY, resolve);
  });
}

/** 局部更新批次记录（记录不存在时什么都不做） */
function updateBatch(patch) {
  return getBatch().then(function (b) {
    if (!b) return;
    Object.keys(patch).forEach(function (k) { b[k] = patch[k]; });
    return setBatch(b);
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

/* ========================= 取消 ========================= */

/**
 * 真正中断「正在下载的那一个」。
 * 只置 cancelled 标志是不够的：循环要到下一个任务开始前才 break，
 * 当前文件照样会下完，20 分钟的兜底超时也还在计时。
 */
function cancelCurrent() {
  var id = active && active.currentId != null ? active.currentId : null;
  if (id != null) {
    cancelDownload(id);
    return;
  }
  // SW 可能刚被回收过，当前 downloadId 只留在 session 里
  getBatch().then(function (b) {
    if (b && b.currentId != null) cancelDownload(b.currentId);
  });
}

function cancelDownload(id) {
  try {
    // 不调用 downloads.erase：用户可能还想在下载列表里找回这个文件
    chrome.downloads.cancel(id, function () {
      // 下载可能已经结束，忽略错误
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
    // 用户点了取消就不该再换备用直链继续下 —— 那等于取消了又没取消。
    // 每轮开始前重新读一次批次状态（取消标志跨 SW 重启存在 session 里）。
    var cur = await getBatch();
    if (cur && cur.cancelled) break;

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
    // 记下「当前正在下的这一个」：CANCEL_BATCH 要靠它真正中断文件，
    // 同时落 session，保证 SW 被回收后取消指令依然能找到这个 downloadId
    if (active) active.currentId = id;
    await updateBatch({ currentId: id });

    var stopPoll = pollBytes(id, tabId, task.name, state);
    var res = await waitForDownload(id);
    stopPoll();
    if (active && active.currentId === id) active.currentId = null;
    await updateBatch({ currentId: null });
    if (res.ok) {
      // 去重表必须同时记下「主直链」：runBatch 的跳过判断用的是 task.url，
      // 只记实际成功的备用直链，下次这一项仍会被当成没下过，
      // 于是又把主直链重试一遍失败、再回退一次。
      await markDone(task.url);
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

  // 批次开始就登记「本批存在」。若 SW 在此后中途被回收，
  // 这次写入会残留下来，成为启动自检补发 DL_ALL_DONE 的依据。
  await setBatch({
    tabId: tabId,
    noteId: noteId,
    startedAt: Date.now(),
    total: tasks.length,
    cancelled: false,
    currentId: null
  });

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
    // CANCEL_BATCH 会把 cancelled 落 session，每轮循环前重新读一次：
    // 取消指令不会因为 SW 恰好在这期间被回收而丢失
    var batchNow = await getBatch();
    if (batchNow && batchNow.cancelled) break;
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

  // 批次正常收尾（含被取消的收尾）→ 撤掉存续标记，避免下次启动误判为「被打断」
  await clearBatch();

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
      active = { cancelled: false, currentId: null };
      sendResponse({ ok: true, accepted: tasks.length });
      runBatch(tabId, tasks, msg.payload.noteId).then(function () {
        active = null;
      }).catch(function () {
        active = null;
        // 异常退出同样要撤掉存续标记，否则下次 SW 启动会误报「上一批被打断」
        clearBatch();
        notify(tabId, 'DL_ALL_DONE', { ok: 0, failed: tasks.map(function (t) { return t.name; }), total: tasks.length });
      });
      return false;
    }

    case 'CANCEL_BATCH': {
      if (active) active.cancelled = true;
      cancelCurrent();
      // 落 session：SW 若在这之后被回收，重启后的批次/去重逻辑仍能看到「已取消」
      updateBatch({ cancelled: true });
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

/* ===================== 启动自检（MV3 SW 回收恢复） ===================== */
/**
 * MV3 的 Service Worker 空闲约 30s 就会被回收。若回收恰好发生在批次执行中途，
 * 模块级的 pending / active 会随旧执行上下文一起消失：
 *   1. pending 清空 → onChanged 里 `if (!entry) return` → waitForDownload 的
 *      resolve 永远不会被调用；
 *   2. await waitForDownload(id) 连同旧上下文一起消失 → runBatch 的 for 循环中断；
 *   3. DL_ALL_DONE 永不发出 → 内容脚本的 XHS_DL_UI.setBusy(false) 永不执行，
 *      进度条永久卡住、isBusy() 恒为 true，之后任何下载都被「上一批还没结束」拒绝，
 *      用户只能刷新页面才能恢复。
 *
 * pending 里含 Promise resolve，存不进 storage，所以不做「恢复」而做「宣告失败」：
 * 批次开始时写 BATCH_KEY，正常结束时删掉。SW 每次启动都会执行下面这段，
 * 只要 BATCH_KEY 还在，就说明上一批被打断了，补发一条带 interrupted 的
 * DL_ALL_DONE 让内容脚本解除忙碌状态。
 */
getBatch().then(function (b) {
  if (!b) return;
  notify(b.tabId, 'DL_ALL_DONE', {
    ok: 0,
    failed: [],
    total: b.total || 0,
    skipped: 0,
    lastError: 'interrupted',
    interrupted: true
  });
  return clearBatch();
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
          streamPreference: 'compat',
          liveMode: 'both',
          dirByAuthor: false,
          dirByTitle: false,
          baseDir: '小红书下载',
          hookEnabled: true,
          spaSource: true
        }
      });
    }
  });
});
