# 架构设计 · AI 标签质量治理（governTaxonomy）

| 项 | 值 |
|---|---|
| 文档编号 | ARCH-TAG-QUALITY-2026-08-30 |
| 日期 | 2026-08-30 |
| 作者 | 主理人（代架构师高见远，原 Agent 因 429 失败） |
| 状态 | 已定稿，进入实现 |
| 上游 | `docs/PRD-TAG-QUALITY-2026-08-30.md`（阈值以 PRD §4/§8 为准） |

---

## 1. 硬约束（验收红线）

1. **纯算法**：`governTaxonomy` 零模型调用、无随机，同输入同输出（可单测回归）。
2. **性能**：N=1000 时 < 200ms（实现为 O(N·T + T²) 字符串比较，N=1000、T≤100 时 < 5ms）。
3. **不产生 0 标签书签**：任何分配被降级/丢弃后，若书签归零，用 `domainFallbackTag` 兜底。
4. **不动 `tags` 表**：治理只改「本次建议」（内存中的 modelTags），无任何 DB 写路径。
5. **P0 不暴露设置项**：无 schema 迁移、无新 UI 控件；`maxTags` 选项收窄沿用现有字段。

---

## 2. 管线时序（改造后）

```
suggestForBookmarks
├─ cache 读取（不变）
├─ for each batch → coarse? → tagGroup → applyItem   ← 不再在此写缓存（P0-6）
│    （原先 engine.ts:388-395 的 cache.put 移除）
├─ 【新增】if (modelContributed) governed = governTaxonomy(modelTags, vocab, N, inputs, feedback)
├─ modelTags ← governed.tags
├─ synthesizeTaxonomy（治理后跑，输入更干净）
├─ renameByFeedback → resolveCandidates → scoreTagCandidate → slice(0, maxTags)（不变）
└─ 【新增】缓存回填：把治理后的最终标签写回 per-URL 缓存（P0-6）
```

**为什么治理放在缓存写入之前**：治理需要全批次的统计视野（支持度/预算），必须等所有
`tagGroup` 返回后统一执行；若在批内写缓存，未治理的碎片标签会被永久固化，下次同 URL
命中缓存直接绕开治理——这是当前"孤立标签越攒越多"的放大器（P0-6 bug）。

**为什么治理放在 renameByFeedback 之前**：治理在**原始名空间**工作（模型输出的名字），
rename 是用户拼写偏好，属于归一化层，顺序为 治理→rename→resolve，避免治理把 rename
改过的名字又改回去。

---

## 3. 模块设计

### 3.1 新文件 `functions/_lib/ai/governance.ts`

```ts
export const GOVERNANCE_DEFAULTS = {
  distinctCap: 100, distinctFloor: 6, densityK: 3,
  minSupport: 2, newTagRatio: 0.3,
  mergeSimilarity: 0.75,
} as const;

export function distinctBudget(n: number): number
  // min(100, max(6, ceil(n/3)))

export interface GovernResult {
  tags: Map<number, RawCandidate[]>;   // 治理后的 modelTags（可被替换/补兜底）
  quality: GovernanceQuality;          // 度量（P0-0/P1-7 用）
  metrics: { merged: number; rolledUp: number; dropped: number; budget: number };
}

export function governTaxonomy(
  modelTags: Map<number, RawCandidate[]>,
  vocab: Vocabulary,
  inputs: BookmarkInput[],
  feedback: FeedbackProfile | null,
): GovernResult
```

**算法步骤（全确定性）**：

