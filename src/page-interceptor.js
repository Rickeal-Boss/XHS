/**
 * 小红书下载助手 — 页面世界（MAIN world）拦截与提取引擎
 * ------------------------------------------------------------------
 * 运行环境：content_scripts，world: "MAIN"，run_at: "document_start"
 *
 * 设计原则（吸取开源方案教训）：
 *   1. 只包裹 XHR / fetch 用于「读 JSON」，绝不 clone 媒体（video/image）响应，
 *      否则会把整段视频缓冲进内存，拖垮甚至阻断播放。
 *   2. 所有拦截逻辑用 try/catch 包裹，任何异常都不能影响宿主页面。
 *   3. 拦截器只在 document_start 注入一次，幂等保护。
 *   4. 数据来源三级降级：__INITIAL_STATE__ → 页面自身 API 响应 → performance 资源条目。
 *
 * 之所以能做到「零签名」：扩展运行在真实浏览器会话内，页面自己会带着
 * 合法的 x-s / x-t 签名去请求 /api/sns/web/v1/feed，我们只需旁路监听即可，
 * 完全不需要逆向小红书的签名算法。
 */
(function () {
  'use strict';

  var FLAG = '__XHS_DL_INTERCEPTOR__';
  if (window[FLAG]) return;
  window[FLAG] = true;

  /* ============================ 常量 ============================ */

  var CHANNEL = 'xhs-dl';

  /** 图片 CDN 基础域名（原图需换域名重拼） */
  var IMG_BASES = [
    'https://sns-img-hw.xhscdn.net/',
    'https://sns-img-bd.xhscdn.com/',
    'https://sns-img-qc.xhscdn.com/',
    'https://ci.xiaohongshu.com/'
  ];

  /** 视频 CDN 基础域名（原画质需换域名重拼） */
  var VIDEO_BASES = [
    'https://sns-video-hw.xhscdn.com/',
    'https://sns-video-bd.xhscdn.com/',
    'https://sns-video-al.xhscdn.com/'
  ];

  /** 从常规图 URL 中提取 fileKey，用于拼接原图地址 */
  var FILE_KEY_RE = /(?<=\/)(?:spectrum\/)?(?:(?:note_pre_post_uhdr|notes_pre_post|notes_uhdr)\/)?[A-Za-z0-9\-]+(?=!)/;

  /** 原图转 jpg 的处理参数 */
  var JPG_PARAMS = '?imageView2/2/w/format/jpg';

  /** 需要旁路监听的 JSON API 路径白名单 */
  var API_HINTS = [
    '/api/sns/',
    'homefeed',
    '/note/',
    '/feed',
    'note_detail',
    '/v1/feed',
    '/v0/note'
  ];

  /** 明确的非 JSON 路径，直接跳过 */
  var BINARY_HINTS = ['.mp4', '.webm', '.m3u8', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.mov'];

  var MAX_DEPTH = 12;
  /**
   * 深度扫描的节点上限。旧值 20000 在 explore 页的大号 __INITIAL_STATE__
   * 上会提前 break，导致 note 容器根本没被访问到（表现为"读取不到页面数据"）。
   * 现在已知路径直取是主路径，全树扫描退化为兜底，因此可以把预算放宽；
   * 同时用 SCAN_BUDGET_MS 做时间硬顶，避免极端状态把页面卡死 ——
   * 光靠节点数无法界定真实耗时（取决于对象大小）。
   */
  var MAX_NODES = 200000;
  var SCAN_BUDGET_MS = 250;

  /**
   * 已知的非笔记对象类型。
   * 小红书的评论对象同样带 note_id（指向所属笔记），因此「有 note_id」不足以
   * 判定为笔记。仅用于形态三的自判，note_card / note_detail_map 是结构性位置，不受影响。
   */
  var NON_NOTE_TYPES = { comment: 1, sub_comment: 1, user: 1, reply: 1 };

  /* ========================= 基础工具函数 ========================= */

  function isObj(v) {
    return v !== null && typeof v === 'object';
  }

  /**
   * 兼容 snake_case / camelCase 的取值。get(note, 'note_id') 可命中 noteId。
   */
  function get(obj, name) {
    if (!isObj(obj)) return undefined;
    var v = obj[name];
    if (v !== undefined && v !== null) return v;
    var camel = name.replace(/_([a-z0-9])/g, function (_, c) { return c.toUpperCase(); });
    if (camel !== name) {
      v = obj[camel];
      if (v !== undefined && v !== null) return v;
    }
    return undefined;
  }

  function str(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    return '';
  }

  function num(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
    return 0;
  }

  /**
   * 按 key 确定性地挑一个 CDN 域名。
   *
   * 早期实现是 Math.random()，看似能分散负载，实则引入两个真实缺陷：
   *   1. background.js 的「会话内已下载去重表」是按 URL 建的（DONE_KEY），
   *      同一张图每次扫描得到不同 URL → 去重永远命中不了 → 重复下载会
   *      产出 "标题 (1).jpg" 这类冗余文件，去重功能形同虚设。
   *   2. 导出 JSON / 测试断言无法复现（同一笔记两次扫描结果不同）。
   * 改成对 key 做 djb2 哈希取模后：不同图片仍会分散到不同 CDN 域名，
   * 但同一张图在任何时刻、任何次扫描都得到同一个 URL。
   */
  function pickBase(bases, key) {
    if (!key) return bases[0];
    var h = 5381;
    for (var i = 0; i < key.length; i++) {
      h = ((h << 5) + h + key.charCodeAt(i)) | 0;
    }
    return bases[Math.abs(h) % bases.length];
  }

  /**
   * 当前笔记 id（从 URL 推断）。
   * 覆盖三种真实路径：/explore/<id>、/discovery/item/<id>（分享链接）、
   * 以及带查询串的短链落地页 /discovery/item/<id>?xsec_token=...
   */
  function currentNoteId() {
    try {
      var m = location.pathname.match(/\/(?:explore|discovery\/item)\/([0-9a-zA-Z]+)/);
      if (m) return m[1];
      // 个别落地页把 id 放在查询串里
      var q = location.search.match(/[?&](?:note_?id|id)=([0-9a-zA-Z]+)/);
      return q ? q[1] : '';
    } catch (e) {
      return '';
    }
  }

  /**
   * 拼笔记链接。国际站（rednote.com）上的笔记应回链到本站域名，
   * 早期写死 xiaohongshu.com 会让国际站用户复制到的链接跳转一次。
   */
  function noteUrl(noteId) {
    try {
      if (/(^|\.)(xiaohongshu\.com|rednote\.com)$/i.test(location.hostname)) {
        return location.protocol + '//' + location.hostname + '/explore/' + noteId;
      }
    } catch (e) { /* 忽略：取不到 location 时用默认值 */ }
    return 'https://www.xiaohongshu.com/explore/' + noteId;
  }

  function isApiUrl(url) {
    if (!url || typeof url !== 'string') return false;
    var lower = url.toLowerCase();
    // 国际站同样走 /api/sns/... 接口，只认 xiaohongshu.com 会漏掉 rednote.com
    if (lower.indexOf('xiaohongshu.com') === -1 && lower.indexOf('rednote.com') === -1) {
      return false;
    }
    for (var i = 0; i < BINARY_HINTS.length; i++) {
      if (lower.indexOf(BINARY_HINTS[i]) !== -1) return false;
    }
    for (var j = 0; j < API_HINTS.length; j++) {
      if (lower.indexOf(API_HINTS[j]) !== -1) return true;
    }
    return false;
  }

  /* ========================== 数据提取 ========================== */

  /** 编解码器兼容性顺序（仅在画质字段全平时用于兜底排序） */
  var CODEC_ORDER = ['h264', 'h265', 'h266', 'av1'];

  /**
   * 画质降序比较：height → videoBitrate → size，全平时按编解码器兼容性。
   *
   * 参考实现（XHS-Downloader 12.7k★）的做法是跨编解码器按 height 全局降序取
   * 最优；其配套油猴脚本同样是 sortArray(allStreams, "height") 后取 [0]。
   * 早期我们只取「命中的第一个编解码器的第一条」，既不看分辨率也不留备用 ——
   * 同一编解码器下有多档分辨率时会取到数组里第一条（可能是最低档）。
   */
  function codecRank(c) {
    var i = CODEC_ORDER.indexOf(c);
    return i < 0 ? 99 : i;              // 未知编解码器排最后
  }

  function byQualityDesc(a, b) {
    var d = num(get(b, 'height')) - num(get(a, 'height'));
    if (d) return d;
    d = num(get(b, 'video_bitrate')) - num(get(a, 'video_bitrate'));
    if (d) return d;
    d = num(get(b, 'size')) - num(get(a, 'size'));
    if (d) return d;
    return codecRank(a.__codec) - codecRank(b.__codec);
  }

  /**
   * 从 stream 中取出全部候选直链，去重后按指定策略排序返回。
   * 调用方可取 [0] 作主直链、其余作备用直链。
   *
   * @param {'compat'|'quality'} mode
   *   compat  —— 编解码器兼容性优先（h264 最稳），同编解码器内按画质降序。默认值。
   *   quality —— 画质优先（height → bitrate → size 降序），编解码器仅作平手兜底。
   *              参考实现 XHS-Downloader 采用此策略；但可能选中 h265/av1，
   *              部分老旧播放器打不开，因此不设为默认。
   */
  function streamCandidates(stream, mode) {
    if (!isObj(stream)) return [];
    var name = {};                       // 编解码器名 → 索引，用于排序兜底
    Object.keys(stream).forEach(function (k, i) { name[k] = i; });

    var items = [];
    Object.keys(stream).forEach(function (codec) {
      var arr = stream[codec];
      if (!Array.isArray(arr)) return;
      for (var k = 0; k < arr.length; k++) {
        var it = arr[k];
        if (!isObj(it)) continue;
        items.push({
          __raw: it,
          __codec: codec,
          __seq: k,
          height: num(get(it, 'height')),
          video_bitrate: num(get(it, 'video_bitrate')),
          size: num(get(it, 'size'))
        });
      }
    });

    var compat = mode !== 'quality';
    items.sort(function (a, b) {
      if (compat) {
        // 编解码器优先，同编解码器内按画质降序
        var r = codecRank(a.__codec) - codecRank(b.__codec);
        if (r) return r;
      }
      // byQualityDesc 内部已含编解码器兜底，缺画质字段的条目各项为 0，
      // 会自然排在有画质字段的条目之后，不会「无信息条目反压高画质条目」
      var d = byQualityDesc(a, b);
      if (d) return d;
      if (!compat) {
        var r2 = codecRank(a.__codec) - codecRank(b.__codec);
        if (r2) return r2;
      }
      return a.__seq - b.__seq;
    });

    var out = [];
    var seen = {};
    function add(u) {
      u = str(u);
      if (!u || seen[u]) return;
      seen[u] = 1;
      out.push(u);
    }
    for (var i = 0; i < items.length; i++) {
      var raw = items[i].__raw;
      add(get(raw, 'master_url'));
      var backups = get(raw, 'backup_urls');
      if (Array.isArray(backups)) {
        for (var b = 0; b < backups.length; b++) add(backups[b]);
      }
    }
    return out;
  }

  /** 主直链（画质最优的一条）。保留旧签名为兼容。 */
  function streamUrl(stream, order) {
    var list = streamCandidates(stream, order);
    return list.length ? list[0] : '';
  }

  function coverUrl(cover) {
    if (typeof cover === 'string') return cover;
    if (!isObj(cover)) return '';
    return str(get(cover, 'url_default')) || str(get(cover, 'urlDefault')) ||
      str(get(cover, 'url')) || str(get(cover, 'url_pre')) || '';
  }

  /** 常规图 URL → 原图 URL（换 CDN 域名 + 保留 fileKey，去掉压缩处理参数） */
  function buildOriginImage(urlDefault) {
    if (!urlDefault || typeof urlDefault !== 'string') return '';
    var clean = urlDefault.split('?')[0];
    var m = clean.match(FILE_KEY_RE);
    if (!m || !m[0]) return '';
    return pickBase(IMG_BASES, m[0]) + m[0];
  }

  /** 原视频直链：origin_video_key 是小红书自己提供的「原画质」入口 */
  function buildOriginVideo(key) {
    if (!key) return '';
    return pickBase(VIDEO_BASES, key) + key;
  }

  /**
   * 把任意形态的 note 对象归一化成统一的 NoteData。
   * 同时兼容 __INITIAL_STATE__ 的 camelCase 与 API 的 snake_case。
   */
  function toNoteData(raw, source) {
    if (!isObj(raw)) return null;

    var noteId = str(get(raw, 'note_id')) || str(get(raw, 'id'));
    if (!noteId) return null;

    var user = get(raw, 'user') || get(raw, 'author') || {};
    var videoRaw = get(raw, 'video');

    var data = {
      noteId: noteId,
      source: source || 'unknown',
      url: noteUrl(noteId),
      title: str(get(raw, 'title')) || str(get(raw, 'display_title')),
      desc: str(get(raw, 'desc')) || str(get(raw, 'description')),
      type: str(get(raw, 'type')) || (videoRaw ? 'video' : 'normal'),
      publishTime: num(get(raw, 'time')) || num(get(raw, 'publish_time')) || num(get(raw, 'last_update_time')),
      ipLocation: str(get(raw, 'ip_location')),
      cover: coverUrl(get(raw, 'cover')),
      author: {
        nickname: str(get(user, 'nickname')) || str(get(user, 'nick_name')) || str(get(user, 'name')),
        userId: str(get(user, 'user_id')) || str(get(user, 'id')),
        redId: str(get(user, 'red_id')),
        avatar: str(get(user, 'avatar')) || str(get(user, 'image'))
      },
      images: [],
      video: null
    };

    if (data.type !== 'video' && data.type !== 'normal') data.type = 'normal';

    /* ---- 图片列表（图文 / 实况） ---- */
    var imageList = get(raw, 'image_list');
    if (!Array.isArray(imageList)) imageList = [];
    for (var i = 0; i < imageList.length; i++) {
      var img = imageList[i];
      if (!isObj(img)) continue;
      var urlDefault = str(get(img, 'url_default')) || str(get(img, 'url')) || str(get(img, 'url_pre'));
      var originImage = buildOriginImage(urlDefault);
      // 实况视频的备用直链：早期实况任务 fallbacks 是空数组，
      // 主直链一失败就直接判死，而参考实现明确把 backupUrls 也纳入候选。
      var liveStream = get(img, 'stream');
      var liveList = streamCandidates(liveStream, 'compat').slice(0, 6);
      var liveBest = streamCandidates(liveStream, 'quality').slice(0, 6);
      var liveVideo = liveList.length ? liveList[0] : '';
      data.images.push({
        index: i,
        urlDefault: urlDefault,
        urlOrigin: originImage,
        urlJpg: originImage ? originImage + JPG_PARAMS : '',
        liveVideoUrl: liveVideo,
        liveVideoUrls: liveList,
        liveVideoUrlsBest: liveBest,
        isLive: !!liveVideo || !!get(img, 'live_photo'),
        width: num(get(img, 'width')),
        height: num(get(img, 'height'))
      });
    }

    /* ---- 视频 ---- */
    if (videoRaw && isObj(videoRaw)) {
      var consumer = get(videoRaw, 'consumer') || {};
      var media = get(videoRaw, 'media') || {};
      var originKey = str(get(consumer, 'origin_video_key'));
      var vStreamRaw = get(media, 'stream');
      var vList = streamCandidates(vStreamRaw, 'compat').slice(0, 6);
      var vBest = streamCandidates(vStreamRaw, 'quality').slice(0, 6);
      data.video = {
        urlOrigin: buildOriginVideo(originKey),
        originKey: originKey,
        urlStream: vList.length ? vList[0] : '',
        urlStreams: vList,
        urlStreamsBest: vBest,
        cover: coverUrl(get(videoRaw, 'cover')) || coverUrl(get(media, 'video_cover')) || data.cover,
        duration: num(get(videoRaw, 'capa') ? get(get(videoRaw, 'capa'), 'duration') : 0) ||
          num(get(media, 'video_duration')) || num(get(videoRaw, 'duration'))
      };
    }

    if (!data.title) data.title = data.desc ? data.desc.slice(0, 40) : ('小红书笔记_' + noteId);
    return data;
  }

  /* ====================== 深度扫描 JSON 树 ====================== */

  function collectNotes(root, bag, stats) {
    var stack = [{ node: root, depth: 0 }];
    while (stack.length) {
      var cur = stack.pop();
      var node = cur.node;
      if (!isObj(node)) continue;
      if (stats.visited++ > MAX_NODES) break;
      // 时间硬顶：节点数相同但对象大小差异很大，只有墙钟时间能界定真实开销
      if (stats.startedAt && (stats.visited & 0x3FF) === 0 &&
          Date.now() - stats.startedAt > SCAN_BUDGET_MS) break;
      if (cur.depth > MAX_DEPTH) continue;

      if (Array.isArray(node)) {
        for (var a = 0; a < node.length; a++) {
          if (isObj(node[a])) stack.push({ node: node[a], depth: cur.depth + 1 });
        }
        continue;
      }

      // 形态一：feed API 的 items[].note_card
      var card = get(node, 'note_card');
      if (isObj(card)) pushNote(card, bag);

      // 形态二：noteDetailMap[id].note / 直接的 note 对象
      var detailMap = get(node, 'note_detail_map');
      if (isObj(detailMap)) {
        for (var key in detailMap) {
          if (!Object.prototype.hasOwnProperty.call(detailMap, key)) continue;
          var entry = detailMap[key];
          if (isObj(entry) && isObj(get(entry, 'note'))) pushNote(get(entry, 'note'), bag);
        }
      }

      // 形态三：自身就是一条笔记。
      // 判定不能只看 image_list / video / desc —— 小红书确实存在
      // image_list 为 null、且没有正文的笔记（例如纯标题卡片），
      // 这类笔记漏判会让用户看到「未识别到笔记」。
      // 只要带 note_id，再命中任意一个笔记特征字段即视为笔记。
      var nodeType = str(get(node, 'type')).toLowerCase();
      if (!NON_NOTE_TYPES[nodeType] && get(node, 'note_id') && (
        get(node, 'image_list') ||
        get(node, 'video') ||
        get(node, 'desc') ||
        get(node, 'title') ||
        get(node, 'type')
      )) {
        pushNote(node, bag);
      }

      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        var v = node[k];
        if (isObj(v)) stack.push({ node: v, depth: cur.depth + 1 });
      }
    }
  }

  function pushNote(raw, bag) {
    var data = toNoteData(raw, 'api');
    if (!data) return;
    var prev = bag[data.noteId];
    if (!prev) {
      bag[data.noteId] = data;
      return;
    }
    // 同一条笔记出现多次时，保留信息更完整的那一份。
    //
    // 评分必须把标题/正文/作者等元信息计入，不能只数图片和视频：
    // collectNotes 是 LIFO 遍历（stack.pop），同一 note_id 的多份数据
    // 谁先入袋取决于数组顺序。若两份数据都是「零图片零视频」，纯媒体计分
    // 会打出 0:0 平手，而下面的比较是严格 >，先入袋者胜出 ——
    // 真实笔记的标题就会被后出现的空壳对象吞掉（缺陷 D-07）。
    var score = function (d) {
      var s = d.images.length * 10 +
        (d.video ? 100 : 0) +
        d.images.filter(function (i) { return i.liveVideoUrl; }).length * 50;
      if (d.title) s += 30;
      if (d.desc) s += 20;
      if (d.author && (d.author.nickname || d.author.userId)) s += 15;
      if (d.publishTime) s += 5;
      if (d.cover) s += 5;
      return s;
    };
    if (score(data) > score(prev)) {
      data.source = prev.source === 'initial-state' ? prev.source : data.source;
      bag[data.noteId] = data;
    }
  }

  /* ========================= 对外投递 ========================= */

  /**
   * 是否为「可比较的来源」。
   * 不透明源下 location.origin 与 ev.origin 的序列化不一致：
   *   file:// 页面  location.origin === "file://"，而 ev.origin === "null"
   * 两者永不相等，若强行校验会把所有消息丢掉（消息桥静默失效）。
   * 注意：同窗口消息本就伪造不出跨源来源，该校验防不住页面自身脚本，
   * 真正的防线是隔离世界的 sanitizeNote() 白名单。
   */
  function originComparable() {
    var o = location.origin;
    return !!o && o !== 'null' && o !== 'file://';
  }

  function targetOrigin() {
    return originComparable() ? location.origin : '*';
  }

  function originOk(ev) {
    return !originComparable() || ev.origin === location.origin;
  }

  function post(type, payload) {
    try {
      window.postMessage({ __channel: CHANNEL, type: type, payload: payload }, targetOrigin());
    } catch (e) { /* 忽略：不影响宿主页面 */ }
  }

  /**
   * 按已知容器 O(1) 直取笔记。
   *
   * 这是「未能读取页面数据、降级到 DOM 兜底」的主要根因所在：
   * explore 页的 __INITIAL_STATE__ 极大（feed、评论、相关推荐全在里面），
   * 而 collectNotes 是 LIFO 深度遍历（stack.pop），note 容器往往是
   * __INITIAL_STATE__ 的靠前 key，会被**最后**才展开；MAX_NODES 预算
   * 一旦耗光就 break 掉整个扫描，note 还没被访问到 —— 于是读不到数据。
   * 参考实现（XHS-Downloader 12.7k★ 的配套油猴脚本）就是直接按
   *   initialState.note.noteDetailMap[noteId].note
   * 取，不跑全树扫描。这里照做，命中就不必跑昂贵的全树遍历。
   */
  function pickFromKnownPaths(state) {
    if (!isObj(state)) return null;
    var want = currentNoteId();

    // 形态 A：note.noteDetailMap[noteId].note
    var noteRoot = get(state, 'note');
    var map = isObj(noteRoot) ? get(noteRoot, 'note_detail_map') : null;
    if (isObj(map)) {
      if (want && isObj(map[want])) {
        var hit = get(map[want], 'note');
        if (isObj(hit)) return hit;
      }
      // 未命中当前 noteId 时取最后一条，与参考实现一致
      var keys = Object.keys(map);
      for (var i = keys.length - 1; i >= 0; i--) {
        if (!isObj(map[keys[i]])) continue;
        var n = get(map[keys[i]], 'note');
        if (isObj(n)) return n;
      }
    }

    // 形态 B：noteData.data.noteData
    var nd = get(state, 'note_data');
    if (isObj(nd)) {
      var d = get(nd, 'data');
      if (isObj(d)) {
        var n2 = get(d, 'note_data');
        if (isObj(n2)) return n2;
      }
    }

    return null;
  }

  /** 最近一次扫描的统计，供诊断使用 */
  var lastScan = { visited: 0, found: 0, source: '', directHit: false, ms: 0 };

  /**
   * @returns {boolean} 是否真的投递了一条 NOTE。
   *
   * 之前这个函数没有返回值，调用方 scanInitialState 只能凭
   * "window.__INITIAL_STATE__ 存在" 就返回 true —— 于是状态存在但里面
   * 没有笔记时也被当成成功：内联 script 兜底不会跑、诊断快照不会输出，
   * 现场问题因此完全无从下手。
   */
  function emitNotes(rawRoot, source) {
    // 先按已知路径直取，命中即返回，避免在大号状态上做全树扫描
    var direct = pickFromKnownPaths(rawRoot);
    if (direct) {
      var fast = toNoteData(direct, source);
      if (fast) {
        lastScan = { visited: 1, found: 1, source: source, directHit: true, ms: 0 };
        post('NOTE', fast);
        return true;
      }
    }

    var bag = Object.create(null);
    var stats = { visited: 0, startedAt: Date.now() };
    try {
      collectNotes(rawRoot, bag, stats);
    } catch (e) {
      lastScan = { visited: stats.visited, found: 0, source: source, directHit: false, ms: -1 };
      return false;
    }
    lastScan = {
      visited: stats.visited,
      found: Object.keys(bag).length,
      source: source,
      directHit: false,
      ms: Date.now() - stats.startedAt
    };
    var notes = Object.keys(bag).map(function (k) { return bag[k]; });
    if (!notes.length) return false;

    // 优先投递当前 URL 对应的笔记
    var want = currentNoteId();
    var picked = null;
    for (var i = 0; i < notes.length; i++) {
      notes[i].source = source;
      if (want && notes[i].noteId === want) picked = notes[i];
    }
    if (!picked) {
      // 没有 URL 匹配时，取信息量最大的一条（通常是用户当前在看的那条）
      picked = notes.reduce(function (a, b) {
        var s = function (d) { return d.images.length + (d.video ? 100 : 0); };
        return s(b) > s(a) ? b : a;
      }, notes[0]);
    }
    post('NOTE', picked);
    return true;
  }

  /* ======================= __INITIAL_STATE__ ======================= */

  /**
   * @returns {boolean} 是否真的拿到并投递了笔记。
   * 以前只看 "__INITIAL_STATE__ 存在"，状态存在但里面没有笔记时
   * 也返回 true，导致内联 script 兜底和诊断快照都被跳过。
   */
  function scanInitialState(reason) {
    try {
      var state = window.__INITIAL_STATE__;
      if (!state) return false;
      emitCommentMedia(state);
      return emitNotes(state, 'initial-state');
    } catch (e) {
      return false;
    }
  }

  /**
   * 兜底：从 <script> 内联文本里正则抠出 __INITIAL_STATE__。
   * @returns {boolean} 是否真的投递了笔记
   */
  function scanInlineScript() {
    try {
      var scripts = document.querySelectorAll('script');
      for (var i = 0; i < scripts.length; i++) {
        var text = scripts[i].textContent;
        if (!text || text.indexOf('__INITIAL_STATE__') === -1) continue;
        if (text.length > 3000000) continue; // 防御性上限
        var m = text.match(/__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*(?:<\/script>|$)/);
        if (!m) continue;
        // 内联 JSON 里可能含 undefined，替换后才能 parse
        var json = m[1].replace(/:\s*undefined\b/g, ':null');
        try {
          if (emitNotes(JSON.parse(json), 'inline-script')) return true;
        } catch (e) { /* 单个 script 解析失败不影响其他 */ }
      }
    } catch (e) { /* 忽略 */ }
    return false;
  }

  /* ====================== 评论区媒体（图片 / 语音） ====================== */

  /**
   * 评论区图片与语音消息。
   *
   * 真实字段名（由调研确认，与直觉不同，务必按此实现）：
   *   评论图片：comment.pictures[*].info_list[*].url
   *   评论语音：comment.audioInfo.playInfo.url
   *             （snake_case 别名 audio_info.play_info.url）
   *   —— 注意不是 voice / voice_url / voice_info。
   *      Apify 等平台输出里的 voice_info、voice_duration_seconds 是它们
   *      自己的归一化字段，不是小红书原始字段，照着实现会永远取不到。
   *
   * 语音走 sns-video-v2.xhscdn.com（与视频共用 sns-video 系域名，
   * 不存在 sns-voice 域名），容器是 MP4 而非 m4a，需转码才能当音频用。
   *
   * 该功能 2025-07 内测、08 放量，字段仍在演进，因此 camelCase /
   * snake_case 双写都兼容，并对每一层做空值兜底。
   */

  function uniqUrls(arr) {
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < arr.length; i++) {
      var u = str(arr[i]);
      if (!u || seen[u]) continue;
      seen[u] = 1;
      out.push(u);
    }
    return out;
  }

  function pickImgUrl(o) {
    if (!isObj(o)) return '';
    return str(get(o, 'url')) || str(get(o, 'url_default')) || str(get(o, 'url_pre')) || '';
  }

  function commentImages(c) {
    var out = [];
    var pics = get(c, 'pictures') || get(c, 'images') || get(c, 'image_list');
    if (!Array.isArray(pics)) return out;
    for (var i = 0; i < pics.length; i++) {
      var p = pics[i];
      if (!isObj(p)) continue;
      // 主路径：pictures[*].info_list[*].url
      var info = get(p, 'info_list');
      if (Array.isArray(info)) {
        for (var j = 0; j < info.length; j++) out.push(pickImgUrl(info[j]));
      }
      // 兜底：图片对象上直接挂 url
      out.push(pickImgUrl(p));
    }
    return uniqUrls(out);
  }

  function audioBlock(c) {
    return get(c, 'audioInfo') || get(c, 'audio_info') || null;
  }

  function commentAudios(c) {
    var a = audioBlock(c);
    if (!isObj(a)) return [];
    var out = [];
    var play = get(a, 'playInfo') || get(a, 'play_info');
    if (Array.isArray(play)) {
      for (var i = 0; i < play.length; i++) {
        if (isObj(play[i])) out.push(str(get(play[i], 'url')));
      }
    } else if (isObj(play)) {
      out.push(str(get(play, 'url')));
    }
    // 兜底：audioInfo 上直接挂 url
    out.push(str(get(a, 'url')));
    return uniqUrls(out);
  }

  function isCommentish(o) {
    return isObj(o) && (!!get(o, 'pictures') || !!audioBlock(o));
  }

  /**
   * 从任意根节点（API 响应或 __INITIAL_STATE__）里收集评论媒体。
   * 先走已知路径 data.comments / comments，命中就不做全树扫描。
   */
  function collectCommentMedia(root) {
    if (!isObj(root) && !Array.isArray(root)) return [];

    var lists = [];
    function addList(v) { if (Array.isArray(v) && v.length) lists.push(v); }

    var d = get(root, 'data');
    if (isObj(d)) {
      addList(get(d, 'comments'));
      addList(get(d, 'comment_list'));
    }
    addList(get(root, 'comments'));
    addList(get(root, 'comment_list'));

    // 兜底：限定预算的深扫，找带 pictures / audioInfo 的对象
    if (!lists.length) {
      var stack = [root];
      var visited = 0;
      var started = Date.now();
      while (stack.length) {
        var n = stack.pop();
        if (!isObj(n)) continue;
        if (++visited > 20000) break;
        if (Date.now() - started > 150) break;
        if (isCommentish(n)) { lists.push([n]); continue; }
        for (var k in n) {
          if (!Object.prototype.hasOwnProperty.call(n, k)) continue;
          var v = n[k];
          if (isObj(v)) stack.push(v);
        }
      }
    }

    var found = [];
    var seenId = Object.create(null);
    for (var i = 0; i < lists.length && found.length < 200; i++) {
      var arr = lists[i];
      for (var j = 0; j < arr.length && found.length < 200; j++) {
        var c = arr[j];
        if (!isObj(c)) continue;
        var imgs = commentImages(c);
        var auds = commentAudios(c);
        if (!imgs.length && !auds.length) continue;

        var id = str(get(c, 'id')) || str(get(c, 'comment_id')) || ('c' + found.length);
        if (seenId[id]) continue;
        seenId[id] = 1;

        var a = audioBlock(c);
        var u = get(c, 'user_info') || get(c, 'user') || {};
        found.push({
          commentId: id,
          author: str(get(u, 'nickname')) || str(get(u, 'nick_name')) || '',
          images: imgs,
          audios: auds,
          // 语音转文字，可当文件名用；字段名同样双写兼容
          asrText: isObj(a) ? (str(get(a, 'asrText')) || str(get(a, 'asr_text'))) : '',
          duration: isObj(a) ? num(get(a, 'duration')) : 0
        });
      }
    }
    return found;
  }

  function emitCommentMedia(root) {
    var list = collectCommentMedia(root);
    if (!list.length) return false;
    post('COMMENT_MEDIA', { items: list });
    return true;
  }

  /* ================== 原生伪装 & 可降级钩子管理 ================== */
  /**
   * R1 加固：抖音已被证实会检测 window.fetch / XHR 是否为原生实现，
   * 一旦发现被包裹就直接禁用 MSE 视频轨（表现为「只有声音没有画面」）。
   * 小红书没有公开案例，但同类检测成本极低，因此：
   *   ① 让被包裹的函数 toString() 仍返回原生代码字符串；
   *   ② 钩子可运行时卸载（uninstallHooks）；
   *   ③ 一旦宿主 <video> 出现加载错误，立刻自动卸载钩子。
   * 宁可少抓数据，也绝不影响用户正常看视频。
   */
  var hooks = { installed: false, originals: null };

  function maskNative(fake, original) {
    try {
      Object.defineProperty(fake, 'name', { value: original.name, configurable: true });
      Object.defineProperty(fake, 'length', { value: original.length, configurable: true });
      Object.defineProperty(fake, 'toString', {
        value: function () { return Function.prototype.toString.call(original); },
        configurable: true,
        writable: true
      });
    } catch (e) { /* 部分环境下不可配置，忽略即可 */ }
  }

  function uninstallHooks(reason) {
    if (!hooks.installed) return;
    var o = hooks.originals || {};
    try {
      if (o.xhrOpen) window.XMLHttpRequest.prototype.open = o.xhrOpen;
      if (o.xhrSend) window.XMLHttpRequest.prototype.send = o.xhrSend;
      if (o.fetch) window.fetch = o.fetch;
    } catch (e) { /* 忽略 */ }
    hooks.installed = false;
    post('HOOK_DISABLED', { reason: reason || 'manual' });
  }

  /* ================== PerformanceObserver（媒体 URL 主路径） ================== */
  /**
   * 与 XHR/fetch 钩子不同，PerformanceObserver 是纯被动观察，零侵入、
   * 不可能被检测，因此把它作为媒体 URL 的**主路径**，钩子只作增强。
   */
  var mediaSink = { videos: [], seen: Object.create(null) };
  var hintTimer = null;

  function noteMediaUrl(u) {
    if (!u || typeof u !== 'string' || mediaSink.seen[u]) return;
    var path = u.split('?')[0].toLowerCase();
    var isVideo = /\.(mp4|webm|m3u8|mov|m4v)$/.test(path) || u.indexOf('sns-video') !== -1;
    if (!isVideo) return;
    mediaSink.seen[u] = 1;
    mediaSink.videos.push(u);
    if (mediaSink.videos.length > 80) mediaSink.videos.shift();
    if (hintTimer) return;
    hintTimer = setTimeout(function () {
      hintTimer = null;
      post('MEDIA_HINTS', { videos: mediaSink.videos.slice() });
    }, 600);
  }

  function installPerformanceObserver() {
    try {
      if (typeof PerformanceObserver !== 'function') return;
      var po = new PerformanceObserver(function (list) {
        var entries = list.getEntries();
        for (var i = 0; i < entries.length; i++) noteMediaUrl(entries[i].name);
      });
      po.observe({ type: 'resource', buffered: true });
    } catch (e) { /* 忽略 */ }
  }

  /** 播放健康看门狗：宿主视频一报错就立刻撤掉钩子 */
  function watchPlaybackHealth() {
    document.addEventListener('error', function (ev) {
      var t = ev.target;
      if (!t || !t.tagName || String(t.tagName).toUpperCase() !== 'VIDEO') return;
      if (hooks.installed) uninstallHooks('video-error');
    }, true);
  }

  /* ====================== XHR / fetch 旁路监听 ====================== */

  function handleJsonText(text, url) {
    if (!text) return;
    var trimmed = text.slice(0, 64).trim();
    if (trimmed.charAt(0) !== '{' && trimmed.charAt(0) !== '[') return;
    try {
      var obj = JSON.parse(text);
      emitNotes(obj, 'api:' + url.split('?')[0].slice(-40));
      // 评论接口（/api/sns/web/v2/comment/page）的响应同样走这里
      emitCommentMedia(obj);
    } catch (e) { /* 非 JSON，忽略 */ }
  }

  function installHooks() {
    if (hooks.installed) return;
    var originals = {};

    /* ---- XMLHttpRequest ---- */
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      var rawOpen = XHR.prototype.open;
      var rawSend = XHR.prototype.send;
      originals.xhrOpen = rawOpen;
      originals.xhrSend = rawSend;

      var fakeOpen = function (method, url) {
        try {
          this.__xhsDlUrl = typeof url === 'string' ? url : (url && url.toString ? url.toString() : '');
        } catch (e) { /* 忽略 */ }
        return rawOpen.apply(this, arguments);
      };

      var fakeSend = function () {
        try {
          var self = this;
          self.addEventListener('load', function () {
            try {
              var url = self.__xhsDlUrl || '';
              if (!isApiUrl(url)) return;
              // 只看 JSON：非 JSON 响应（二进制媒体）直接放弃，避免无谓的内存拷贝
              var ct = '';
              try { ct = self.getResponseHeader('content-type') || ''; } catch (e2) { ct = ''; }
              var rt = self.responseType;
              if (rt && rt !== 'text' && rt !== 'json') return;
              if (ct && ct.indexOf('json') === -1 && ct.indexOf('text') === -1) return;
              handleJsonText(self.responseText, url);
            } catch (e3) { /* 忽略 */ }
          }, { once: true });
        } catch (e4) { /* 忽略 */ }
        return rawSend.apply(this, arguments);
      };

      maskNative(fakeOpen, rawOpen);
      maskNative(fakeSend, rawSend);
      XHR.prototype.open = fakeOpen;
      XHR.prototype.send = fakeSend;
    }

    /* ---- fetch ---- */
    if (typeof window.fetch === 'function') {
      var rawFetch = window.fetch;
      originals.fetch = rawFetch;

      var fakeFetch = function () {
        var args = arguments;
        var p = rawFetch.apply(this, args);
        try {
          var req = args[0];
          var url = typeof req === 'string' ? req : (req && req.url ? req.url : '');
          if (isApiUrl(url)) {
            p.then(function (res) {
              try {
                var ct = (res.headers && res.headers.get ? res.headers.get('content-type') : '') || '';
                ct = ct.toLowerCase();
                // 关键：只对 JSON / text 做 clone，媒体流一律不碰
                if (ct.indexOf('json') !== -1 || ct.indexOf('text') !== -1) {
                  res.clone().text().then(function (t) {
                    handleJsonText(t, url);
                  }).catch(function () {});
                }
              } catch (e) { /* 忽略 */ }
            }).catch(function () {});
          }
        } catch (e) { /* 忽略 */ }
        return p;
      };

      maskNative(fakeFetch, rawFetch);
      window.fetch = fakeFetch;
    }

    hooks.originals = originals;
    hooks.installed = true;
  }

  /* ======================== 消息桥（请求-响应） ======================== */

  /**
   * 诊断快照。
   *
   * 「未能读取页面数据」这类现场问题的成因在沙箱里无法复现（合成 fixture
   * 无论 key 顺序、无论预算大小都能读到），与其继续猜测，不如让扩展自己
   * 把状态形状吐出来：用户在控制台复制这一行就能定位到底卡在哪一环。
   */
  function diagSnapshot() {
    var d = {
      noteId: currentNoteId(),
      href: '',
      hookInstalled: !!(hooks && hooks.installed),
      hasState: false,
      stateType: '',
      stateKeys: [],
      hasNoteContainer: false,
      hasDetailMap: false,
      detailMapKeys: [],
      inlineScriptCount: 0,
      scan: lastScan,
      maxNodes: MAX_NODES,
      budgetMs: SCAN_BUDGET_MS
    };
    try { d.href = location.href; } catch (e) { /* 忽略 */ }
    try {
      var st = window.__INITIAL_STATE__;
      d.hasState = !!st;
      if (st && typeof st === 'object') {
        d.stateType = Array.isArray(st) ? 'array' : 'object';
        d.stateKeys = Object.keys(st).slice(0, 40);
        var noteRoot = get(st, 'note');
        d.hasNoteContainer = isObj(noteRoot);
        var map = isObj(noteRoot) ? get(noteRoot, 'note_detail_map') : null;
        d.hasDetailMap = isObj(map);
        if (isObj(map)) d.detailMapKeys = Object.keys(map).slice(0, 10);
        // 形态 B
        var nd = get(st, 'note_data');
        if (isObj(nd) && isObj(get(nd, 'data')) && isObj(get(get(nd, 'data'), 'note_data'))) {
          d.hasNoteDataPath = true;
        }
      }
    } catch (e) {
      d.stateError = String(e && e.message || e);
    }
    try {
      var sc = document.querySelectorAll('script');
      for (var i = 0; i < sc.length; i++) {
        if (sc[i].textContent && sc[i].textContent.indexOf('__INITIAL_STATE__') !== -1) {
          d.inlineScriptCount++;
        }
      }
    } catch (e) { /* 忽略 */ }
    return d;
  }

  function respondRescan() {
    var ok = scanInitialState('rescan');
    if (!ok) ok = scanInlineScript();
    post('MEDIA_HINTS', { videos: mediaSink.videos.slice() });
    post('RESCAN_DONE', {
      noteId: currentNoteId(),
      ok: ok,
      hookActive: hooks.installed,
      diag: diagSnapshot()
    });
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    if (!originOk(ev)) return;
    var d = ev.data;
    if (!d || d.__channel !== CHANNEL) return;
    if (d.type === 'REQUEST_RESCAN') {
      respondRescan();
    } else if (d.type === 'SET_HOOK') {
      try {
        if (d.payload && d.payload.enabled) installHooks();
        else uninstallHooks('settings');
      } catch (e) { /* 忽略 */ }
      post('HOOK_STATE', { active: hooks.installed });
    }
  });

  /* ============================ 启动 ============================ */

  // 纯被动的观察器永远启用（零侵入，不可能被检测）
  installPerformanceObserver();
  watchPlaybackHealth();

  // 网络钩子按需启用，默认开启；隔离世界可随时通过 SET_HOOK 关闭
  try { installHooks(); } catch (e) { /* 钩子失败也不阻断后续 */ }

  // 多时机扫描：SPA 页面状态注入时机不确定，覆盖全生命周期
  scanInitialState('document-start');
  scanInlineScript();

  document.addEventListener('DOMContentLoaded', function () {
    scanInitialState('domcontentloaded');
    if (!scanInitialState('domcontentloaded-2')) scanInlineScript();
  }, { once: true });

  window.addEventListener('load', function () {
    scanInitialState('load');
  }, { once: true });

  setTimeout(function () { scanInitialState('delay-1500'); }, 1500);
  setTimeout(function () { scanInitialState('delay-4000'); scanInlineScript(); }, 4000);

  // SPA 路由切换：URL 变化后重新扫描
  var lastHref = location.href;
  setInterval(function () {
    if (location.href !== lastHref) {
      lastHref = location.href;
      setTimeout(function () {
        scanInitialState('route-change');
        post('ROUTE_CHANGE', { noteId: currentNoteId() });
      }, 800);
    }
  }, 1000);
})();
