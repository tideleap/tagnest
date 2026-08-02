# 首页卡通化视觉升级说明

- **日期:** 2026-08-02
- **方向:** 活泼明快卡通插画 + 强互动，填充留白、避免空洞
- **技术:** 保持 React 18 + Tailwind v4 技术栈；**未引入任何动画库**，全部用 CSS keyframes + 原生 IntersectionObserver + Pointer Events，保证体积与性能。

---

## 一、改动了哪些模块

| 模块 | 类型 | 作用 |
|---|---|---|
| `src/hooks/useInView.ts` | **新增** | 一次性的滚动进场检测（IntersectionObserver，命中即 unobserve），尊重 `prefers-reduced-motion` |
| `src/components/decor/CartoonMascot.tsx` | **新增** | "Nesty" 书签小精灵吉祥物——原始 SVG，可拖拽、可点击有随机台词 |
| `src/components/decor/index.tsx` | **新增** | `Reveal`（滚动渐显容器）、`DecorBlob`（卡通彩色光斑）、`Scribble`（手绘波浪下划线）、`DottedBg`（点阵背景纹理） |
| `src/styles/index.css` | **改动** | 新增卡通动效 keyframes 与工具类（float/wiggle/pop/spin/ripple/reveal） |
| `src/pages/DashboardPage.tsx` | **重写** | 集成全部卡通元素与互动，重新规划布局填满留白 |

## 二、各动画/互动效果的实现方式

| 效果 | 触发 | 实现 |
|---|---|---|
| **吉祥物待机浮动** | 页面常驻 | `.mascot-idle` → `@keyframes tn-float`（3.2s 上下 7px，ease-in-out） |
| **吉祥物悬停摇摆** | mouseover | `.mascot-idle:hover .mascot-wiggle` → `@keyframes tn-wiggle`（旋转 ±8°+ 微缩放，0.5s） |
| **吉祥物点击弹跳 + 随机台词** | click | React `key={popKey}` 重触发 `@keyframes tn-pop`（scale 到 1.16 再回落）；`setQuip` 轮换 6 句台词，气泡 `tn-quip` 2.2s 淡入淡出 |
| **吉祥物拖拽彩蛋** | Pointer down/move/up | `setPointerCapture` + `getBoundingClientRect` 计算偏移 → 只改 `transform`（合成器线程，不卡）；松手后 2.5s 弹回原位 |
| **卡片进场渐显（滚动）** | 滚入视口 | `useInView`（IntersectionObserver，命中即停）+ `.reveal-card` 的 `opacity`/`transform` 过渡；`transition-delay` 按 index*50ms 级联 |
| **按钮点击波纹** | :active | `.btn-ripple::after` + `@keyframes tn-ripple`（scale 0.6→1.7 淡出，0.5s，CSS-only，无 JS） |
| **小太阳慢转** | 常驻 | `.decor-spin-slow` → `@keyframes tn-spin-slow`（14s 一圈），纯装饰 |
| **彩色光斑漂移** | 常驻 | `DecorBlob`（`blur-xl` + 低透明度）+ CSS float，填充背景空白 |

## 三、性能与可访问性

- **只动画 transform/opacity**：所有动效都走合成器属性，不触发布局重排（符合 motion 最佳实践）。
- **无动效库**：CSS keyframes + IntersectionObserver + Pointer Events，零新增依赖，包体积几乎不变。
- **reduced-motion**：全局已有 `prefers-reduced-motion` 兜底（`animation-duration:0.01ms`）调用的 `useInView` 在 reduce 下直接返回 true、不观察，内容立即显示。
- **装饰不可点**：`DecorBlob/DottedBg/Scribble` 全部 `aria-hidden` + `pointer-events-none`；吉祥物有 `role="img"` + 可访问标签。
- **响应式**：Hero 在 `md` 下横排（左文案右吉祥物），移动端堆叠吉祥物居中；注意力卡/构成卡/快捷入口随断点从 1/2/4 列切换。

## 四、填留白的具体手段

Hero 用了点阵纹理 + 三个彩色光斑（左上/右上/底部）+ 旋转小太阳 + 手绘下划线 + 吉祥物；快捷入口区是整块虚线圆角面板 + 点阵 + 每项彩色图标；卡片用 6 色 pastel 调色板（红/橙/黄/绿/蓝/紫）让内容区也有色彩呼吸感，避免大段空白。