```
1. 统计：对每个候选标签名 s，support[s] = 批次内书签数 + (词表已有 count，仅当 resolveTagName 命中已有标签)
   —— 有效支持度口径（P0-4 误伤防护的核心：词表 count≥2 的标签永远不会被治理掉）
2. 判定：isNewTag(s) = resolveTagName(s, vocab).tagId === null
3. 预算：budget = distinctBudget(N)
4. Top-D 截断：score(s) = min(effectiveSupport,9999) × 2 + Σ confidence
   （词表已有标签 support 上限设 9999，保证它们在预算排序中天然排在新标签前面）
   排序键 (score desc, name asc) —— 纯确定性
5. 新标签准入：保留集中 isNewTag 且 support < minSupport(2) → 剔除，顺延补位
6. 新标签配额：保留集中新标签数 ≤ 30% × budget，超出按 score 升序剔除，顺延补位
7. 三级降级（对落选/被剔除标签的分配）：
   ① 合并：similarity(normalizeKey(s), normalizeKey(t)) ≥ 0.75 的保留集标签 t → 改名并入 t
   ② 上卷：若 s 在词表中有父节点 → 改名为父标签名（若无父则跳过）
   ③ 丢弃：该书签该分配删除；若该书签治理后 0 标签 → domainFallbackTag 补 1 个
8. 0 标签防护：步骤 7 结束后扫描，任何 tags.length===0 的书签补 domainFallbackTag
```

**merge 步骤的实现细节**：
- 对被剔除名 s，在保留集标签中找 `similarity ≥ 0.75` 的最佳 t（排除 s 自身）；
- 命中 → 把 s 的候选替换为 `{...cand, name: t, reason: '与「t」高度相似，已合并'}`；
- 未命中但词表中 s 有父节点 → 上卷：`{...cand, name: parentName, ...}`；
- 都不行 → 删除该候选，书签级 0 标签防护兜底。

**确定性保证**：所有 Map 遍历后都先 `[...].sort((a,b)=>...)` 再处理；相似度比较只依赖
normalizeKey 后的字符串；无 Date.now()、无 Math.random()。

### 3.2 `engine.ts` 修改（最小侵入）

```ts
// 变更 1（P0-6）：删除批内 cache.put（388-395 行），改为收集待写回项
const cacheWrites = new Map<string, TagCacheEntry>(); // key → entry

// 变更 2：批循环结束后、synthesizeTaxonomy 之前：
if (modelContributed) {
  const gov = governTaxonomy(modelTags, vocab, inputs, feedback);
  modelTags = gov.tags;
  lastGovernance = gov;
}
```

**关键取舍：缓存回填的实现方式。**

按 PRD §4.5，缓存写入必须移到治理后。但治理输出的是 `RawCandidate[]`（原始名空间，
含合并/兜底替换），而缓存条目是 `ParsedTag`（模型名空间）。直接把治理后的 RawCandidate
写回缓存有两个问题：① 治理 reason 是中文句子，回填后 reason 会在 review 队列重复拼接；
② 兜底标签 source='fallback' 混入缓存会污染「model 贡献」统计。

**决定：缓存回填策略为「按书签过滤」而非全量回写**：

```ts
// 治理后，对每个"模型实际产出过标签"的书签，从治理后的 modelTags 重建缓存条目，
// 写回该 URL 的缓存。这样下次同 URL 命中缓存时拿到的就是治理后的标签集，
// 而不是被治理删除前的碎片。
```

###  rebuild 的问题——改为「缓存条目 = 治理前的原始模型输出」+ 治理幂等

重新评估后，**全量回写治理后结果**有更深的问题：治理后的标签名可能已经被改名（合并），
下次命中缓存后 rename/resolve 仍然能把它解析到正确已有标签（resolveTagName 的 fuzzy pass
会命中），因此**回写治理后标签集是安全的**。但回写内容采用**最小重构**：从治理后的
RawCandidate 重建 ParsedTag（name/confidence/reason 治理值，isNew = resolveTagName 命中
词表为 false），跳过 source='fallback' 的兜底候选（兜底标签不应该进缓存——它是本次批次
的补救，不是模型对该 URL 的判断）。

**最终决定（简化且正确）**：
- 缓存回填 = 对 pending 中每条 URL，取治理后该索引的 RawCandidate[]（剔除 fallback 源），
  重建 ParsedTag 写回缓存。
