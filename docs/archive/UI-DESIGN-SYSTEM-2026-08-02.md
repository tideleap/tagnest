# TagNest 统一设计规范（首页风格提炼）

- **日期:** 2026-08-02
- **规范来源:** 从已上线的卡通首页（DashboardPage）逐项提炼，作为全站统一准则
- **技术基础:** React 18 + Tailwind CSS v4（CSS-first token）+ lucide 图标 + 6 主题（light/dark/aurora/blossom/starlight + system）

---

## 一、色彩体系

| 语义令牌 | 用途 | 代表值（light） |
|---|---|---|
| `--color-canvas` | 页面背景 | `oklch(.985 .003 85)` 暖米白 |
| `--color-surface` | 卡片/面板/侧栏 | `#fff` |
| `--color-sunken` | 凹陷/输入/分割 | `oklch(.955 .005 85)` |
| `--color-ink` | 标题与正文 | `oklch(.24 .012 65)` |
| `--color-ink-soft/-faint` | 次级/弱提示文字 | 中性灰 |
| `--color-brand` | 主操作（按钮） | 深琥珀 `oklch(.63 .15 62)` |
| `--color-brand-accent` | 强调/记忆点（首页数字/待办） | 焦橙 `#d93f07` |
| `--color-brand-soft/-ink` | 品牌浅底 + 其上文字 | 琥珀浅底/深棕 |
| `--color-positive/-caution/-critical` | 成功/提醒/危险状态 | 绿/琥珀/红（各含 soft+ink） |
| `--color-line/-strong` | 边框层次 | 灰 |

**使用比例**：canvas ~60% / surface ~25% / sunken ~8% / brand ~5% / brand-accent ~2%（点睛）。
**对比度**：正文与 canvas ≥ 7:1（AAA）；`brand-accent` 在白底 ~4.6:1（AA）。

---

## 二、字体排版

- 正文字体栈：`Inter var, Inter, -apple-system, PingFang SC, Microsoft YaHei, Noto Sans SC`
- 等宽：`JetBrains Mono, SFMono-Regular, Menlo, Consolas`（用于数字/快捷键）
- **字号阶梯**（紧凑常规页面）：
  `2xs .6875 / xs .75 / sm .8125 / base .9375 / lg 1.125 / xl 1.5 / 2xl 2rem`
- **Display 展示档**（仅首页 hero / 空状态）：
  `3xl 2.5rem / 4xl 3rem / 5xl 3.75rem`
- 标题字重 600 + `tracking-tight` + `text-wrap: balance`；正文 `text-wrap: pretty`

---

## 三、空间与圆角

### 间距
- 基础单元由 Tailwind spacing 驱动；页面内边距 `px-3 sm:px-4 xl:px-6`
- 区块间隔 `gap-4 / gap-6 / gap-8`；卡片网格 `gap-3`

### 圆角（三档）
| token | 值 | 场景 |
|---|---|---|
| `--radius-sm` | .375rem | 按钮、输入、segmented 内项 |
| `--radius-md` | .625rem | 常规卡片、input/select |
| `--radius-lg` | 1rem | 大面板、hero、统计卡 |
| `--radius-full` | 9999px | badge / tag / avatar / switch |

### 阴影（三档）
| token | 值 | 场景 |
|---|---|---|
| `--shadow-raised` | 极浅 | 卡片默认、选中 segmented |
| `--shadow-overlay` | 中层 | hover 抬升、菜单 |
| `--shadow-modal` | 深 | 弹窗/抽屉/MobileNav |

---

## 四、组件样式（统一准则）

| 组件 | 风格 | 关键类 |
|---|---|---|
| **Button primary** | 品牌底 + 白字 + `shadow-raised` + hover 深一档 | `bg-brand text-on-brand` |
| **Button secondary** | 白底 + 浅边框 + hover 底变色 | `bg-surface border-line` |
| **Button ghost** | 透明 + hover 浅底 | 用于次要操作 |
| **Button danger** | 危险红 | 破坏性操作 |
| **点击反馈** | `btn-ripple::after` CSS 波纹（scale+淡出） | `.btn-ripple` |
| **卡片** | 首页/统计：`rounded-lg border-line hover:-translate-y-0.5 hover:shadow-raised` | 数据卡轻抬升 |
| **导航块** | hover 仅变色（不抬升）| 区分"可点数据"vs"导航" |
| **Input/Select/Textarea** | `border-line rounded-md focus:ring-brand/25` | `CONTROL_BASE` |
| **Switch** | 品牌色滑块 + 弹簧位移动画 | |
| **Badge** | 圆角胶囊 + soft 底 + 状态点 | `rounded-full` |
| **TagChip** | 8 色固定色相 + 圆点 + 可移除 | oklch 色板 |
| **Modal** | <md 底部抽屉 / ≥md 居中弹窗，`shadow-modal`，底幕模糊 | |
| **SegmentedControl** | sunken 容器 + 选中白底抬升 | |

---

## 五、交互动效（全站）

- 全部 **只动画 transform/opacity**（合成器线程），严禁动画布局属性
- 缓动 `--ease-out-soft: cubic-bezier(.22,1,.36,1)`
- **时长**：微交互 150-200ms；hover 抬升 150ms；modal 240ms；进场 500-800ms
- **滚动渐显**：`useInView`（IntersectionObserver，命中卸除）+ `.reveal-card`
- **点击即反馈**：按钮波纹、switch 滑块位移动画
- **respect `prefers-reduced-motion`**：全局 guard 禁用/降级
- **有序感**：卡片网格用 `transition-delay: calc(var(--i)*50ms)` 级联

---

## 六、响应式断点与行为

| 断点 | 尺寸 | 布局行为 |
|---|---|---|
| base | <480 | 单列、Modal 底部抽屉、mobile 底部 TabBar、侧栏为抽屉 |
| `md` 48rem | 768 | 侧栏图标 rail（隐藏文字）、双列栅格 |
| `lg` 64rem | 1024 | 全宽侧栏（带文字）、三/四列 |
| `xl` 80rem | 1280 | 更宽内容列 `max-w-7xl` |
| `2xl` 96rem | 1536 | 宽屏上限 |

**核心原则**：移动端不隐藏关键功能；内容主列 `max-w-7xl` + 流式 padding；表格/长列表横向溢出用 `overflow-x-auto`；触控目标 ≥ 44px。

---

## 七、本规范约束源码对照目录

- 设计令牌：`src/styles/theme.css`
- 全局工具/动效：`src/styles/index.css`
- 布局外壳（侧栏/顶栏/移动 TabBar）：`src/components/layout/`
- 通用 UI（按钮/表单/弹窗/徽标/分段/开关/空状态）：`src/components/ui/`
- 装饰（吉祥物/光斑/渐显/纹理）：`src/components/decor/`
- 首页（规范范本）：`src/pages/DashboardPage.tsx`
