# TagNest 需求台账与接续执行规范

> 本文回答一个问题：**「还有哪些需求没做完，下一步该做哪一项，怎么保证不漏。」**
>
> 单一事实源是 `docs/backlog.json`；下方状态表由 `npm run backlog:write` 自动生成；
> 一致性由 `npm run backlog:check` 在 CI 中强制校验。三者任一不同步，CI 即失败。

---

## 一、为什么需要这份文档

需求分散在三处会必然漂移：`docs/03-TagNest优化清单.md`（净室重写前的 19 项）、
`docs/PM-REVIEW-2026-08-01.md`（O/Q/R 三组）、以及每轮对话里的临时决定。
过去已经出现过两次真实事故：

- `REVIEW-2026-08-01.md` 声称 O5–O9 未实现，实际全部已上线；
- `README.md` 声称 AI 自动标签「已接线到 provider」，而 `functions/api/ai/settings.ts`
  的注释明写 *intentionally inert*。

结论：**靠人记忆和散落文档判断进度是不可靠的。** 因此把「完成」的定义变成可执行的探针，
把台账变成 CI 门禁的一部分。

---

## 二、未完成判定标准（DoD）

一项需求只有**同时**满足以下五条，才允许标记为 `done`：

| # | 门槛 | 校验方式 |
| --- | --- | --- |
| 1 | **代码就位** — 声明的实现文件/符号在仓库中真实存在 | `backlog.json` 的 `evidence` 探针（`file` / `grep`） |
| 2 | **测试就位** — 存在对应单测，或已纳入 `scripts/smoke.sh` | `evidence` 的 `test` / `mincount` 探针 |
| 3 | **门禁通过** — `npm run typecheck`、`npm run lint`、`npm test` 全绿 | CI `ci.yml` |
| 4 | **依赖闭合** — 所有 `dependsOn` 的前置项处于 `done` 或 `superseded` | 校验器拓扑检查 |
| 5 | **口径同步** — README / 台账不含与实现矛盾的表述 | `nogrep` 反向探针 |

任一条不满足 ⇒ 该项即为**未完成**，必须留在 `open` 队列中。

### 状态取值

| 状态 | 含义 | 是否需 `note` |
| --- | --- | --- |
| `done` | 五条门槛全部满足 | 否 |
| `open` | 未完成，在执行队列内 | 否 |
| `superseded` | 因净室重写等原因不再适用 | **是** |
| `blocked-external` | 代码侧无事可做，等待人工/外部动作 | **是** |

> 不设 `partial` 状态。半成品一律拆成粒度更小的两项，一项 `done`、一项 `open`。
> 例：O12 的「手动整理」记为 `done`，「整窗收纳」并入 O10 记为 `open`。

### 双向校验（防漏的关键）

校验器不仅检查「标 done 却没做」，也检查「做了却没标」：

- `done` 但探针不全过 → **失败**（回归或虚假声明）
- `open` 但探针全过 → **失败**（已完成未登记，容易被当作「还没做」重复投入或被遗忘）

---

## 三、执行顺序规则

排序按下列优先级依次比较，**先满足前一条的排前面**：

1. **正确性与信任优先** — 文档失实、安全、数据正确性问题（P0）永远插队到最前，
   因为它们会污染后续所有判断。
2. **依赖拓扑** — 被依赖项先于依赖方。`dependsOn` 未闭合的项不得启动。
3. **优先级** — P0 → P1 → P2 → P3。
4. **成本/收益比** — 同级内，改动面小、回归风险低的先做，尽早缩短队列。
5. **编号字典序** — 前四条都相同时的稳定兜底，保证顺序可复现。

`blocked-external` 项不进入队列，但每轮结束时必须向用户复述一次，避免静默沉底。

---

## 四、状态跟踪机制

### 工具链

```bash
npm run backlog:check   # 校验一致性（CI 执行，不一致则退出码 1）
npm run backlog:write   # 重新生成下方状态表
```

`scripts/backlog-check.mjs` 支持的证据探针：

