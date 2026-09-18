/**
 * 小红书下载助手 — 注入样式（字符串形式，供 Shadow DOM 使用）
 * 全部样式封装在 Shadow Root 内，不污染宿主页面，也不被宿主页面污染。
 * 不使用任何 CDN / 外部字体 / 外部图标，满足 MV3 CSP 要求。
 *
 * 隔离策略：宿主元素显式重置，不使用 `all: initial`
 * （`all` 会连带清掉 position:fixed 等，反而更危险）。
 */
var XHS_DL_CSS = `
/* ============================ 设计令牌 ============================ */
:host {
  --xhs-red: #ff2442;
  --xhs-red-hover: #ff3d57;
  --xhs-red-text: #d81e38;
  --xhs-red-soft: rgba(255, 36, 66, 0.08);

  --xhs-bg: #ffffff;
  --xhs-bg-sub: #f7f7f8;
  --xhs-bg-hover: #f2f3f5;

  --xhs-text: #1f1f1f;
  --xhs-text-sub: #6b6b70;
  --xhs-text-mute: #9a9aa0;

  --xhs-border: #e8e8ea;
  --xhs-border-strong: #d9d9dd;

  --xhs-success: #1a9e5c;
  --xhs-warn: #d98b16;
  --xhs-error: #e5484d;

  --xhs-r-sm: 6px;
  --xhs-r-md: 10px;
  --xhs-r-lg: 14px;
  --xhs-r-full: 999px;

  --xhs-sh-sm: 0 1px 3px rgba(0, 0, 0, .08);
  --xhs-sh-md: 0 6px 24px rgba(0, 0, 0, .12);
  --xhs-sh-lg: 0 16px 48px rgba(0, 0, 0, .18);

  /* 小红书自身弹层极多，层级必须拉到极限 */
  --xhs-z-ball: 2147483000;
  --xhs-z-panel: 2147483200;
  --xhs-z-toast: 2147483400;

  --xhs-sp-1: 4px;
  --xhs-sp-2: 8px;
  --xhs-sp-3: 12px;
  --xhs-sp-4: 16px;
  --xhs-sp-5: 20px;
  --xhs-sp-6: 24px;

  --xhs-font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
             "Hiragino Sans GB", "Microsoft YaHei", sans-serif;

  font-family: var(--xhs-font);
  font-size: 13px;
  line-height: 1.5;
  color: var(--xhs-text);
  text-align: left;
  -webkit-font-smoothing: antialiased;
  font-style: normal;
  font-weight: 400;
  letter-spacing: normal;
}

.xhs-dl, .xhs-dl * { box-sizing: border-box; margin: 0; padding: 0; border: 0; background: none; }
.xhs-dl button { font-family: inherit; font-size: inherit; cursor: pointer; }
.xhs-dl img { display: block; max-width: none; }
.xhs-dl ul, .xhs-dl li { list-style: none; }
.xhs-dl svg { display: block; flex: 0 0 auto; }

/* 安全网：凡是带 display 声明的元素，hidden 属性都会失效
   （作者样式的 display 会盖过 UA 的 [hidden]{display:none}）。
   这里显式兜底，避免再次踩坑。 */
[hidden] { display: none !important; }

/* ============================ 悬浮球 ============================ */
.xhs-dl-ball {
  position: fixed;
  right: 20px;
  bottom: 88px;
  z-index: var(--xhs-z-ball);
  width: 48px;
  height: 48px;
  border-radius: var(--xhs-r-full);
  background: var(--xhs-bg);
  border: 1px solid var(--xhs-border);
  box-shadow: var(--xhs-sh-md);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--xhs-red-text);
  cursor: grab;
  user-select: none;
  touch-action: none;
  outline: none;
  transition: transform .18s cubic-bezier(.23, 1, .32, 1),
              box-shadow .18s ease, border-color .18s ease;
}
.xhs-dl-ball:hover {
  transform: scale(1.06);
  border-color: var(--xhs-red);
  box-shadow: 0 8px 28px rgba(255, 36, 66, .26);
}
.xhs-dl-ball:focus-visible { outline: 2px solid var(--xhs-red); outline-offset: 2px; }
.xhs-dl-ball.is-dragging { cursor: grabbing; transition: none; }
.xhs-dl-ball.is-empty { color: var(--xhs-text-mute); }
.xhs-dl-ball .xhs-dl-badge {
  position: absolute;
  top: -3px;
  right: -3px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--xhs-r-full);
  background: var(--xhs-red);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  text-align: center;
  box-shadow: 0 1px 4px rgba(0, 0, 0, .22);
}

/* ============================ 遮罩 ============================ */
.xhs-dl-mask {
  position: fixed;
  inset: 0;
  z-index: var(--xhs-z-panel);
  background: rgba(0, 0, 0, .32);
  display: none;
}
.xhs-dl-mask.is-open {
  display: block;
  animation: xhs-dl-fade .2s ease;
}
@keyframes xhs-dl-fade { from { opacity: 0; } to { opacity: 1; } }

/* ============================ 面板 ============================ */
/* 关键：显隐由 .is-open 类驱动，不要用 hidden 属性 —— 本规则里的 display
   会覆盖 UA 的 [hidden]{display:none}，导致面板永远打不开。 */
.xhs-dl-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: var(--xhs-z-panel);
  width: 380px;
  max-width: calc(100vw - 48px);
  background: var(--xhs-bg);
  box-shadow: var(--xhs-sh-lg);
  display: none;
  flex-direction: column;
}
.xhs-dl-panel.is-open {
  display: flex;
  animation: xhs-dl-in .26s cubic-bezier(.23, 1, .32, 1);
}
@keyframes xhs-dl-in {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}

/* --------------------------- 头部 --------------------------- */
.xhs-dl-head {
  flex: 0 0 auto;
  padding: var(--xhs-sp-4) var(--xhs-sp-4) var(--xhs-sp-3);
  border-bottom: 1px solid var(--xhs-border);
}
.xhs-dl-head-top { display: flex; align-items: center; gap: var(--xhs-sp-2); }
.xhs-dl-title {
  flex: 1 1 auto;
  font-size: 16px;
  font-weight: 600;
  color: var(--xhs-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.xhs-dl-iconbtn {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: var(--xhs-r-sm);
  color: var(--xhs-text-sub);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background .15s ease, color .15s ease;
}
.xhs-dl-iconbtn:hover { background: var(--xhs-bg-hover); color: var(--xhs-text); }
.xhs-dl-iconbtn:focus-visible { outline: 2px solid var(--xhs-red); outline-offset: 1px; }

.xhs-dl-meta {
  margin-top: var(--xhs-sp-3);
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--xhs-text-sub);
  overflow: hidden;
}
.xhs-dl-meta > * { white-space: nowrap; }
.xhs-dl-avatar {
  width: 24px;
  height: 24px;
  border-radius: var(--xhs-r-full);
  object-fit: cover;
  background: var(--xhs-bg-sub);
  flex: 0 0 auto;
}
.xhs-dl-meta-name { font-weight: 500; color: var(--xhs-text); }
/* 元信息之间的分隔点：颜色比正文淡一档，且不参与 flex 压缩
   （否则空间紧张时「·」会被挤没，两个字段看起来像连在一起） */
.xhs-dl-meta-dot { flex: 0 0 auto; color: var(--xhs-text-mute); }
.xhs-dl-meta-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
  min-width: 0;
}

/* --------------------------- 工具条 --------------------------- */
.xhs-dl-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--xhs-sp-2);
  padding: var(--xhs-sp-3) var(--xhs-sp-4);
  background: var(--xhs-bg-sub);
  border-bottom: 1px solid var(--xhs-border);
}
.xhs-dl-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--xhs-text-sub);
  cursor: pointer;
  user-select: none;
}
.xhs-dl-check input { accent-color: var(--xhs-red); cursor: pointer; }
.xhs-dl-spacer { flex: 1 1 auto; }
.xhs-dl-count { font-size: 12px; color: var(--xhs-text-mute); }

/* --------------------------- 资源列表 --------------------------- */
.xhs-dl-body {
  flex: 1 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--xhs-sp-3) var(--xhs-sp-4) var(--xhs-sp-4);
}
.xhs-dl-body::-webkit-scrollbar { width: 8px; }
.xhs-dl-body::-webkit-scrollbar-thumb { background: var(--xhs-border-strong); border-radius: 4px; }
.xhs-dl-body::-webkit-scrollbar-track { background: transparent; }

.xhs-dl-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--xhs-sp-2); }
.xhs-dl-item {
  position: relative;
  aspect-ratio: 3 / 4;
  border-radius: var(--xhs-r-md);
  overflow: hidden;
  background: var(--xhs-bg-sub);
  border: 2px solid transparent;
  cursor: pointer;
  transition: border-color .15s ease, transform .15s ease;
}
.xhs-dl-item:hover { transform: translateY(-1px); }
.xhs-dl-item:focus-visible { outline: 2px solid var(--xhs-red); outline-offset: 2px; }
.xhs-dl-item.is-checked { border-color: var(--xhs-red); }
.xhs-dl-item.is-checked::after {
  content: "";
  position: absolute;
  inset: 0;
  background: var(--xhs-red-soft);
  pointer-events: none;
}
.xhs-dl-item img { width: 100%; height: 100%; object-fit: cover; }
.xhs-dl-ph {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--xhs-text-mute);
  font-size: 11px;
}
.xhs-dl-tag {
  position: absolute;
  left: 4px;
  top: 4px;
  z-index: 2;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  color: #fff;
  background: rgba(0, 0, 0, .55);
}
.xhs-dl-tag.is-live { background: var(--xhs-red); }
.xhs-dl-tick {
  position: absolute;
  right: 5px;
  top: 5px;
  z-index: 2;
  width: 18px;
  height: 18px;
  border-radius: var(--xhs-r-full);
  background: rgba(255, 255, 255, .94);
  border: 1.5px solid var(--xhs-border-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  color: transparent;
  transition: background .15s ease, border-color .15s ease, color .15s ease;
}
.xhs-dl-item.is-checked .xhs-dl-tick {
  background: var(--xhs-red);
  border-color: var(--xhs-red);
  color: #fff;
}
.xhs-dl-idx {
  position: absolute;
  left: 5px;
  bottom: 4px;
  z-index: 2;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 11px;
  color: #fff;
  background: rgba(0, 0, 0, .45);
}
.xhs-dl-sub {
  position: absolute;
  right: 5px;
  bottom: 4px;
  z-index: 2;
  font-size: 10px;
  color: #fff;
  background: rgba(0, 0, 0, .45);
  border-radius: 4px;
  padding: 0 4px;
}

/* --------------------------- 空 / 提示 --------------------------- */
.xhs-dl-empty {
  padding: 48px 20px;
  text-align: center;
  color: var(--xhs-text-mute);
  font-size: 13px;
}
.xhs-dl-empty svg { margin: 0 auto var(--xhs-sp-3); opacity: .5; }
.xhs-dl-empty p { margin-bottom: 6px; }
.xhs-dl-hint { font-size: 12px; color: var(--xhs-text-mute); }

.xhs-dl-banner {
  margin-bottom: var(--xhs-sp-3);
  padding: var(--xhs-sp-2) var(--xhs-sp-3);
  border-radius: var(--xhs-r-sm);
  font-size: 12px;
  display: flex;
  gap: 6px;
  align-items: flex-start;
  line-height: 1.45;
}
.xhs-dl-banner.is-warn { background: #fff7e6; color: #8a5a00; }
.xhs-dl-banner.is-error { background: #fdecec; color: #a3232b; }
.xhs-dl-banner.is-info { background: var(--xhs-red-soft); color: var(--xhs-red-text); }

/* --------------------------- 底部 --------------------------- */
.xhs-dl-foot {
  flex: 0 0 auto;
  padding: var(--xhs-sp-3) var(--xhs-sp-4) var(--xhs-sp-4);
  border-top: 1px solid var(--xhs-border);
  background: var(--xhs-bg);
}
.xhs-dl-btn {
  width: 100%;
  height: 40px;
  border-radius: var(--xhs-r-md);
  background: var(--xhs-red);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: background .15s ease, opacity .15s ease;
}
.xhs-dl-btn:hover:not(:disabled) { background: var(--xhs-red-hover); }
.xhs-dl-btn:disabled { opacity: .5; cursor: not-allowed; }
.xhs-dl-btn:focus-visible { outline: 2px solid var(--xhs-red); outline-offset: 2px; }
.xhs-dl-btn.is-ghost {
  background: var(--xhs-bg-sub);
  color: var(--xhs-text);
  border: 1px solid var(--xhs-border);
}
.xhs-dl-btn.is-ghost:hover:not(:disabled) { background: var(--xhs-bg-hover); }
.xhs-dl-btn-row { display: flex; gap: var(--xhs-sp-2); margin-top: var(--xhs-sp-2); }

.xhs-dl-progress { display: none; margin-top: var(--xhs-sp-3); }
.xhs-dl-progress.is-on { display: block; }
.xhs-dl-bar { height: 6px; border-radius: 3px; background: var(--xhs-bg-sub); overflow: hidden; }
.xhs-dl-bar > i {
  display: block;
  height: 100%;
  width: 0;
  border-radius: 3px;
  background: var(--xhs-red);
  transition: width .25s ease;
}
.xhs-dl-progress-text {
  margin-top: 6px;
  display: flex;
  justify-content: space-between;
  gap: var(--xhs-sp-2);
  font-size: 12px;
  color: var(--xhs-text-sub);
}
.xhs-dl-progress-text span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* --------------------------- Toast --------------------------- */
.xhs-dl-toasts {
  position: fixed;
  left: 50%;
  bottom: 48px;
  transform: translateX(-50%);
  z-index: var(--xhs-z-toast);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--xhs-sp-2);
  pointer-events: none;
}
.xhs-dl-toast {
  max-width: 380px;
  padding: 9px 16px;
  border-radius: var(--xhs-r-full);
  background: rgba(31, 31, 31, .92);
  color: #fff;
  font-size: 13px;
  box-shadow: var(--xhs-sh-md);
  animation: xhs-dl-toast-in .22s cubic-bezier(.23, 1, .32, 1);
}
.xhs-dl-toast.is-error { background: rgba(196, 40, 46, .95); }
.xhs-dl-toast.is-success { background: rgba(21, 128, 74, .95); }
@keyframes xhs-dl-toast-in {
  from { opacity: 0; transform: translateY(8px) scale(.96); }
  to { opacity: 1; transform: none; }
}

/* --------------------------- 无障碍 --------------------------- */
@media (prefers-reduced-motion: reduce) {
  .xhs-dl-ball, .xhs-dl-item, .xhs-dl-toast, .xhs-dl-bar > i { transition: none !important; }
  .xhs-dl-toast { animation: none !important; }
  .xhs-dl-panel.is-open { animation: none !important; }
  .xhs-dl-mask.is-open { animation: none !important; }
}
`;
