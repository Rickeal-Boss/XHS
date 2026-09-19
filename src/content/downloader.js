/**
 * 小红书下载助手 — 文件名规则 & 下载调度
 */
var XHS_DL_DOWNLOADER = (function () {
  'use strict';

  var DEFAULT_RULE = '[<发布者昵称>]<标题>(<发布时间>)';
  var DEFAULT_TIME_FORMAT = 'YYYY年MM月DD日HH时mm分ss秒';

  /** 命名模板可用占位符 */
  var PLACEHOLDERS = [
    { key: '序号', desc: '媒体在笔记中的顺序，从 1 开始' },
    { key: '笔记id', desc: '小红书笔记 ID' },
    { key: '标题', desc: '笔记标题（无标题时取正文前 40 字）' },
    { key: '发布时间', desc: '按下方时间格式渲染' },
    { key: 'ip归属地', desc: '发布时的 IP 归属地' },
    { key: '发布者昵称', desc: '作者昵称' },
    { key: '小红书号', desc: '作者的小红书号' },
    { key: '发布者id', desc: '作者的平台 ID' }
  ];

  var PLACEHOLDER_MAP = {
    '序号': 'index',
    '笔记id': 'noteId',
    '标题': 'title',
    '发布时间': 'publishTime',
    'ip归属地': 'ipLocation',
    '发布者昵称': 'nickname',
    '小红书号': 'redId',
    '发布者id': 'userId'
  };

  /* --------------------------- 时间格式化 --------------------------- */

  function pad(n, len) {
    var s = String(n);
    while (s.length < (len || 2)) s = '0' + s;
    return s;
  }

  /**
   * 轻量 strftime：支持 YYYY / YY / MM / M / DD / D / HH / H / mm / m / ss / s
   * 时间戳为秒或毫秒（自动判断）。
   */
  function formatTime(ts, fmt) {
    if (!ts) return '';
    var ms = ts > 1e12 ? ts : ts * 1000;
    var d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    fmt = fmt || DEFAULT_TIME_FORMAT;
    var map = {
      'YYYY': d.getFullYear(),
      'YY': String(d.getFullYear()).slice(-2),
      'MM': pad(d.getMonth() + 1),
      'M': d.getMonth() + 1,
      'DD': pad(d.getDate()),
      'D': d.getDate(),
      'HH': pad(d.getHours()),
      'H': d.getHours(),
      'mm': pad(d.getMinutes()),
      'm': d.getMinutes(),
      'ss': pad(d.getSeconds()),
      's': d.getSeconds()
    };
    // 长 token 优先替换，避免 MM 被 M 抢先匹配
    return fmt.replace(/YYYY|YY|MM|DD|HH|mm|ss|M|D|H|m|s/g, function (t) {
      return String(map[t]);
    });
  }

  /* --------------------------- 文件名处理 --------------------------- */

  /** 清洗 Windows / macOS / Linux 通用非法字符 */
  function sanitize(name) {
    if (!name) return '';
    var s = String(name)
      // 非法字符 + 控制字符 + 全角/数学符号里形似「路径分隔符」的字符
      // 注意：不替换全角冒号「：」等中文常用标点 —— 它们不是分隔符，
      // 替换掉只会让中文标题变得难看（形似分隔符的 ／＼．․ 才必须拦）
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f\uFF0F\uFF3C\uFF0E\u2024\u2215\u2044\u29F8]/g, '_')
      .replace(/[\r\n\t]+/g, ' ')                          // 换行制表
      .replace(/\s{2,}/g, ' ')                             // 连续空白
      .replace(/^[.\s]+|[.\s]+$/g, '');                    // 首尾点与空格
    if (s.length > 80) s = s.slice(0, 80).replace(/[.\s]+$/, '');
    return s;
  }

  /** 用变量渲染命名模板 */
  function renderName(rule, vars) {
    var out = String(rule || DEFAULT_RULE);
    Object.keys(PLACEHOLDER_MAP).forEach(function (ph) {
      var value = vars[PLACEHOLDER_MAP[ph]];
      out = out.split('<' + ph + '>').join(value == null ? '' : String(value));
    });
    // 清掉模板里剩下的未识别尖括号占位符
    out = out.replace(/<[^<>]{1,20}>/g, '');
    return out.replace(/\s{2,}/g, ' ').trim();
  }

  /** 从 URL 猜扩展名（兜底用） */
  function guessExt(url, fallback) {
    try {
      var path = String(url).split('?')[0].toLowerCase();
      var m = path.match(/\.(mp4|mov|webm|m4v|jpg|jpeg|png|webp|heic|gif|avif)$/);
      if (m) return '.' + m[1];
    } catch (e) { /* 忽略 */ }
    return fallback || '';
  }

  /* --------------------------- 任务构建 --------------------------- */

  function buildVars(note, index, settings) {
    return {
      index: index,
      noteId: note.noteId || '',
      title: sanitize(note.title || ''),
      publishTime: formatTime(note.publishTime, settings && settings.timeFormat),
      ipLocation: note.ipLocation || '',
      nickname: sanitize((note.author && note.author.nickname) || ''),
      redId: (note.author && note.author.redId) || '',
      userId: (note.author && note.author.userId) || ''
    };
  }

  function buildDir(note, settings) {
    var parts = [];
    if (settings && settings.dirByAuthor && note.author && note.author.nickname) {
      parts.push(sanitize(note.author.nickname));
    }
    if (settings && settings.dirByTitle) {
      var t = sanitize(note.title || '');
      if (t) parts.push(t.slice(0, 40));
    }
    if (settings && settings.baseDir) {
      parts.unshift(String(settings.baseDir).replace(/^[\\/]+|[\\/]+$/g, ''));
    }
    return parts.length ? parts.join('/') + '/' : '';
  }

  /**
   * 组装备用直链：候选列表 + 其他已知直链，剔除主直链与重复项。
   * 早期实况任务的 fallbacks 恒为空数组，主直链一失败就判死；
   * 视频也只有「另一条」备用。现在把提取阶段按画质排好序的候选全部带上。
   */
  function chainFallbacks(primary, candidates, extras) {
    var out = [];
    var seen = {};
    if (primary) seen[primary] = 1;
    var all = (Array.isArray(candidates) ? candidates : [])
      .concat(Array.isArray(extras) ? extras : []);
    for (var i = 0; i < all.length; i++) {
      var u = all[i];
      if (!u || seen[u]) continue;
      seen[u] = 1;
      out.push(u);
    }
    return out;
  }

  /**
   * 评论区媒体（图片 / 语音）任务。
   *
   * 目录：统一落到 baseDir/评论/ 下，避免和笔记主体文件混在一起。
   * 语音的容器是 **MP4**（小红书用 sns-video 系域名分发音频，不存在
   * sns-voice 域名，也不是 m4a/mp3），所以扩展名按 .mp4 落，
   * 文件名带 _voice 后缀以便识别；有语音转写文字（asrText）时优先用它命名。
   */
  function buildCommentTasks(items, settings) {
    var tasks = [];
    if (!Array.isArray(items) || !items.length) return tasks;

    var root = String((settings && settings.baseDir) || '小红书下载').replace(/^[\\/]+|[\\/]+$/g, '');
    var dir = (root ? root + '/' : '') + '评论/';

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.url) continue;
      var c = it.comment || {};
      var who = sanitize(c.author || '') || sanitize(c.commentId || '') || '匿名';
      if (it.kind === 'audio') {
        var label = c.asrText ? sanitize(String(c.asrText).slice(0, 40)) : (who + '_' + (it.seq + 1));
        if (!label) label = who + '_' + (it.seq + 1);
        tasks.push({
          kind: 'comment-audio',
          url: it.url,
          dir: dir,
          name: label + '_voice.mp4',
          fallbacks: []
        });
      } else {
        tasks.push({
          kind: 'comment-image',
          url: it.url,
          dir: dir,
          name: who + '_' + (it.seq + 1) + guessExt(it.url, '.jpg'),
          fallbacks: []
        });
      }
    }
    return tasks;
  }

  /**
   * 依据用户勾选与设置，生成下载任务列表。
   * @param {object} note 归一化后的笔记数据
   * @param {number[]} selectedIndexes 勾选的图片下标；视频用 -1 表示
   * @param {object} settings 用户设置
   * @returns {{name:string,url:string,dir:string,kind:string}[]}
   */
  function buildTasks(note, selectedIndexes, settings) {
    var tasks = [];
    if (!note || typeof note !== 'object') return tasks;

    var sel = Array.isArray(selectedIndexes) ? selectedIndexes : [];
    var images = Array.isArray(note.images) ? note.images : [];
    var dir = buildDir(note, settings);
    var rule = (settings && settings.nameRule) || DEFAULT_RULE;
    var liveMode = (settings && settings.liveMode) || 'both';
    var seq = 0;

    // 多档直链的排序策略：compat（编解码器优先，默认）/ quality（画质优先）
    var preferQuality = !!(settings && settings.streamPreference === 'quality');

    // 视频笔记：视频排在最前
    if (note.video && sel.indexOf(-1) !== -1) {
      var vList = (preferQuality ? note.video.urlStreamsBest : note.video.urlStreams) || [];
      if (!vList.length) vList = note.video.urlStreams || note.video.urlStreamsBest || [];
      var vTop = vList.length ? vList[0] : (note.video.urlStream || '');

      var vurl = '';
      if (settings && settings.videoQuality === 'origin') {
        vurl = note.video.urlOrigin || vTop;
      } else {
        vurl = vTop || note.video.urlOrigin;
      }
      if (vurl) {
        seq++;
        var vname = sanitize(renderName(rule, buildVars(note, seq, settings)));
        tasks.push({
          kind: 'video',
          url: vurl,
          dir: dir,
          name: (vname || 'video') + '.mp4',
          fallbacks: chainFallbacks(vurl, vList,
            [note.video.urlStream, note.video.urlOrigin])
        });
      }
    }

    images.forEach(function (img) {
      if (!img || sel.indexOf(img.index) === -1) return;
      seq++;
      var base = sanitize(renderName(rule, buildVars(note, seq, settings))) || ('image_' + img.index);

      // 「仅实况视频」时不应再产出静态图任务，否则设置项名不副实
      var wantImage = liveMode !== 'video-only';

      // 实况视频同样按排序策略挑主直链
      var liveList = (preferQuality ? img.liveVideoUrlsBest : img.liveVideoUrls) || [];
      if (!liveList.length) liveList = img.liveVideoUrls || img.liveVideoUrlsBest || [];
      var liveTop = liveList.length ? liveList[0] : (img.liveVideoUrl || '');
      var wantLive = liveMode !== 'image-only' && !!liveTop;

      if (wantImage) {
        var fmt = (settings && settings.imageFormat) || 'origin';
        var url = '';
        var ext = '.jpg';
        if (fmt === 'origin') {
          url = img.urlOrigin || img.urlDefault;
          ext = guessExt(url, '.jpg') === '.webp' ? '.jpg' : guessExt(url, '.jpg');
        } else if (fmt === 'default') {
          url = img.urlDefault;
          ext = guessExt(url, '.jpg');
        } else if (fmt === 'jpg') {
          url = img.urlJpg || img.urlOrigin || img.urlDefault;
          ext = '.jpg';
        }
        if (url) {
          tasks.push({
            kind: 'image',
            url: url,
            dir: dir,
            name: base + ext,
            live: false,
            fallbacks: [img.urlOrigin, img.urlDefault, img.urlJpg].filter(function (u, i, a) {
              return u && u !== url && a.indexOf(u) === i;
            })
          });
        }
      }

      // 实况照片配套短视频：与静态图同序号、加 _live 后缀，便于配对排序
      if (wantLive) {
        tasks.push({
          kind: 'live',
          url: liveTop,
          dir: dir,
          name: base + '_live.mp4',
          fallbacks: chainFallbacks(liveTop, liveList, [])
        });
      }
    });

    return tasks;
  }

  return {
    DEFAULT_RULE: DEFAULT_RULE,
    DEFAULT_TIME_FORMAT: DEFAULT_TIME_FORMAT,
    PLACEHOLDERS: PLACEHOLDERS,
    formatTime: formatTime,
    sanitize: sanitize,
    renderName: renderName,
    buildTasks: buildTasks,
    buildCommentTasks: buildCommentTasks,
    guessExt: guessExt
  };
})();
