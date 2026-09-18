# 小红书图片视频实况下载助手

> 一款基于 **Microsoft Edge / Chrome（Manifest V3）** 的浏览器扩展。
> **唯一把「实况照片（Live Photo）」当一等公民处理的小红书下载扩展** —— 图片、视频、实况配套短视频，一键全拿。

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-ff2442)](https://developer.chrome.com/docs/extensions/mv3/)
[![Permissions](https://img.shields.io/badge/permissions-downloads%20%2B%20storage-1a9e5c)](#权限说明)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

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

- **图片**：原图直链（换 CDN 域名重拼 `fileKey`，无损）/ 常规压缩图 / 强制 JPG 三档
- **视频**：原画质（`origin_video_key` 直链）/ 页面播放流（H.264，兼容性优先）两档
- **实况照片**：静态图 + 配套短视频成对下载，视频以 `_live` 结尾便于配对排序
- **批量**：单条笔记全选 / 反选 / 勾选任意组合
- **命名**：8 个占位符自由组合模板，实时预览效果
- **目录**：可指定根目录，可按作者昵称 / 笔记标题自动建子目录
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
"host_permissions": ["*://*.xiaohongshu.com/*"]
```

只申请两个权限，**没有 `<all_urls>`、没有 `webRequest`、没有 `tabs`、没有 `declarativeNetRequest`**。

- `downloads` —— 调用浏览器下载能力保存文件
- `storage` —— 保存你的设置、悬浮球位置与去重记录（全部存在本地，不上传）
- `host_permissions` —— 内容脚本注入小红书页面所需

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
┌───────────────────────── Edge (Manifest V3) ─────────────────────────┐
│                                                                       │
│  [MAIN world]  src/page-interceptor.js                                │
│   · PerformanceObserver 观察媒体 URL（纯被动，零侵入，主路径）        │
│   · 旁路监听 XHR / fetch 的 JSON 响应（增强路径，可运行时卸载）       │
│   · 多时机扫描 window.__INITIAL_STATE__（SPA 状态注入时机不定）       │
│   · 三级降级：初始状态 → 接口响应 → 内联 script 正则                  │
│   · 播放健康看门狗：<video> 报错立即自动卸载钩子                      │
│                        ↓ window.postMessage                           │
│  [ISOLATED world]  src/content/*.js                                   │
│   · content.js  编排：笔记状态、SPA 串台防护、下载调度                │
│   · ui.js       Shadow DOM 悬浮球 + 侧滑面板 + Toast                  │
│   · downloader.js  命名模板 / 文件名清洗 / 任务构建                   │
│   · styles.js   设计令牌与全部样式（封装在 Shadow Root 内）           │
│                        ↓ chrome.runtime.sendMessage                   │
│  [Service Worker]  src/background.js                                  │
│   · 串行下载队列、备用直链重试、字节级进度回传                        │
│   · 按 URL 去重（chrome.storage.session）                             │
│   · 进度只回传给 sender.tab.id，切标签页不会串台                      │
│                                                                       │
│  [Popup] 摘要 + 一键全下    [Options] 命名 / 画质 / 实况 / 目录       │
└───────────────────────────────────────────────────────────────────────┘
```

### 关键实现要点

1. **绝不 clone 媒体响应**：只对 JSON / text 类型做 `response.clone().text()`。若对视频字节流做 clone，会把整段视频缓冲进内存，直接拖垮甚至阻断播放。
2. **钩子可降级**：被包裹的 `fetch` / `XHR` 做了 `toString` 原生伪装；一旦页面 `<video>` 出现加载错误，立刻自动卸载全部钩子。宁可少抓数据，也绝不影响用户正常看视频。
3. **SPA 串台防护**：切换笔记时按 URL 上的 noteId 校验数据归属，不一致直接丢弃，避免把上一篇的文件名套到这一篇上。
4. **实况照片识别**：实况短视频藏在 `image_list[i].stream.h264[0].master_url`，不在图片直链里，必须从数据结构中单独取。

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
    └── shot_options.py        设置页渲染截图（无头 Edge）
```

### 运行测试

```bash
node tests/test-downloader.js
node tests/test-background.js
node tests/test-extractor.js
```

全部为纯 Node 脚本，不需要安装任何依赖。

### 生成 UI 预览

```bash
python tools/make_preview.py
```

会产出一个自包含的 HTML，直接复用扩展的真实源码渲染面板与 Popup，可在浏览器中打开查看效果。

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
