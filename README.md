# 小红书图片视频实况下载助手

> 一款基于 **Microsoft Edge / Chrome（Manifest V3）** 的浏览器扩展。
> **唯一把「实况照片（Live Photo）」当一等公民处理的小红书下载扩展** —— 图片、视频、实况配套短视频，一键全拿。

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-ff2442)](https://developer.chrome.com/docs/extensions/mv3/)
[![Permissions](https://img.shields.io/badge/permissions-downloads%20%2B%20storage-1a9e5c)](#权限说明)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![CI](https://github.com/Rickeal-Boss/XHS/actions/workflows/ci.yml/badge.svg)](https://github.com/Rickeal-Boss/XHS/actions/workflows/ci.yml)

---

## 为什么是它

| | 本扩展 | 油猴脚本 | Python 工具 |
|---|---|---|---|
| 安装门槛 | 加载即用，**零依赖** | 需先装 Tampermonkey | 需 Python + Cookie |
| 需要逆向签名 | **不需要** | 不需要 | 需要维护 `x-s` 算法 |
| **实况照片** | ✅ **图片 + 短视频成对下载** | 部分支持 | ❌ 普遍不处理 |
| 原图 / 原画质 | ✅ | 部分支持 | ✅ |
| 可上架分发 | ✅ | ❌ | ❌ |

**技术护城河**：扩展运行在真实浏览器会话内，页面自己会带着合法的 `x-s` / `x-t` 签名去请求数据接口，我们只需**旁路监听**页面自身发出的合法请求即可拿到完整媒体信息 —— 完全不需要逆向小红书的签名算法，也就不会因为前端改版而失效。

---

## 功能

- **SPA 免刷新取源**（核心）：站内点开新笔记（SPA 切换）后**自动取源，不再需要 `Ctrl+Shift+R` 整页刷新**。切换瞬间按 `300 / 800 / 1500 / 3000 ms` 多次重试扫描；仍拿不到时用**同源 `fetch` 重取当前网址的服务端页面**取源 —— 不刷新页面、不丢滚动位置、不闪屏，不伪造请求头、不做签名，3s 节流
- **数据来源徽标**：面板头部显示本条数据从哪来 —— `源 · 原画质`（绿）/ `源 · 自动重取`（蓝，即上面那条软刷新救回来的）/ `降级 · DOM 提取`（橙，**可点击**，点了重新取源）。以前用户不知道自己为什么画质差，现在一眼可见
- **图片**：原图直链（换 CDN 域名重拼 `fileKey`，无损）/ 常规压缩图 / 强制 JPG 三档
- **视频**：原画质（`origin_video_key` 直链）/ 页面播放流两档
- **多档直链择优**：同一笔记出现多个分辨率/编解码器时，可选「兼容性优先」（H.264 最稳，默认）或「画质优先」（跨编解码器取最高，可能选中 H.265/AV1，老旧播放器可能打不开）
- **实况照片**：静态图 + 配套短视频成对下载，视频以 `_live` 结尾便于配对排序；短视频走完整的备用直链重试链
- **评论区媒体**：评论区附带的图片与**语音消息**可单独勾选下载，落在 `评论/<笔记标识>/` 子目录（**按笔记分目录**，多篇笔记的评论媒体不再堆在同一个 `评论/` 里互相撞名）；语音以转写文字（若有）命名，落盘后缀跟随 URL 实际后缀（通常是 `.m4a`），本地播放器不会再把它当成视频
- **国际站**：兼容 `www.rednote.com`（小红书海外版，CDN 域名 `sns-web-i10.rednotecdn.com`）
- **批量**：单条笔记全选 / 反选 / 勾选任意组合
- **可中断**：下载一批时点「取消」立即停止后续任务
- **命名**：8 个占位符自由组合模板，实时预览效果
- **目录**：可指定根目录，可按作者昵称 / 笔记标题自动建子目录
- **批次中断自愈**：MV3 的 Service Worker 空闲会被浏览器回收，过去会导致进度条永久卡住、此后无法再下载（只能刷新页面）。现在批次状态落在 `chrome.storage.session`，SW 重启后自检并补发中断通知解锁 UI，另有 10 分钟看门狗兜底
- **其他**：下载进度（字节级）、失败自动换备用直链重试、同一会话内重复文件自动跳过、复制全部直链、导出元数据 JSON

---

## 安装

### Edge

1. 下载或克隆本仓库
2. 打开 `edge://extensions/`
3. 打开左下角「**开发人员模式**」
4. 点击「**加载解压缩的扩展**」，选择本仓库根目录（含 `manifest.json` 的那一层）

### Chrome

同上，地址改为 `chrome://extensions/`。

> 需要 Chrome / Edge **111 及以上**（使用了 `content_scripts.world: "MAIN"`）。

---

## 使用

1. 打开任意小红书笔记详情页（`www.xiaohongshu.com/explore/...`）
2. 页面右下角出现**悬浮球**，角标显示本条笔记的可下载资源数
3. 点击悬浮球展开侧滑面板，勾选想要的内容 → 点「下载选中」
4. 或者点击浏览器工具栏的扩展图标 → 「下载本笔记全部」

悬浮球可**拖动**，位置会被记住。按 `Esc` 关闭面板。

面板头部会显示本条数据的**来源徽标**：绿色 `源 · 原画质` 表示拿到了源数据；蓝色 `源 · 自动重取` 表示这次是软刷新救回来的；橙色 `降级 · DOM 提取` 表示只从 DOM 抠到了压缩图，**点击该徽标可重新取源**。

### 自动重新取源

设置页新增 **自动重新取源**（`spaSource`，**默认开启**）：开启后，站内切换笔记且读不到源数据时，扩展会自动对当前网址再请求一次服务端数据（就是徽标里 `源 · 自动重取` 的来源）。若你介意这次额外请求，或发现页面异常，可在设置页关闭。

---

## 命名模板

模板中用 `<占位符>` 表示变量，可用占位符：

| 占位符 | 含义 |
|---|---|
| `<序号>` | 媒体在笔记中的顺序，从 1 开始 |
| `<笔记id>` | 小红书笔记 ID |
| `<标题>` | 笔记标题（无标题时取正文前 40 字） |
| `<发布时间>` | 按设置中的时间格式渲染 |
| `<ip归属地>` | 发布时的 IP 归属地 |
| `<发布者昵称>` | 作者昵称 |
| `<小红书号>` | 作者的小红书号 |
| `<发布者id>` | 作者的平台 ID |

默认模板：`[<发布者昵称>] <标题>_<序号>`

生成的文件名会自动处理：Windows 非法字符、结尾的 `.` 与空格、保留设备名（`CON`/`COM1`/`LPT1` 等）、以及**全路径长度**（兼容 Windows 260 字符上限）。

---

## 权限说明

```json
"permissions": ["downloads", "storage"],
"host_permissions": [
  "https://*.xiaohongshu.com/*",
  "https://*.rednote.com/*"
]
```

只申请两个权限，**没有 `<all_urls>`、没有 `webRequest`、没有 `tabs`、没有 `declarativeNetRequest`、也没有 `cookies` / `debugger`**。

- `downloads` —— 调用浏览器下载能力保存文件
- `storage` —— 保存你的设置、悬浮球位置与去重记录（全部存在本地，不上传）
- `host_permissions` —— 内容脚本注入小红书 / 国际站（`rednote.com`）页面所需；国际站域名单独列出，没有放宽到通配所有站点

**关于防盗链**：`sns-img-*.xhscdn.com` 等 CDN 的防盗链策略是「拦截第三方 Referer、放行无 Referer 请求」。扩展发起的下载天然不带 Referer，实测可正常拿到文件（见下方实测记录），因此**不需要**修改请求头，也就没有申请相关权限。

---

## 实测记录

在沙箱环境对真实 CDN 直链做过对照实测（`tools/` 外的验证脚本产物见提交历史）：

| 请求头 | `sns-img-bd.xhscdn.com` | `sns-img-hw.xhscdn.net` | `sns-img-qc.xhscdn.com` |
|---|---|---|---|
| 无 Referer | ✅ 200 | ✅ 200 | ✅ 200 |
| `Referer: https://www.xiaohongshu.com/` | ✅ 200 | ✅ 200 | ✅ 200 |
| `Referer: https://example.com/` | ❌ 403 | ❌ 403 | ❌ 403 |

结论：CDN 对无 Referer 与同源 Referer 均放行，仅拦截第三方 Referer。扩展下载路径无需任何请求头改写。

---

## 架构

```
┌────────────────────────── Edge (Manifest V3) ─────────────────────────┐
│                                                                       │
│  [MAIN world]  src/page-interceptor.js                                │
│   · PerformanceObserver 观察媒体 URL（纯被动，零侵入，主路径）        │
│   · 旁路监听 XHR / fetch 的 JSON 响应（增强路径，可运行时卸载）       │
│   · 路由事件驱动：pushState / Navigation API 触发切换流程             │
│   · 重试扫描 __INITIAL_STATE__：300/800/1500/3000ms，命中即停         │
│   · 免刷新取源：仍无源 → 同源 fetch 重取当前 URL 的 SSR 页（3s 节流） │
│   · 取源链路：初始状态 → 接口响应 → 内联 script → 软刷新 → DOM 兜底   │
│   · 播放健康看门狗：<video> 连错 3 次才卸钩子，30s 后自动重装         │
│                        ↓ window.postMessage                           │
│  [ISOLATED world]  src/content/*.js                                   │
│   · content.js  编排：笔记状态、SPA 串台防护、降级判定、下载调度      │
│   · ui.js       Shadow DOM 悬浮球 + 侧滑面板 + Toast + 来源徽标       │
│   · downloader.js  命名模板 / 文件名清洗 / 任务构建                   │
│   · styles.js   设计令牌与全部样式（封装在 Shadow Root 内）           │
│                        ↓ chrome.runtime.sendMessage                   │
│  [Service Worker]  src/background.js                                  │
│   · 串行下载队列、备用直链重试、字节级进度回传                        │
│   · 按 URL 去重（chrome.storage.session）                             │
│   · 批次状态落 session：SW 被回收后自检补发中断通知（10 分钟兜底）    │
│   · 进度只回传给 sender.tab.id，切标签页不会串台                      │
│                                                                       │
│  [Popup] 摘要 + 一键全下    [Options] 命名 / 画质 / 实况 / 目录 / 取源│
└───────────────────────────────────────────────────────────────────────┘
```

### 关键实现要点

1. **绝不 clone 媒体响应**：只对 JSON / text 类型做 `response.clone().text()`。若对视频字节流做 clone，会把整段视频缓冲进内存，直接拖垮甚至阻断播放。
2. **钩子可降级且能自愈**：被包裹的 `fetch` / `XHR` 做了 `toString` 原生伪装；`<video>` **连续 3 次**报错才卸载全部钩子（单次报错多半是视频源自身的问题，旧实现一报错就卸，误判后只能刷新页面才恢复），卸载后 **30s 自动重装**。宁可少抓数据，也绝不影响用户正常看视频。
3. **SPA 串台防护**：切换笔记时按 URL 上的 noteId 校验数据归属，不一致直接丢弃，避免把上一篇的文件名套到这一篇上。
4. **实况照片识别**：实况短视频藏在 `image_list[i].stream.h264[0].master_url`，不在图片直链里，必须从数据结构中单独取。
5. **SPA 免刷新取源**：切换流程由 `pushState` / `replaceState` / Navigation API 事件驱动（旧实现只靠 1s 轮询，既慢，又会漏掉「切走又切回同一 URL」这种不产生事件差异的情况）。切换后按 `300 / 800 / 1500 / 3000 ms` 逐次重扫 `__INITIAL_STATE__`，命中即停；全部落空才发一次 `fetch(location.href, { credentials: 'include' })` 重取服务端 SSR 页面。**不刷新页面、不丢滚动位置、不闪屏**，也不伪造请求头、不做签名；3s 节流，避免连续切换时重复请求。
6. **软刷新期间不提前降级**：软刷新是异步的，若此时先落到 DOM 兜底，压缩图会覆盖掉随后取到的源数据。因此软刷新进行中会挂起降级判定，等结果回来再定，并按结果显示对应徽标。
7. **批次中断自愈**：`chrome.storage.session` 记录批次状态，SW 被回收重启后自检 —— 发现残留批次即补发一条带 `interrupted` 的结束通知，解锁 UI；另设 10 分钟看门狗兜底，避免进度条永久卡死。

---

## 目录结构

```
.
├── manifest.json
├── icons/                     图标（由 tools/make_icons.py 纯 Python 生成）
├── src/
│   ├── page-interceptor.js    MAIN world 拦截与提取引擎
│   ├── background.js          下载服务
│   ├── content/
│   │   ├── content.js         编排层
│   │   ├── ui.js              Shadow DOM UI
│   │   ├── downloader.js      命名规则与任务构建
│   │   └── styles.js          注入样式
│   ├── popup/                 工具栏弹窗
│   └── options/               设置页
├── tests/                     Node 单元测试（零依赖，直接 node 运行）
└── tools/
    ├── make_icons.py          图标生成脚本（零依赖）
    ├── make_preview.py        生成自包含的 UI 预览页
    ├── diag_panel.py          面板显隐诊断（无头 Edge）
    ├── shot_options.py        设置页渲染截图（无头 Edge）
    ├── test_bridge.py         消息桥与提取引擎的真实浏览器验证（无头 Edge）
    ├── check_path_budget.js   buildPath 长度预算的属性测试
    ├── check_base_spread.js   pickBase 的 CDN 域名分布检查
    ├── check_big_state.py     超大 __INITIAL_STATE__ 下仍能读到笔记
    ├── check_comment_media.py 评论区图片 / 语音提取
    ├── check_spa_source.py   真 Edge + 合成页面的 SPA 取源验证（10 场景）
    └── check_manifest.js      manifest.json 与图标资产完整性
```

### 运行测试

```bash
node tests/test-downloader.js
node tests/test-background.js
node tests/test-extractor.js
node tests/test-static.js

# 汇总运行（任一失败非零退出码）
node tests/run-all.js

# 不变式 / 属性测试
node tools/check_path_budget.js    # 路径长度上限、扩展名保留、无空段、段尾无点空格
node tools/check_base_spread.js    # 确定性 + 分散性
node tools/check_manifest.js       # manifest / 图标 / 权限一致性

# 需要本机 Edge 的真浏览器验证
python tools/check_big_state.py       # 5.3 万对象的巨型状态仍能读到笔记
python tools/check_comment_media.py   # 评论区图片 / 语音提取
python tools/check_spa_source.py      # SPA 取源 10 场景（路由顺序、软刷新取源、
                                      # 不提前降级、钩子自愈、相对路径、延迟注入重试等）
```

`check_spa_source.py` 在真 Edge 里用**合成页面**驱动扩展，逐场景断言取源行为 —— 包括「`ROUTE_CHANGE` 先于新 `NOTE`、`navSeq` 自增」「软刷新取到源」「软刷新期间不得提前降级」「3s 内不重复发 fetch」「URL 归属校验」「钩子 1 次 error 不卸 / 3 次才卸 / 30s 后自动重装」「相对路径 `/api/...` 旁路仍生效」「状态延迟注入也能被后一次重试命中」等。

全部为纯 Node 脚本，不需要安装任何依赖。`tools/test_bridge.py` 需要本机 Edge，在真实浏览器里验证 MAIN world ↔ 隔离世界的消息桥与三条提取路径（原图重拼 / 原视频 / 实况视频）：

```bash
python tools/test_bridge.py
```

### CI

每次 push / PR 都会跑 `.github/workflows/ci.yml`：Node 18/20/22 矩阵上依次执行语法检查、manifest 完整性、单元测试汇总、属性测试；独立 job 校验图标是合法 PNG 且尺寸与声明一致。

### 两个关键不变式

**下载路径长度**。Windows 的 `MAX_PATH` 约束的是**全路径**，而 `baseDir / 作者 / 标题` 三级目录本身就可能吃掉全部预算。`buildPath` 保证：

```
sum(目录段长) + 段数 + 文件名主体长 + 扩展名长 ≤ 180
```

压缩采用**水位法**（二分统一上限）而非按比例切，因此短段（作者昵称）尽量完整保留，只削过长的那几段；截断后统一清理段尾的点与空格（Windows 会静默剥离，导致实际落盘名与预期不符）。

**CDN 域名选择**。`pickBase` 对 `fileKey` 做 djb2 哈希取模，语义是「**按 key 稳定、跨 key 分散**」：

- *稳定* —— 同一张图在任何时刻、任何次扫描都得到同一个 URL。这不只是可复现性问题：`background.js` 的会话级去重表是按 URL 建的，早期用 `Math.random()` 时同一张图每次 URL 都不同，去重永远命中不了，重复下载会产出 `标题 (1).jpg` 这类冗余文件。
- *分散* —— 大量不同 `fileKey` 仍均匀落在各 CDN 域名上（实测最多/最少 ≤ 1.05），保留负载分散的好处。

### 生成 UI 预览

```bash
python tools/make_preview.py
```

会产出一个自包含的 HTML，直接复用扩展的真实源码渲染面板与 Popup，可在浏览器中打开查看效果。

---

## 排障

打开小红书笔记页 → `F12` 打开控制台：

- **搜 `XHS-DL`** 可看到取源各环节的日志。其中 `NOTE accepted` / `NOTE rejected` 会明确写出**收到的是哪条 noteId、当前 URL 是哪条** —— 切笔记后如果一直 `rejected`，说明拿到的是上一条的数据，会被串台防护丢弃。
- `已取到源数据（来源=…）` 表示命中；若看到 `未取到源，诊断信息：` 会附带完整诊断 JSON。
- 想直接拿结构化结论，在 Console 执行：

```js
window.__XHS_DL_DIAG__()
```

返回：

```json
{ "noteId": "…", "source": "initial-state", "imageCount": 9, "hasVideo": false,
  "commentCount": 3, "degraded": false, "navSeq": 2, "softRefresh": "ok" }
```

字段含义：`source` 为取源方式（`dom` 即 DOM 降级）；`degraded: true` 表示当前只有压缩图；`navSeq` 是路由切换序号，可用于判断「切换是否被感知」；`softRefresh` 取值 `idle` / `ok` / `failed` / `skipped`，`failed` 说明连服务端重取也没拿到。

反馈问题时把这段 JSON 贴出来即可。

---

## 开源方案调研

实现前系统调研了 GitHub / Gitee 上的同类方案，主要参考与取舍：

| 项目 | 借鉴点 | 我们的取舍 |
|---|---|---|
| `JoeanAmier/XHS-Downloader`（12.7k★） | 原视频直链构造方式 | 舍弃其签名方案 —— 浏览器内无需签名 |
| `NEORUAA/XHS_Downloader_Android`（524★） | 实况视频字段路径、`__INITIAL_STATE__` 兜底解析 | 采纳 |
| `hohband/xhs-video-helper` | MV3 `world: MAIN` 注入、绝不 clone 媒体流、只扫 JSON 端点 | 采纳其架构思路 |
| `kongzhu2/XHS_Downloader_Chrome_Extension`（34★） | DOM 兜底提取 | 仅作最后一级降级 |
| 油猴脚本「小红书下载助手」v2.0.0 | 原图 `fileKey` 正则、命名模板、多域名重试 | 采纳其提取算法 |

---

## 免责声明

- 本扩展为**个人学习与研究用途**的非官方工具，与小红书（行吟信息科技）**无任何关联**，未获其授权或认可。
- 本扩展**不调用任何私有接口、不绕过任何付费或私密内容**，仅复用当前页面已加载的公开数据。
- 请仅下载你有权访问和保存的内容，尊重原作者版权，不要用于商业用途或二次分发。
- 使用本扩展产生的一切后果由使用者自行承担。

## License

[MIT](LICENSE)
