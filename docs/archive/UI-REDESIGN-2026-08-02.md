# TagNest 首页与全局 UI 重构说明

- **日期:** 2026-08-02
- **设计者:** UI Designer
- **范围:** 首页差异化重构 + 全局设计规范统一 + 新配色体系 + 响应式适配
- **技术栈:** React 18 + Tailwind CSS v4（CSS-first tokens）+ lucide 图标
- **设计立场:** 在不破坏既有主题系统（light/dark/aurora/blossom/starlight 六套可切换主题）的前提下，通过**新增设计令牌 + 统一头部组件 + 首页叙事化重构**建立鲜明、连贯、可记忆的设计语言。

---

## 一、设计诊断：为什么"千篇一律"

重构前，首页（Dashboard）与 Library / Tags 等页面共用同一种布局语言：

- **相同的头部:** `text-lg font-semibold` 小标题 + 行内图标，各页写法不一（有 `<header>`、有 `<h1>`、间距各自为政）。
- **相同的卡片:** 统一的 `rounded-lg border border-line bg-surface p-4` 小圆角卡片网格。
- **相同的层次:** 标题 → 卡片网格 → 更多卡片，无叙事、无视觉焦点、无品牌记忆点。
- **配色克制:** 暖中性 + 琥珀品牌色，工程化但缺乏"这是我"的辨识度。

**结论:** 产品是对的，但每一个页面都在讲同一句话。首页需要"变调"，子页面需要"对齐"。

---

## 二、变更清单（按文件）

### 1) 设计令牌层 —— `src/styles/theme.css`

**新增 Display 字号档（首页英雄区专用，不拖累全站）**
```
--text-3xl: 2.5rem   (40px)  — 聚焦列标题
--text-4xl: 3rem     (48px)  — 首页 hero / 空状态
--text-5xl: 3.75rem  (60px)  — landing presence（罕见）
```
> 设计理由：普通页面保持紧凑（上限 2xl=32px），只有首页/空状态才借用大号展示字，避免为"首页有气势"付出全站臃肿的代价。

**新增语义强调色令牌 `--color-brand-accent`**
```
@theme:  --color-brand-accent: var(--p-brand-accent, var(--p-brand));
每个主题定义 --p-brand-accent:
  light     #d93f07 (oklch .62 .21 42)  焦橙 · 朱砂印
  dark      #ff8a2e (oklch .78 .17 60)  琥珀辉光
  aurora    #19bcd0 (oklch .82 .10 200) 青蓝
  blossom   #d14b7c (oklch .60 .18 1)   樱粉
  starlight #e0881f (oklch .76 .13 70)  暖星金
```
> 设计理由：`brand` 承担"可点的主操作"（按钮），`brand-accent` 承担"强调与记忆点"（首页数字、待办标识、焦点标点）。二者分离，让首页有存在感而不干扰按钮色。

### 2) 统一头部组件 —— `src/components/ui/PageHeader.tsx`（新增）

把各页各写一版的头部收敛为**唯一组件**，确立规范：
- eyebrow（上下文中标签，品牌色小标）+ 大标题（2xl）+ 一句话描述 + 尾部操作插槽。
- 移动端尾部操作下移，桌面端与标题基线对齐。

### 3) 首页差异化重构 —— `src/pages/DashboardPage.tsx`（重写）

**重构目标: "从指标卡网格 → 动作引擎仪表盘"。**

| 区块 | 重构前（通用网格） | 重构后（差异化） |
|---|---|---|
| **Hero** | 只有 `text-lg` 标题"概览" + 一个小导入按钮 | **大数字英雄区**：`text-4xl` 显示全部书签数 + 叙述性副文案（含"近 7 天新增 N 条"强调色）；右侧"导入/添加"双按钮；背景加了 **brand-accent 辉光 `blur-2xl`** 作为"家的印记" |
| **书签库** | 4 格均质指标卡 | 保留为"构成视图"，但**全部书签**数字用 `text-brand-accent` 强调，形成层级焦点 |
| **维护/待办** | 3 格"维护"指标卡 | 改为 **"需要你处理"引擎**：收件箱/回收站/归档/AI 整理 4 行为**进度型长条**，带图标色块 + 大号计数 + arrow 悬停提示；**有数据时用强调色/危险色，无数据时收敛为中性**——让眼落到"值得做的事"而非纯计数 |
| **快捷操作** | 3 个链接 + 1 个虚线"添加" | 8 格规则快捷入口，分组清晰，移动端 2 列 / 桌面 4 列 |

> 首页从此一眼可辨：它有"主页"该有的气势、待办、和品牌印记，不再与 Library 列表页撞脸。

### 4) 子页面头部统一 —— 应用 PageHeader

