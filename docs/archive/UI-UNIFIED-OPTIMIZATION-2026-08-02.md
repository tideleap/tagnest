# TagNest 前端统一 UI 优化报告

- **日期:** 2026-08-02
- **规范基准:** 从首页（DashboardPage）提炼的 [UI-DESIGN-SYSTEM](./UI-DESIGN-SYSTEM-2026-08-02.md)
- **目标:** 响应式 + 侧边栏 + 后台组件三块，全部对齐首页视觉语言（暖中性 + 琥珀品牌 + 焦橙 accent + 圆角卡片 + 轻阴影 + transform/opacity 动效）
- **验证:** typecheck 0 error / lint 0 warning / vite build ✓（table-wrap、card-interactive、btn-ripple 均编译进 CSS）

---

## 一、改动说明（按模块）

### 1) 网页自适应（响应式）
现状已具良好基础（Modal 底部抽屉、4 断点、移动 TabBar），本次补齐统一工具：
- 新增 `.table-wrap` 工具类：**表格/宽网格在窄屏自动横向滚动且圆角包裹**，杜绝把内容列撑破。
- 新增 `.card-interactive` 工具类：首页风格"悬停轻抬升 + 阴影"抽成单一可复用类，任何后台面板 `+card-interactive` 即获得与首页数据卡一致的 hover 反馈。
- 侧栏移动端抽屉底幕加 `backdrop-blur`，与 Modal 底幕一致，卡片层级更清晰。
- 全站扫描确认无固定像素宽 `w-[px]` 溢出隐患，栅格均用 `sm/md/lg` 响应式类。

### 2) 侧边栏（折叠/选中/悬停/移动端抽屉）
- **选中态**：新增左侧焦橙圆角**指示条**（`h-5 w-1 rounded-full bg-brand-accent`），呼应首页 brand-accent 印记；激活时全显、悬停时预显 40%，让"可选中"在点按前就可发现。
- **悬停态**：图标 `hover:scale-110` 轻放大（transform-only，合成器友好）；行背景 `hover:bg-surface-hover`。
- **折叠/展开**：保留既有的 `w-14` icon rail ↔ `lg:w-60` 全宽切换，指示条只在有文字时该行依然简洁（绝对定位不受文字显隐影响）。
- **移动端抽屉**：底幕模糊 + `shadow-modal` 卡片级抽屉，导航切换自动关闭。

### 3) 后台管理组件（表格/表单/按钮/弹窗/状态标签/分页）
- **状态标签 Badge**：新增 `dot` 属性 → 前置**状态点**，颜色按 tone 取品牌/成功/警告/危险 token；用于后台列表状态列（如"已部署/失败/待确认"）。
- **空状态 EmptyState**：icon 容器升级为暖色双环（`brand-soft` 外环 + `surface` 内环 + `shadow-raised`），标题升 `text-lg`，与首页 pastel 记忆点呼应；替代原灰扑扑的 single sunken 圆。
- **按钮 Button**：primary / danger 变体默认加 `btn-ripple`（CSS 点击波纹），让主操作/破坏操作有统一触感反馈；ghost/secondary 保持安静。
- **设置面板 Card**（`pages/settings/Card.tsx`）：`rounded-md` → `rounded-lg` + 加 `shadow-raised`，对齐首页卡片。
- **新增通用 Card 组件**（`ui/Card.tsx`）：`Card` / `CardHeader` / `CardBody` 三件套，作为后台面板统一外壳（后续新页面直接复用，杜绝面板样式漂移）。
- 分页：本项目书签列表用**无限滚动**（虚拟化），非传统分页；已确认其"加载更多 / 到底"提示样式存在且与卡片视觉一致，无需改。

---

## 二、涉及文件清单

| 文件 | 类型 | 改动 |
|---|---|---|
| `docs/UI-DESIGN-SYSTEM-2026-08-02.md` | 新增 | 全站统一设计规范（从首页提炼） |
| `src/components/ui/Card.tsx` | 新增 | Card / CardHeader / CardBody 统一面板外壳 |
| `src/components/ui/index.ts` | 改动 | 导出 Card 组件 |
| `src/components/ui/Display.tsx` | 改动 | Badge 加 `dot` 状态点；EmptyState 暖色双环 |
| `src/components/ui/Button.tsx` | 改动 | primary/danger 默认加 `btn-ripple` |
| `src/components/layout/Sidebar.tsx` | 改动 | 选中态左侧指示条、悬停图标缩放、移动抽屉底幕模糊 |
| `src/pages/settings/Card.tsx` | 改动 | `rounded-lg` + `shadow-raised` |
| `src/styles/index.css` | 改动 | 新增 `.table-wrap`、`.card-interactive` 工具类 |

---

## 三、核心代码片段

**新增 .table-wrap / .card-interactive（index.css）**
```css
.table-wrap {
  @apply overflow-x-auto rounded-lg border border-line;
  -webkit-overflow-scrolling: touch;
}
.card-interactive {
  @apply transition-all duration-150;
  @apply hover:-translate-y-0.5 hover:shadow-raised hover:border-line-strong;
}
```

**Badge 状态点（Display.tsx）**
```tsx
export function Badge({ children, tone = 'neutral', dot = false, className }) {
  return (
    <span className={cx('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-2xs font-medium', BADGE_TONE[tone], className)}>
      {dot && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: BADGE_DOT[tone] }} />}
      {children}
    </span>
  );
}
```

**侧边栏选中指示条（Sidebar.tsx NavRow）**
```tsx
<span aria-hidden className={cx(
  'absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-full bg-brand-accent transition-all duration-150',
  isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-40',
)} />
```

**统一面板 Card（ui/Card.tsx）**
```tsx
export function Card({ children, className, interactive }) {
  return (
    <div className={cx('rounded-lg border border-line bg-surface',
      interactive && 'transition-all duration-150 hover:-translate-y-0.5 hover:shadow-raised hover:border-line-strong', className)}>
      {children}
    </div>
  );
}
```

---

## 四、优化前后对比

| 项 | 优化前 | 优化后 |
|---|---|---|
| 侧边栏选中 | `bg-brand-soft` 平铺底 | 底 + 左侧焦橙指示条（悬停预显） |
| 侧边栏悬停 | 仅背景变色 | 背景 + 图标 scale 放大 |
| 移动抽屉底幕 | 纯黑半透明 | 黑半透明 + 1px 模糊 |
| 状态标签 | 纯文字胶囊 | 可带 tone 状态点 |
| 空状态 | 灰单环 icon | 暖色双环 + 阴影，标题更大 |
| 主/危险按钮 | 仅 hover 变色 | + 点击波纹反馈 |
| 设置面板 | rounded-md 平 | rounded-lg + 轻阴影 |
| 后台面板 | 各页手写 | 统一 Card 三件套 |
| 宽表格 | 可能撑破布局 | .table-wrap 自动横滚 |

---

## 五、一致性保障

- 所有新增样式复用既有 `--color-*` / `--radius-*` / `--shadow-*` 语义令牌（不新增裸色），6 主题自动继承。
- 动效全部 transform/opacity，受全局 `prefers-reduced-motion` 保护。
- 无新增依赖、无破坏既有 API；typecheck / lint / build 全绿。
