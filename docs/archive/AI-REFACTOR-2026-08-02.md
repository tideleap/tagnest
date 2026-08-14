# TagNest AI 标签整理 — 重构说明（2026-08-02）

本文记录把「AI 标签整理」从一处被架空的能力，重构为项目核心能力的全过程：诊断、方案、改动范围、以及每处改动如何提升 **AI 权重** 与 **实用性**。

---

## 0. 一句话结论

重构前 AI 形同虚设：配置页显示「已就绪」，但实际从不调用；即便调用，结果也是无人校验、无法追溯、无 Key 即瘫痪、长批量任务会制造同义标签分裂。重构后，AI 成为**双轨信号融合流水线**的主导方——本地启发式引擎兜底、模型提升质量、两者共识加权——所有产出进入**可量化、可撤销、需人工确认**的建议队列，并在「AI 整理」工作台中支持全库批量处理。

---

## 1. 诊断：原有实现的五个低效/失效环节

| # | 问题 | 根因 | 后果 |
|---|------|------|------|
| 1 | **配置页谎报「AI 已就绪」** | 旧 gate 以独立列 `enabled` 判断，但该列从不写入 `1`——注册时硬编码 `0`，UI 也无开关。 | 用户配置完 provider/模型/Key，看到绿色横幅，却永远得不到任何 AI 结果。 |
| 2 | **AI 贡献不可见、不可撤销** | 模型结果直接 `INSERT` 进 `bookmark_tags`，不区分来源、无置信度、无时间戳。 | 无法知道哪些标签是 AI 打的；出错只能手工清理；无法统计 AI 占比。 |
| 3 | **无 Key 即完全不可用** | 单引擎设计，模型不可用时整条路径返回 null。 | 新用户（绝大多数没有 API Key）第一次点「整理」毫无反应，功能形同摆设。 |
| 4 | **长批量任务制造标签分裂** | 单批次内复用同一份词汇表，但跨 chunk 不刷新，同义词在任务中途被拆成多个新标签。 | 整理 500 条书签后，标签体系比整理前更乱。 |
| 5 | **单引擎无交叉校验** | 只有模型一轨，置信度完全由模型自述，自动应用风险高。 | 自动应用要么全关（安全但无用），要么全开（错误难纠）。 |

诊断依据：此前 `docs/REVIEW-2026-08-02.md` 的 `F-P1-6` 已标注「代码已写入 `ai_summary`，但注释仍写 'nothing sends a request'——进度口径与代码漂移」。本次重构即落地并消除该漂移。

---

## 2. 重构方案与改动范围

### 2.1 数据层（迁移 `migrations/0006_ai_tagging.sql`）

- `bookmark_tags.source`（`'ai'` / `'user'` / `null`）+ `confidence` + `created_at`：**让 AI 贡献可量化、可撤销**。
- 新表 `tag_suggestions`（`status` = `pending`/`accepted`/`rejected`）：**模型/启发式输出落入建议队列而非直接写库**，人工确认才落库。
- `ai_jobs`（快照 scope + 进度）：支撑**可恢复、客户端驱动的分块批量任务**。

### 2.2 AI 核心库（`functions/_lib/ai/`，8 个模块，其中 4 个为纯函数）

| 模块 | 职责 | 纯函数？ |
|------|------|---------|
| `types` | 共享词汇（候选/来源/词汇表） | ✅ |
| `config` | 配置加载 + `isModelReady` 五道 gate（修复死锁） | — |
| `taxonomy` | 归一化、去重、重复簇检测 | ✅ |
| `heuristics` | 本地规则引擎（域名/路径/关键词），无 Key 可用 | ✅ |
| `prompt` | 把任务从「生成」变为「对用户已有标签集分类」 | ✅ |
| `providers` | 三家 JSON 信封 + 一次 fetch | — |
| `engine` | **双轨编排**：启发式 + 模型 → 归一化融合 + 共识加权 | — |
| `store` | 任务进度 + 建议队列持久化 | — |

> 四模块纯函数化，正是后端单元测试能在无 DB/无网络/无 Key 下覆盖算法的原因。

### 2.3 API 端点（`functions/api/ai/`）

`settings`（修复死锁）、`jobs`、`jobs/[id]`、`jobs/[id]/run`、`suggest`、`suggestions`、`suggestions/apply`、`taxonomy`、`overview` —— 共 9 个端点，全部类型检查通过。

### 2.4 前端工作台（`/organize`）

- 数据层 `src/hooks/queries/organize.ts`：`useAiOverview` / `useAiSuggestions` / `useAiTaxonomyAudit` / `useDecideSuggestions` / `useSuggestNow` / **`useOrganizeRun`（客户端驱动的分块循环）**。
- 组件：`RunPanel`（范围选择 + 引擎徽标 + 降级提示）、`SuggestionReview`（按书签分组的人机协作确认）、`TaxonomyPanel`（重复簇合并、未用标签清理）。
- `OrganizePage` 三 Tab：整理 / 确认 / 体检，含 **AI 贡献度进度条** 与标签体系导出。
- 导航在 `Sidebar` 新增「AI 整理」；`settings/AiSection` 重写（「模型已就绪」派生状态 + 整理策略开关）。