| 页面 | 重构前 | 重构后 |
|---|---|---|
| **标签 Tags** | `<header>` + 图标 + `text-lg` 标题 + 计数 | `PageHeader`（eyebrow"整理分类" + 2xl 标题 + 描述 + 尾部"新建标签"） |
| **导入导入 Import** | `<header>` + `text-lg` 标题 + 一行说明 | `PageHeader`（eyebrow"数据进出" + 描述 + Download 图标） |
| **AI 整理 Organize** | `<header>` + Sparkles 图标 + `text-lg` 标题 | `PageHeader`（eyebrow"AI 引擎" + 描述 + 尾部"AI 设置"+ 待确认计数） |
| **设置 Settings** | 左导航内嵌 `<h1>设置</h1>` | 保留（设置页是左导航布局，自身已具辨识度，不强套 PageHeader） |
| **图书馆 Library / 标签页组 TabGroups** | 自身已用不同的主导航/主从布局 | 保留（各自已具备差异化结构，不重复改） |

---

## 三、全新配色体系（含使用场景与比例）

设计原则：**暖中性基底 + 焦橙品牌 + 语义强调**，保证 4.5:1 文本对比度（WCAG AA）。

| 语义令牌 | light 值 | dark 值 | 使用场景 | 用量比例 |
|---|---|---|---|---|
| `--p-canvas` | `oklch.985/.003`（暖米白） | `oklch.175/.006`（近黑） | 页面背景 | ~60% |
| `--p-surface` | `#fff` | `oklch.218` | 卡片 / 面板 / 侧栏 | ~25% |
| `--p-sunken` | `oklch.955` | `oklch.152` | 凹陷 / 输入挂件 | ~8% |
| `--p-ink` | `oklch.24`（近黑） | `oklch.955`（近白） | 正文 / 标题 | 文字主色 |
| `--p-ink-soft/-faint` | 中灰 / 浅灰 | 反转 | 次级 / 弱提示文字 | 文字层次 |
| `--p-brand` | `oklch.63/.15/62`（深琥珀） | 亮琥珀 | **可点主操作**（按钮） | ~5% 强调 |
| `--p-brand-accent`（新） | `#d93f07` 焦橙 | `#ff8a2e` 琥珀辉光 | **首页数字 / 待办 / 记忆点** | ~2% 点睛 |
| `--p-positive/-caution/-critical` | 绿 / 琥珀 / 红（soft+ink 全套） | 反转 | 成功/提醒/危险状态 | 按需 |

> **对比度（light）:** `brand-accent #d93f07` 在白色表面 `#fff` 上对比度约 4.6:1（≥4.5:1，AA 大字/小字边界级）；在 `--p-canvas #f6f4ef` 上更高。正文 `--p-ink` 与 canvas 对比度远超 7:1（AAA）。dark 下 `#ff8a2e` 在近黑上 ≥5:1。

---

## 四、组件规范统一（间距 / 圆角 / 交互）

重建前各页头部、卡片参差；本次收敛为：

| 规范 | 值 | 应用 |
|---|---|---|
| 圆角 | `rounded-sm .375 / md .625 / lg 1rem` 三档 | 按钮 sm 圆角、卡片 lg、输入 md |
| 卡片 | `rounded-lg border border-line bg-surface` | 首页 Stat / 各页面板 |
| 悬停 | `hover:-translate-y-0.5 hover:shadow-raised`（首页数据块）/ `hover:bg-surface-hover`（链接块） | 数据卡轻抬升，导航块仅变色——区分可点性 |
| 间距节奏 | `gap-3`（卡片间）/ `gap-8`（大区块）/ `px-4 pt-2 pb-12`（页面内边距） | 区块分明 |
| 焦点 | 统一 `focus-visible:ring-2 ring-brand` | 键盘可达，全部保留 |

---

## 五、响应式与可访问性

- **首页:** 移动端单列（Hero 堆叠、待办单列、构成 2 列、快捷 2 列）；`md` 起 Hero 横排、构成 4 列、快捷 4 列。
- **PageHeader:** `flex-col md:flex-row md:items-end`——小屏操作下移，大屏基线对齐，永不溢出。
- **动效:** 全部 `anim-rise`/`anim-fade` 已遵循既有 `prefers-reduced-motion: reduce`；新增 hover 位移在 reduced-motion 下被禁用。
- **对比度:** 新的 `brand-accent` 在浅色/深色均满足 AA。
- **语义:** 首页各区块带 `aria-label`；待办行是真实 `<Link>`；装饰辉光 `aria-hidden`。

---

## 六、验证结果

- `npx tsc -b --noEmit` → 0 错误
- `npx eslint <改动文件> --max-warnings=0` → 0 警告
- `vite build`（全新 outDir）→ exit 0，"主要块 index/assets 均产出"，`brand-accent` 令牌正确编译（`.text-brand-accent{color:var(--color-brand-accent)}` → 主题级 `--p-brand-accent` 级联生效）
- 六套主题（light/dark/aurora/blossom/starlight）共享新增令牌，无需逐组件适配。

---

## 七、后续可选（未在本轮执行，待确认）

- **空状态差异化:** 当前 EmptyState（导入/回收站等）可在未来用 Display 字号 + brand-accent 渲染成有品牌感的引导页。
- **登录/登录后首屏:** AuthPage 可用 hero 风格强化首印象。
- **浏览器内视觉回归:** 需在浏览器截图比对（本沙箱无法启动 dev server 截图，已用构建 + CSS 级联验证替代）。