| 类型 | 语义 |
| --- | --- |
| `file` | 路径存在 |
| `absent` | 路径不存在（用于「应删除」类需求） |
| `grep` | 指定文件匹配正则 |
| `nogrep` | 指定文件**不**匹配正则（防止虚假宣传/回潮） |
| `test` | `tests/<name>.test.ts` 存在 |
| `mincount` | 匹配某 glob 的文件数不少于 N |

### 每轮闭环流程（SOP）

```
1. 读 docs/BACKLOG.md 的「当前执行队列」，取第 1 项
2. 实现 + 补测试
3. npm run typecheck && npm run lint && npm test
4. 在 docs/backlog.json 中把该项改为 done，补/改 evidence 探针
5. npm run backlog:write   （刷新状态表）
6. npm run backlog:check   （双向校验必须通过）
7. 提交并推送，确认 CI 绿；必要时做生产联调
8. 回到第 1 步，直到队列为空
```

### 防漏保证

- **入口唯一**：任何新需求必须先进 `backlog.json` 才能开工，否则不会出现在队列里。
- **出口唯一**：只有探针全过才能标 `done`，无法靠口头宣称结束。
- **CI 常驻**：`backlog:check` 是 CI 的一步，台账过期会直接把主干拦下。
- **零遗漏收敛**：队列为空 ⟺ 所有项均处于 `done` / `superseded` / `blocked-external`，
  且后两者都带书面理由。

---

## 五、需求全集与当前状态

<!-- BEGIN:BACKLOG-TABLE -->

> 自动生成于 `npm run backlog:write`，请勿手动编辑本区块。
> 登记 100 条（其中 2 条为跨文档别名），独立需求 98 项：✅ done 94 ／ ➖ superseded 3 ／ ⏸ blocked-external 1