---

## 3. 每处改动如何提升 AI 权重与实用性

### 3.1 让 AI 真正运行（权重提升）

- **`enabled` 改为派生只读状态**（`config.isModelReady` 与前端 `ai-readiness` 镜像同一逻辑）。`provider + model + apiKey + 任一自动化开关` 齐备即视为就绪——**配置完整即生效，不再有「配好却悄悄关闭」**。修复了诊断 #1 的死锁。
- **`enrichBookmark` 接入保存流程**（`ctx.waitUntil`）：新书签保存即触发 AI，且任何失败被吞掉并记录日志——死模型绝不会拖垮一次保存。

### 3.2 让 AI 更准（质量提升）

- **任务重构为分类而非生成**（`prompt.buildTaggingPrompt`）：把用户已有标签交给模型并要求优先复用，把开放式生成变为受限分类，结果可重复、贴合既有体系（诊断 #5 的部分根因）。
- **双轨融合 + 共识加权**（`engine.suggestForBookmarks` + `taxonomy.resolveCandidates`）：模型与启发式各自产出，归一化后合并；两轨指向同一标签时置信度 +0.1 并标记「多引擎一致」。这意味着**交叉校验让自动应用阈值可信**。
- **四趟归一化**（`taxonomy.resolveTagName`）：精确匹配 → 别名 → 同义词规范 → 模糊匹配，只有全部落空才新建标签。**直接消灭 `前端`/`Frontend`/`前端开发` 分裂**（诊断 #4 的体系污染）。
- **长批量按 chunk 重读词汇表**（`jobs/[id]/run`）：每处理 `RUN_CHUNK=20` 条重新 `loadVocabulary`，避免同义分裂。

### 3.3 让 AI 人人可用（实用性提升）

- **无 Key 兜底**（`LocalConfig` + 双轨降级）：没有 API Key 时本地启发式仍产出可用结果，UI 明确显示「本地规则模式 / 已使用本地规则继续」。新用户开箱即有整理能力（诊断 #3）。
- **建议队列 + 人工确认闭环**：每条建议带 `confidence` 与 `reason`，低置信度虚线边框提示；接受/忽略按书签分组，批量确认。`autoApplyThreshold` 低于 1 时高置信度建议自动应用（用户主动降速后的选择）。**AI 可放权但不失控**（诊断 #5）。
- **全库批量工作台**：客户端循环 `POST /api/ai/jobs/:id/run`，React Query 缓存失效保持队列实时；进度条、引擎徽标、降级提示一应俱全（诊断时的「只能单条试两次就放弃」问题）。
- **可量化贡献**：`overview.aiTagLinks / userTagLinks` 统计 AI 占比，`tag_suggestions.source='ai'` 使任何 AI 操作可被整体撤销。

---

## 4. 测试覆盖（Task 122）

新增 `tests/taxonomy.test.ts`、`tests/heuristics.test.ts`、`tests/ai-config.test.ts`、`tests/engine.test.ts`、`tests/ai-store.test.ts` 及内存 D1 mock `tests/helpers/aiDb.ts`，并修正 `tests/ai.test.ts` 以适配重构后的 API（`buildTaggingPrompt` / `parseTaggingResponse` / `callProvider`）。

覆盖点：

- `config.isModelReady` 五道 gate + `loadConfigRow`/`loadAiConfig`（含遗留明文 Key 兼容）。
- `taxonomy` 归一化、共识加权、重复簇检测。
- `heuristics` 域名/路径/关键词三类规则 + 词边界匹配。
- `engine` 双轨编排：**纯启发式 / 纯模型 / 混合 / 致命错误降级 / 瞬时错误重试 / 空输入 / 畸形响应不抛**。
- `store` 建议写库（刷新而非堆叠、跳过已打标签、拒绝后不再重提）、`decideSuggestions` 接受（写 `source='ai'` + 置信度、新建标签）/ 拒绝、`autoApply` 阈值、`resolveScope` 快照。

全量测试：**29 文件 / 278 用例全部通过**；`tsc -b` 类型检查与 `eslint --max-warnings=0` 均干净。

---

## 5. 关键契约与注意事项

- **错误码**：导入相关错误已按类型区分（`import_empty_parse` / `import_db_unavailable` / `import_unreadable` 等），前端 `src/lib/import-error.ts` 据此分流提示，避免「解析失败」一刀切。
- **安全**：Provider Key 经 AES-256-GCM 加密落库；模型调用超时 45s，一次重试仅限瞬时错误（429/5xx/网络），致命错误（401/403/404）立即终止任务并告知用户原因。
- **不变量**：`enabled` 不再由请求体写入；`tag_suggestions` 中已拒绝的标签不会被同一次/后续整理重新提议；已被书签实际持有的标签不进入建议。

---

## 6. 后续可选项（不在本次范围）

- 将 `enrichBookmark` 接入 `import/commit.ts` 导入流程（当前导入不触发 AI；保存单条已接入）。
- `ai_summary` 在前端列表/详情的展示与编辑 UI。
- 用户级同义词表写入（目前 `taxonomy.SYNONYMS` 为固定种子，用户别名已参与归一化）。
