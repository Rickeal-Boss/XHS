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

  /** 从 URL 猜扩展名（兜底用）
   * 落盘扩展名一律跟随 URL 实际后缀，不按"容器类型"改写：小红书评论区语音的 URL
   * 通常以 .m4a 结尾，本地多数播放器（potplayer/vlc/qq影音等）按扩展名 + 内部嗅探
   * 识别媒体类型，若强行写成 .mp4 会被当成视频。 */
  function guessExt(url, fallback) {
    try {
      var path = String(url).split('?')[0].toLowerCase();
      var m = path.match(/\.(mp4|mov|webm|m4v|m4a|aac|jpg|jpeg|png|webp|heic|gif|avif|opus|ogg|wav|flac)$/);
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
   * 评论媒体目录的「笔记标识」。
   *
   * 评论对象里只有评论自身的信息（commentId / author / asrText），拿不到所属笔记，
   * 所以由调用方把当前笔记作为第三个参数传进来。标识取「标题前 20 字 + 笔记 id 后 6 位」：
   * 标题便于用户肉眼分辨，id 尾部保证标题相同（或为空）时仍然唯一。
   */
  function noteDirTag(note) {
    if (!note || typeof note !== 'object') return '';
    var title = sanitize(note.title || '').slice(0, 20);
    var id = String(note.noteId || '');
    var tail = id.length > 6 ? id.slice(-6) : id;
    if (title && tail) return title + '_' + tail;
    return title || tail;
  }

  /**
   * 评论区媒体（图片 / 语音）任务。
   *
   * 目录：落到 baseDir/评论/<笔记标识>/ 下。评论媒体在 UI 里的条目只带评论信息，
   * 不带笔记信息，所以按笔记分目录必须靠第三个参数 note；note 缺失时退回
   * baseDir/评论/（向后兼容，例如旧调用点或测试桩）。
   * 不按笔记分目录时，两篇笔记的评论图会同名，Chrome 只能改成 (1)(2)，用户无法分辨归属。
   *
   * 语音的容器确实是 MP4（小红书用 sns-video 系域名分发音频，无服务端转码能力），
   * 但落盘扩展名跟随 URL 实际后缀（通常是 .m4a），本地播放器才不会把语音当成视频；
   * 文件名带 _voice 后缀以便识别；有语音转写文字（asrText）时优先用它命名。
   */
  function buildCommentTasks(items, settings, note) {
    var tasks = [];
    if (!Array.isArray(items) || !items.length) return tasks;

    var root = String((settings && settings.baseDir) || '小红书下载').replace(/^[\\/]+|[\\/]+$/g, '');
    var tag = noteDirTag(note);
    var dir = (root ? root + '/' : '') + '评论/' + (tag ? tag + '/' : '');

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
          name: label + '_voice' + guessExt(it.url, '.m4a'),
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