- 同时把 `item.needsReview`/topic/summary 原样写入（这些与治理无关，保持原语义）。
- 治理幂等：下次命中缓存，缓存里的标签已是治理后集合，重新治理时因 support 统计基于
  "词表 count + 批次内支持度"，已治理集合重新治理结果不变（治理只删/并，不分裂），**幂等成立**。

### 3.3 P0-5：prompt.ts 硬约束

在 `buildTaggingPrompt` 的词表段后追加固定段落（新增导出常量 `TAG_HARD_RULES`）：

```
【硬性要求】
1. 优先复用已有标签，只有当已有标签会明显误导时才新建标签。
2. 新建标签必须是"预计至少 3 个书签会使用"的概念；只会用一次的标签一律不要新建。
3. 每个书签最多新建 1 个新标签，其余从已有标签中选择。
4. 本次整理总共最多产出约 N/3 个不同标签（N 为本次书签数）。
```

第 4 条的 N 在调用 buildTaggingPrompt 时按批大小无法预知全批次 N，因此**写死为
"本次任务预计最多产出 `ceil(输入规模/3)`"**——tagGroup 收到的 group 是全批次的一个
切片，无法知道全局 N。**决定：tagGroup 的 opts 增加可选 `totalInputs?: number`**，
buildTaggingPrompt 接收 `options.totalCount` 渲染准确数字；未提供时省略第 4 条。

###  totalCount 传递链

`suggestForBookmarks` → `tagGroup(opts.totalInputs = inputs.length)` →
`buildTaggingPrompt(..., { totalCount })`。缓存命中项不受影响（缓存本身已按新 prompt
版本失效重建——cacheKeyFor 折入 prompt version，需要 bump `TAGGING_PROMPT_VERSION`）。

**⚠️ 必须同步 bump prompt version**：cacheKeyFor 折入 prompt version，prompt 变更后旧
缓存不再命中，避免"旧碎片缓存 + 新治理"混跑。这是 P0-5/P0-6 联动项。

### 3.4 maxTags 收窄（P1-4 提前到 P0 顺手做）

- `AiSection.tsx:18` 已是 `[2,3,4,4,5,6]` → 已符合（此前提交已收窄）。确认无需改。
- `config.ts`（若 clampMaxTags 存在则收窄；勘察未发现 clampMaxTags 孔在，跳过）。

### 3.5 单测（`tests/ai-governance.test.ts`）

| 用例 | 断言 |
|---|---|---|
| distinctBudget 边界 | N=10→6、N=168→56、N=300→100、N=1000→100 |
| P0-1 预算截断 | 60 新标签/60 书签 → D ≤ 56 |
| P0-2 minSupport | 5 个书签各 1 个互不相同新标签 → 全剔除；其中 1 个支持度 2 → 保留 |
| P0-3① 合并 | `React Hooks`(1) + `React`(词表20) → 并入 React |
| P0-3② 上卷 | `Vue3 源码`(1) 词表父节点「前端」→ 上卷为「前端」 |
| P0-3③ 丢弃+兜底 | 孤立无近义无父 → 丢弃，书签最终 ≥1 标签 |
| P0-4 误伤防护 | 词表「摄影」count=30，批内仅 1 书签 → 保留 |
| 确定性 | 同输入跑 2 次，JSON.stringify 相等 |
| 性能 | N=1000 全新标签 < 200ms |
| P0-6 先红后绿 | 用 mock cache 断言缓存 tags == 没有治理前模型原始输出→修复后 == 治理后 |

---

## 4. 文件清单

| 文件 | 变更 |
|---|---|
| `functions/_lib/ai/governance.ts` | **新增**：预算/门槛/三级降级/兜底/度量 |
| `functions/_lib/ai/engine.ts` | 接入治理；删批内 cache.put → 治理后回填；传 totalCount |
| `functions/_lib/ai/prompt.ts` | 返加 TAG_HARD_RULES 段 + totalCount 渲染；bump prompt version |
| `functions/_lib/ai/index.ts` | re-export governance |
| `tests/ai-governance.test.ts` | **新增**：上表 10 组用例 |
| `docs/ARCH-TAG-QUALITY-2026-08-30.md` | 本文档 |