| 编号 | 需求 | 优先级 | 状态 | 证据 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `F-P0-1` | 设计令牌链路（Tailwind v4 CSS-first） | P0 | ✅ done | 1/1 |  |
| `F-P0-2` | 原子组件层与设计规范 | P0 | ✅ done | 2/2 |  |
| `F-P0-3` | 统一应用外壳与容器 | P0 | ✅ done | 1/1 |  |
| `F-P0-4` | 导入功能（Netscape / JSON / CSV） | P0 | ✅ done | 3/3 |  |
| `F-P0-5` | 修复后端 group_id / 软删除过滤 Bug | P0 | ➖ superseded | 人工核验 | 净室重写未继承该代码；列表查询自建时即带 deleted_at IS NULL，无 group_id 列引用。 |
| `F-P0-6` | 登出清理本地缓存（跨账号数据隔离） | P0 | ✅ done | 1/1 |  |
| `F-P0-7` | 清理死代码约 6000 行 | P0 | ➖ superseded | 人工核验 | 净室重写不存在原项目死代码；本仓库无 functions/api/tab/**、无孤儿页面、无混淆依赖。 |
| `F-P0-8` | 品牌统一为 TagNest | P0 | ✅ done | 2/2 |  |
| `F-P1-1` | 响应式断点体系 | P1 | ✅ done | 2/2 |  |
| `F-P1-2` | 信息架构：单层导航 + 统一回收站 + 404 | P1 | ✅ done | 2/2 | 概览页单独拆为 UI-DASHBOARD 跟踪。 |
| `F-P1-3` | 全局搜索与命令面板（Ctrl/Cmd+K） | P1 | ✅ done | 1/1 |  |
| `F-P1-4` | 无障碍与键盘可达性 | P1 | ✅ done | 2/2 |  |
| `F-P1-5` | 数据层健壮性（超时 / 重试分流 / 无状态镜像） | P1 | ✅ done | → B7 | B7（api 客户端请求超时与重试分流）已 done：AbortSignal 超时 + 重试分流证据在案（src/lib/api.ts）。本条为 B7 别名，无独立剩余工作，故标记 superseded。 |
| `F-P1-6` | AI 能力：接线或明确下线 | P1 | ✅ done | → O11 | O11（AI 自动标签 / 摘要）已 done：AI 重构拆包（functions/_lib/ai/）+ 模型优先 + 未配置 Key 时静默降级，证据在案。本条为 O11 别名，无独立剩余工作，故标记 superseded。 |
| `F-P2-1` | 性能优化（虚拟滚动 / 分包） | P2 | ✅ done | 2/2 |  |
| `F-P2-2` | FTS5 全文检索 | P2 | ✅ done | 1/1 |  |
| `F-P2-3` | 测试基线 | P2 | ✅ done | 3/3 |  |
| `F-P2-4` | 数据库治理与可演进迁移 | P2 | ✅ done | 2/2 |  |
| `F-P2-5` | 内容型体验（空/错/骨架三件套 + 标签治理） | P2 | ✅ done | 2/2 |  |
| `O1` | CI 质量门禁 | P0 | ✅ done | 1/1 |  |
| `O2` | 自动部署 + PR 预览 | P0 | ✅ done | 1/1 |  |
| `O3` | 安全响应头 | P0 | ✅ done | 1/1 |  |
| `O4` | 注册策略（开放 + 邮箱白名单） | P0 | ✅ done | 2/2 |  |
| `O5` | 应用级 API 密钥管理 | P1 | ✅ done | 2/2 |  |
| `O6` | 书签拖拽手动排序 | P1 | ✅ done | 1/1 |  |
| `O7` | 公开分享（含 KV 边缘缓存） | P1 | ✅ done | 3/3 |  |
| `O8` | 字段级加密 | P1 | ✅ done | 1/1 |  |
| `O9` | 登录限流 / 防爆破 | P1 | ✅ done | 2/2 |  |
| `O10` | 浏览器扩展（MV3） | P2 | ✅ done | 5/5 | 完成后同时补齐 O12 的『一键收纳当前窗口』。 |
| `O11` | AI 自动标签 / 摘要 | P1 | ✅ done | 2/2 | 未配置 provider key 时静默降级为 no-op，不阻塞保存主流程。 |
| `O12` | 标签页组管理 | P2 | ✅ done | 3/3 | 手动整理已交付；整窗收纳随 O10/B5 到位。 |
| `Q1` | 新功能自动化测试补齐 | P0 | ✅ done | 3/3 |  |
| `Q2` | 文档刷新（README 口径对齐） | P0 | ✅ done | 2/2 |  |
| `Q3` | 生产验证数据清理 | P0 | ✅ done | 人工核验 | 生产 D1 中 users/bookmarks/shares/api_keys/sessions 计数已复核为 0。 |
| `Q6` | 可观测性基线 | P1 | ✅ done | 3/3 |  |
| `Q7` | wrangler 升级至 v4 | P1 | ✅ done | 1/1 |  |
| `Q8a` | 书签访问统计 | P2 | ✅ done | 2/2 |  |
| `Q8b` | 标签颜色 | P2 | ✅ done | 1/1 |  |
| `Q8c` | 深色模式 | P2 | ✅ done | 1/1 |  |
| `Q8d` | 封面图展示 | P3 | ✅ done | 1/1 | grid 视图渲染 coverUrl 封面（16:9，懒加载，失败静默回退 favicon）；list/compact 保持紧凑不渲染。 |
| `Q8e` | PWA 离线 | P2 | ✅ done | 3/3 |  |
| `Q8f` | 导入进度可视化 | P2 | ✅ done | 3/3 |  |
| `R1` | 文档漂移治理 | P0 | ✅ done | 3/3 | 已建立 docs/BACKLOG.md + backlog-check CI 门禁；README 失实描述已由 DOC-README-AI 纠正。 |
| `R2` | 测试覆盖缺口 | P0 | ✅ done | 1/1 |  |
| `R5` | 凭证卫生：吊销已泄露 PAT | P0 | ⏸ blocked-external | 人工核验 | 需用户在 GitHub 手动吊销 ghp_OrnyH… 与 ghp_y2Uw…；Agent 无法代为吊销。 |
| `DOC-README-AI` | 纠正 README 中 AI 已接线的失实描述 | P0 | ✅ done | 1/1 |  |
| `B7` | api 客户端请求超时与重试分流 | P1 | ✅ done | 2/2 |  |
| `UI-DASHBOARD` | 概览页 /dashboard | P3 | ✅ done | 3/3 | 登录落地首页：核心指标（书签/近7天/标签/收藏）+ 维护（未打标/归档/回收站）+ 快捷入口；数据源自 /stats。 |
| `CI-CD` | CI/CD 自动化部署流水线 | P2 | ✅ done | 4/4 | push main → CI→Deploy 自动把 dist 部署到 Cloudflare Pages 生产；PR 走 pr-<n> 预览；prod push 顺带逐文件幂等 D1 迁移（非阻塞）；手动 workflow_dispatch 带迁移开关；已实测 success。回滚见 docs/CICD.md §7。 |
| `PRIV-1` | 私密保险库：单书签零知识加密（隐藏不加密之外的强保密） | P1 | ✅ done | 5/5 | 服务端只存 AES-256-GCM 密文 + 公开 salt，从所有列表/搜索/分享/导出/AI 隐藏；实现见 docs/PRIVATE-VAULT.md §1-§7。 |
| `PRIV-2` | 类别私密：标签级整体隐藏（实时级联子树，取消即恢复） | P1 | ✅ done | 6/6 | tags.is_private 标记 + PRIVATE_BOOKMARK_CLAUSE 的 NOT EXISTS 派生隐藏；setTagPrivate 用递归 CTE 级联整棵子树；GET /api/private/tags 供本人查看/取消。仅隐藏不加密（与 §零知识并存独立）。实现见 docs/PRIVATE-VAULT.md §8。 |
| `B-1` | 前端组件测试基建（Vitest + Testing Library 组件回归网） | P1 | ✅ done | 2/2 |  |
| `B-2` | 统一远程图片加载（RemoteImage 组件：错误/封面统一兜底） | P2 | ✅ done | 1/1 |  |
| `B-3` | SettingsPage 拆分为按区子组件 | P2 | ✅ done | 1/1 |  |
| `B-4` | 主题令牌一致性 CI 守卫（SPA 与扩展双份调色板） | P2 | ✅ done | 1/1 |  |
| `B-8` | 智能集合（保存搜索实时成集） | P1 | ✅ done | 3/3 |  |
| `B-9` | 相似书签推荐（多信号启发式 + 相关书签面板） | P2 | ✅ done | 3/3 |  |
| `B-10` | 嵌套标签（父级选择 + 子树过滤，扁平兼容） | P2 | ✅ done | 3/3 |  |
| `B-11` | RSS 订阅与自动拉取收藏 | P1 | ✅ done | 3/3 |  |
| `B-12` | 浏览器书签双向同步（变更日志 + 冲突双保留，Phase A+Phase B） | P0 | ✅ done | 5/5 |  |
| `CS-P1-1` | 迁移 0024：单一主分类表 + 建议队列 kind 列 | P1 | ✅ done | 3/3 |  |
| `CS-P1-2` | 分类提示词与解析器（C1-1 单一主分类输出 / C1-2 基于内容分类） | P1 | ✅ done | 3/3 |  |
| `CS-P1-3` | engine 分类模式（C1-4 批处理 / C1-5 置信度分流 / C1-7 未分类统计） | P1 | ✅ done | 2/2 |  |
| `CS-P1-4` | 主分类持久化与分类树（C1-3 树约束 / 分类建议落库 / 路径推导） | P1 | ✅ done | 2/2 |  |
| `CS-P1-5` | /api/category/* 端点 + jobs kind 分流（tree/assign + categorize 任务） | P1 | ✅ done | 4/4 |  |
| `CS-P1-6` | 前端分类视图与审阅（C2-1 主分类唯一归属 / C2-2 分类审阅 / C2-5 未分类入口） | P1 | ✅ done | 2/2 |  |
| `CS-P2-1` | 扩展 writeback 拉取 + 纯函数树规划器（C3-1 建树 / C3-2 预览 / C3-5 增量 diff） | P1 | ✅ done | 4/4 |  |
| `CS-P2-2` | 回写编排层：逐操作备份 / 分批≤50 执行 / 一键撤销（C3-3/C3-4/C3-6；P6-A 以逐操作备份替代整树快照，保障提升模式安全） | P1 | ✅ done | 2/2 |  |
| `CS-P2-3` | 消息协议：category-preview / category-build / category-rollback + 分批进度广播 | P1 | ✅ done | 2/2 |  |
| `CS-P2-4` | 构建分类书签栏页面（预览→确认→进度→撤销）+ popup 入口 | P1 | ✅ done | 2/2 |  |
| `CS-P2-5` | C3-7 托管外零写入回归测试 + P2 质量门槛 | P1 | ✅ done | 1/1 |  |
| `CS-P3-1` | sync-pull 携带 categoryPath（批量推导）+ 分类写入 bump updated_at | P1 | ✅ done | 2/2 |  |
| `CS-P3-2` | sync-push 接受 categoryPath（解析/创建/落库/反馈/容错） | P1 | ✅ done | 2/2 |  |
| `CS-P3-3` | flatten 保留托管文件夹内路径（folderPath） | P1 | ✅ done | 2/2 |  |
| `CS-P3-4` | planSync 分类维度（快照/上行/移动/冲突三路合并） | P1 | ✅ done | 2/2 |  |
| `CS-P3-5` | runSync 分类放置 + applyingRemote 回环抑制 + 同步页分类统计 | P1 | ✅ done | 2/2 |  |
| `CS-P3-6` | P3 质量门槛（全量测试 + 构建） | P1 | ✅ done | 1/1 |  |
| `CS-P4-1` | 定时自动同步（alarms + 方向跟随上次选择 + 设置开关） | P1 | ✅ done | 3/3 |  |
| `CS-P4-2` | 同步状态可见（stats 分类计数 + popup 覆盖率/最近同步/待上行） | P1 | ✅ done | 3/3 |  |
| `CS-P4-3` | 首次配对向导（options 三步引导：配置→测试→从云端建树） | P1 | ✅ done | 2/2 |  |
| `CS-P5-1` | 新书签自动分类（enrichBookmark 挂 categorize，高置信度自动落库） | P1 | ✅ done | 2/2 |  |
| `CS-P5-2` | categorize 轨道补齐 rebalanceWarning（新分类节点 ≥30% 提醒） | P1 | ✅ done | 1/1 |  |
| `CS-P5-3` | 拖拽重分类（CategoryView 拖到分类节点改主分类 + 反馈） | P1 | ➖ superseded | 1/1 | 拖拽重分类随 32fd85d（分类视图改造为网站导航风格）被有意移除：CategoryView 改为 NavigationTile 直达方块，不再承载改分类交互。useAssignCategory hook 与 /api/category/assign 端点保留（数据层完好），如未来需要手动归类可在批量操作中恢复。 |
| `CS-P45-Q` | P4/P5 质量门槛（全量测试 + 构建） | P1 | ✅ done | 2/2 |  |
| `CS-P6-A1` | 提升为整个书签栏：新增 promoteToBar 总开关（默认关，保留 TagNest 子文件夹为默认） | P2 | ✅ done | 1/1 |  |
| `CS-P6-A2` | 提升模式管理根感知：reconcile 以书签栏根为管理根，逐操作备份 + 外科式回滚（绝不 removeTree 整栏） | P2 | ✅ done | 2/2 |  |
| `CS-P6-A3` | 同步 folderPath 归因经 ownedFolderIds 限制（C4-2 安全：提升模式下不把用户整栏书签误当分类上行） | P2 | ✅ done | 1/1 |  |
| `CS-P6-A4` | 提升模式 UI：options 开关 + category 目标位置提示 + popup 模式徽标 | P2 | ✅ done | 2/2 |  |
| `CS-P6-A5` | 提升模式单测：构建/回滚外科安全 + flatten 限制 + preview mode 字段 | P2 | ✅ done | 1/1 |  |
| `CS-P6-A6` | P6-A 质量门槛全绿（规划器 promote 断言 + 全量后端/前端/构建） | P2 | ✅ done | 1/1 | 后端 990 测试全绿、前端 106 全绿、typecheck 通过、vite build 成功；lint 仅 src/pages 有 32 条与 P6 无关的预存告警。 原 file:dist/index.html 探针移除：dist/ 不入库，CI 干净环境必然失败；构建由 CI 的 build 步骤与本地门禁另行保障。 |
| `CS-P6-B1` | Firefox 支持：manifest 增加 browser_specific_settings.gecko.id，移除无效 default_locale:null | P2 | ✅ done | 2/2 |  |
| `CS-P6-B2` | 跨浏览器 API 兼容核对：仅引用 FF MV3 支持的 chrome.* 命名空间，无需 browser/chrome shim | P2 | ✅ done | 1/1 |  |
| `CS-P6-B3` | manifest 校验测试（门禁）：无 default_locale:null / 含 gecko.id / background module / 仅 FF 支持权限 | P2 | ✅ done | 1/1 |  |
| `CS-P6-B4` | 打包双浏览器产物：Firefox .xpi + Chrome .zip（manifest 按 1cda106 拆分为双文件） | P2 | ✅ done | 4/4 | 原双声明方案在 1cda106 被拆分为 extension/manifest.json（Chrome, service_worker+type:module）与 extension/manifest.firefox.json（scripts+gecko.id）：Chrome MV3 拒绝 background 同时含 service_worker 与 scripts（错误 1227774043）。dist-ext 产物不入库，由 extension 构建脚本按需产出。 |
| `CS-P6-B5` | innerHTML 安全化：共享 dom.js（el/clear/escapeHtml）+ 消除全部 UNSAFE_VAR_ASSIGNMENT + DOM 安全护栏测试 | P2 | ✅ done | 6/6 |  |
| `AI-PERF-1` | AI整理超时治理：分区单次批量调用 + 22s墙钟护栏（方案A） | P0 | ✅ done | 3/3 |  |
| `AI-ORG-1` | 站点命名单一真源 shared/siteLabel.ts（canonicalSiteLabel） | P1 | ✅ done | 3/3 |  |
| `AI-ORG-2` | engine.ts 跨分片 L2/L3 去重：写回处归并到 canonicalSiteLabel | P1 | ✅ done | 2/2 |  |
| `AI-ORG-3` | 导出格式修正：PERSONAL_TOOLBAR_FOLDER/品牌标题兜底/确定性排序 | P1 | ✅ done | 3/3 |  |
| `AI-ADULT-1` | 成人内容隔离 + 模型韧性：确定性隔离归档、提示词安全框架、空响应原文透出 | P0 | ✅ done | 9/9 |  |

**当前执行队列**：空 —— 所有需求已进入终态。

<!-- END:BACKLOG-TABLE -->

---

## 六、来源映射

| 前缀 | 来源 | 说明 |
| --- | --- | --- |
| `F-*` | `docs/03-TagNest优化清单.md` | 净室重写前针对 tmarks 的 19 项优化；多数在 TagNest 中于设计阶段内化 |
| `O*` | `docs/PM-REVIEW-2026-08-01.md` 第二节 | 原始 12 项产品能力 |
| `Q*` | `docs/PM-REVIEW-2026-08-01.md` 第五节 | 质量/安全/体验优化需求 |
| `R*` | `docs/PM-REVIEW-2026-08-01.md` 第四节 | 风险项 |
| `B*` | 本台账建立时的全量审计 | 前述文档未覆盖、但代码审计中新发现的缺口 |