## 5. 有序任务列表

1. 写 `governance.ts`（GOVERNANCE_DEFAULTS + distinctBudget + governTaxonomy + quality 统计）
2. 写 `tests/ai-governance.test.ts`（先测 distinctBudget/minSupport/三级降级/误伤防护）
3. 改 `engine.ts`（删批内 cache.put → governTaxonomy 接入 → 治理后缓存回填）
4. 改 `prompt.ts`（硬约束段 + totalCount + bump version）
5. `index.ts` re-export
6. 门禁：tsc -b --force → vitest run → vite build
7. GitHub REST API 直推（沿用 .tmp/gh-push4.mjs 模式）→ 验证 CI/Deploy/health

---

## 6. 实现记录（2026-08-30，实现后回填）

实现过程中对 §3 设计做了三处偏离，均已写入 `governance.ts` 头注释与本文档：

### 6.1 预算只约束新标签，已有词表标签永远保留（偏离 §3.1 步骤 4）

设计稿的 Top-D 截断按 `支持度×2 + Σconf` 全局排序取前 D 个。实现时发现这会把用户
词表里 count=20 的已有标签挤出保留集（当新标签数量超过预算时），直接违反 P0-4
「已有标签不得被治理掉」。改为：**已有标签无条件进保留集；预算余额（budget − 已有数）
才分配给新标签**。N=168 时 budget=56，已有标签 30 个 → 新标签最多 26 个，语义不变
且误伤防护从"特判"变成"结构性保证"。

### 6.2 冷启动（空词表）豁免 30% 新标签配额（偏离 §3.1 步骤 6）

配额的本意是"迫使复用"。词表为空时无物可复用，若仍按 30% 配额，首次整理（恰是
owner 的 168 条场景）会被砍到只剩 16 个新标签、其余全部退化为域名兜底——这正是
"一坨屎"的另一种形态。实现为 `quotaActive = vocab.entries.length > 0`，与 PRD §4.7
"词表复用率冷启动豁免"的精神一致。

### 6.3 合并判定增加前缀包含（偏离 §3.1 步骤 7①）

纯编辑距离对 `React Hooks` → `React` 只得 0.5（< 0.75 阈值），会漏掉最典型的
"子概念并入主概念"场景。`mergeScore` 增加前缀包含判定：短名 ≥3 字符（ASCII）或
≥2 字符（CJK）且是长名前缀时，视为达到合并阈值。

### 6.4 单书签运行豁免治理（engine.ts，设计稿未覆盖）

`inputs.length === 1` 时 minSupport=2 无解，治理必然把唯一标签打掉只剩域名兜底。
单条保存场景按 PRD §7 Q6 走 P2-3「待转正」机制（本次不做），故 engine 在
`inputs.length > 1` 时才调用治理。

### 6.5 缓存回填的跳过策略（偏离 §3.2 决定）

治理后某 URL 的模型标签全被剔除时（只剩兜底），**跳过该 URL 的缓存写入**而非
回退写治理前标签——回退写会把碎片标签重新固化（正是 P0-6 要修的 bug）；跳过则
下次运行重新问模型，是正确行为。兜底标签（source='fallback'）永不入缓存。

### 6.6 兜底标签不计入预算口径

`domainFallbackTag` 是覆盖率硬约束的产物，其数量由 distinct hosts 决定，不受
预算控制。quality 新增 `fallbackNames` 字段，预算断言用
`distinct − fallbackNames` 度量（测试已按此口径）。

### 6.7 存量测试适配

5 个存量引擎测试（补偿/修复/合成路径）原本用 `emptyVocab` + 每书签唯一标签，
治理后这些唯一标签被正确剔除导致断言失败。修法：引入 `vocabWith(...names)`
辅助，把被测标签标记为词表已有标签（P0-4 保证永存），测试意图（补偿/解析/合成
机制）不变。新增 `tests/ai-governance.test.ts` 14 例 + `engine.test.ts` 治理
集成 3 例，共 35 例全绿。

