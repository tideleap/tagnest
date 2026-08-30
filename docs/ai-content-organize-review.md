# TagNest · AI 内容整理（结构化整理）逻辑结构专项评审与优化方案

> 评审人：架构师 高见远（software-architect）
> 评审对象：commit `1d5b3e2`（结构化整理：两级目录 + 会话包裹层 + 标题规范化）、`85c3d03`（并行分片 + 关闭抓正文）
> 性质：**只读分析 + 优化方案设计**，未修改任何源码。
> 仓库：`/c/Users/Admin/WorkBuddy/2026-08-01-13-49-57/tagnest`

---

## 0. 结论摘要（给 team-lead 先看）

1. **三处"层级事实"互相打架**（P0 决策点）：团队描述 = **2 级**（L1 领域 › L2 网站/产品）；当前代码 = **≤3 级**（prompt 说"两级为主"、允许三级、`MAX_CATEGORY_DEPTH=3`）；桌面参考模板 = **固定 3 级**（领域 › 子类别 › 站点，且 L1 顺序非字母、非数量降序）。三者必须统一拍板，否则 prompt、排序、导出永远对不齐。
2. **跨分片目录树会产生重复/重叠分支**（P0）：`categorizeBookmarks` 全程复用**初始** `vocab`，分片之间**不回读**新创建的节点；同一站点在不同分片/不同 URL 上也会被模型赋予**不同的 L2 名**，目前没有任何"同站点 ⇒ 同一 L2"的硬约束。这正是你点名的"跨分片一致性"风险，确实存在。
3. **标题兜底格式与参考模板不一致**（P1）：参考模板是 `首页 | 高德控制台`（**友好品牌名**），而导出 `normalizeBookmarkTitle` 产出 `首页 | amap`（**小写注册域名**）。根因是导出自己写了个 `hostLabelOf`，**没复用**代码里已有的友好品牌解析器 `KNOWN_BRANDS`/`brandFromHost`（`domain-fallback.ts`）。
4. **分类 prompt 自身矛盾**（P1）：目录名长度规则同时写了"≤12 字"（prompt.ts:672）和"≤24 字"（prompt.ts:674）；示例 `React 官网`（prompt.ts:591）与"去掉官网/网站/首页后缀"规则（prompt.ts:672）自相矛盾 → L2 命名风格不可控。
5. **导出排序规则与参考模板不吻合**（P1）：代码用 `localeCompare('zh')` 字母序；参考模板的 L1 顺序是模型输出顺序（且本身不自洽：学习与资讯 17 个排在运营与数据 11 个之后），既不字母也不严格数量降序 → 需要定义**确定性、利于检索**的排序规则。

---

## 1. 现状梳理

### 1.1 数据流（AI 整理端到端）

```mermaid
flowchart TD
  A[书签输入<br/>title / url / description] --> B1[categorizeBookmarks<br/>单一归属 path[]]
  A --> B2[renameBookmarks<br/>清理标题]
  A --> B3[suggestForBookmarks<br/>标签云 + taxonomy]

  B1 --> C1[normalizePlacement<br/>resolveTagName vs vocab<br/>Lift / 父子一致性 / 深度≤3]
  B2 --> C2[renameByFeedback + 解析<br/>only 差异标题]
  B3 --> C3[resolveCandidates + 打分<br/>mergeTaxonomy 可选]

  C1 --> D[(tags 分类树<br/>parent_id 链<br/>+ bookmark_primary_category)]
  C2 --> D
  C3 --> D

  D --> E[deriveCategoryPath<br/>parent_id 上溯 → categoryPath[]]
  E --> F[ExportRow<br/>{bookmarkId,url,title,categoryPath,createdAt}]
  F --> G[toNetscapeBookmarksHtml<br/>书签栏 › ✨AI整理 › L1›L2›L3 › 书签]
  G --> H([标准书签 HTML 文件])
```

**关键点**：`categoryPath` 不是存出来的，而是每次从 `tags.parent_id` 上溯推导（`store.ts:1318-1345`、`deriveCategoryPaths`/`loadCategoryWritebackPage`），所以"目录树"的正确性完全取决于 `tags` 树本身有没有重复/重叠节点——而这正是跨分片风险所在。

### 1.2 目录层级结构（三视角对照）

| 层 | 团队描述（诉求） | 当前代码实际 | 桌面参考模板 |
|---|---|---|---|
| 包裹层 | 书签栏 | 书签栏 | 书签栏（`PERSONAL_TOOLBAR_FOLDER="true"`） |
| 会话层 | 会话层 | `✨ AI 整理 <时间戳>` | `✨ AI 整理 2026/8/23 13:35:35` |
| L1 | 领域 | 领域（模型自由命名，≤3 级） | 开发与运维（62） |
| L2 | 具体网站/产品 | 具体网站/产品（模型自由） | 开发工具（子类别） |
| L3 | （无） | 可选子模块 | API接口 / 云服务器（具体站点） |
| 叶子 | 书签 | 书签 | 书签（`首页 \| 高德控制台`） |

**参考模板实测 L1 顺序与数量**（非字母、非严格数量降序）：

```text
1. 开发与运维    62
2. AI与效率      24
3. 设计与素材    22
4. 娱乐与媒体    21
5. 运营与数据    11
6. 学习与资讯    17   ← 比上一项多，却排在后（说明不是数量序）
7. UU跑腿业务     8
8. 其他          8
```

结论：**参考模板的顺序是"模型输出顺序"，本身不确定也不自洽**；因此不应"盲目对齐参考模板"，而应定义一条确定性排序规则，并以该规则**重新生成参考模板**作为唯一标杆。

---

## 2. 问题清单（5 维度 · file:line · 严重度）

### 2.1 信息分类与归纳规则（categorize / rename / tagging）

| # | 严重度 | 位置 | 问题 |
|---|---|---|---|
| C1 | **P1** | `functions/_lib/ai/prompt.ts:672` vs `:674` | 目录名长度规则自相矛盾：先说"名称 ≤ 12 字"，后说"分类名 ≤ 24 字"；而代码 `makeParsedCategory`（:571）与 `parseCategoryRow`（:758）一律按 `MAX_TAG_LENGTH=24` 截断 → 模型实际学到"24 字也行"，与"≤12"意图背离。 |
| C2 | **P1** | `prompt.ts:672` 规则 vs `:586-594` 示例 | 规则要求"去掉「官网」「网站」「首页」这类无信息后缀"，但示例 `category:'开发技术', subcategory:'前端开发', subsubcategory:'React'` 之外，另有示例把 `React 官网` 当作**好例子**（DEFAULT_CATEGORIZE_EXAMPLES）。规则与示例冲突 → L2 命名风格不可控。 |
| C3 | **P1** | `prompt.ts:670`、`MAX_CATEGORY_DEPTH=3`（:558） | 深度策略含糊：口头"两级为主"，但允许三级、代码上限 3 级，且**没有可执行的"何时才加 L3"判定条件**（"明显不同的子模块"过于主观）→ 模型产出深度浮动，导出结构不稳定。 |
| C4 | **P2** | `prompt.ts:670` L2 定义 | L2 被同时定义为"具体网站/产品/主题"，与 rename track 的"品牌词"概念、以及示例 `React 官网` 混用，缺少"L2 = 稳定站点名"的单一定义。 |
| C5 | **P2** | `engine.ts` `synthesizeTaxonomy`（:398-421）仅作用于 tagging | 标签树有 P0-1 合成层级，但 categorize 的 L1/L2 树没有任何"补父 / 归并"后置处理，父子结构纯靠模型当次输出。 |

### 2.2 冗余与重复项（去重 / 归并）

| # | 严重度 | 位置 | 问题 |
|---|---|---|---|
| D1 | **P0** | `engine.ts:911-937` 循环 + `:973` `normalizePlacement(working, vocab)`；`vocab` 来自 `options.vocab`（:868）全程未回读 | **跨分片目录树发散**：分片 1 新建 L1"开发技术"，分片 2 复用的是**初始** vocab（不含"开发技术"），若模型输出"开发"则再建一个 L1"开发"。两个重叠 L1 分支同时落库。这是你点名的风险，确认存在。 |
| D2 | **P0** | `engine.ts` `categorizeGroup`/`normalizePlacement` 无 host→L2 约束；`categoryCache` 按 URL 缓存（`ai:cat:`） | **同一站点跨分片/跨 URL 不保证同一 L2**：`console.amap.com/dev` 与 `console.amap.com/map` 各自独立分类，可能得到"高德控制台"与"高德地图开放平台"两个 L2，同挂一个 L1 下 → 碎片化、"同一网站永远落同一 L2"不成立。 |
| D3 | **P2** | `engine.ts:586` `UNCATEGORIZED_NAME='未分类'`；`category-export.ts:178-186` 显式未分类桶 | **语义碰撞**：无 host 的书签走兜底 `path:['未分类']`（走"已分类"桶），而 `categoryPath===null` 走"显式未分类"桶；两者在导出时因 `seenFolders` 去重被合并到同一个 `未分类` 头下，含义模糊（且若分类树里恰有名为"未分类"的真实节点会更乱）。 |
| D4 | **P2** | `category-export.ts:148-169` | 仅为深层孙节点存在时，会**冒出空的中间文件夹**（例：`[A,B,C]` 只 C 下有书签，也会渲染空 A、空 B）→ 视觉噪声。 |
| OK | — | `category-export.ts:153,278` `seenFolders` | 渲染层对同一 `path` 仅发射一次 `<H3>`，**不会重复文件夹头**；书签按 `bookmarkId` 幂等。这一点是健康的。 |

### 2.3 术语与表述风格统一

| # | 严重度 | 位置 | 问题 |
|---|---|---|---|
| T1 | **P1** | `category-export.ts:236-263` `normalizeBookmarkTitle` / `:210-219` `hostLabelOf` | 标题兜底格式与参考模板不符：代码产出 `首页 \| amap`（小写注册域名），参考模板是 `首页 \| 高德控制台`（友好品牌名）。代码**未复用**已有的 `KNOWN_BRANDS`/`brandFromHost`（`domain-fallback.ts:13-95`），自己写了个弱化的 `hostLabelOf`。 |
| T2 | **P1** | rename `prompt.ts:862-863`（github.com→GitHub） vs 导出 `hostLabelOf`（github.com→"github"） | "品牌名"有两套定义：rename 用**友好品牌（GitHub，首字母大写）**，导出用**小写注册域名（github）**。同一站点两种叫法。 |
| T3 | **P2** | `category-export.ts:221-223` `GENERIC_TITLES` vs rename 规则的"无信息标题"判定 | "首页/主页/home/Home/index"等通用词在导出与 rename 两处各判各的，口径未统一。 |
| T4 | **P1** | L1/L2 命名（prompt.ts:670） | 没有统一的"命名规范化函数"：模型自由文本 → 大小写/缩写/中英文混用不一（开发技术 vs 开发 vs Dev），`resolveTagName` 只做"已有节点复用"，不约束新建节点的风格。 |
| OK | — | `AI_SESSION_PREFIX='✨ AI 整理 '`（`category-export.ts:36`） | 会话层前缀一致，健康。 |

### 2.4 层级顺序与可读性 / 检索效率

| # | 严重度 | 位置 | 问题 |
|---|---|---|---|
| S1 | **P1** | `category-export.ts:164` `allPaths.sort((a,b)=>a.localeCompare(b,'zh'))` | 排序用 `localeCompare('zh')`（按 Unicode/部首整理序，**不是拼音**），既不是用户直觉也不是参考模板顺序 → 检索性差且不可解释。 |
| S2 | **P1** | 参考模板 L1 实测顺序（见 1.2） | 参考模板顺序**非字母、非数量降序**（学习与资讯 17 在 运营与数据 11 之后）→ 是模型输出顺序，不确定。当前导出若"对齐参考"会继承这种不确定性。 |
| S3 | **P2** | `category-export.ts:171-175` | 文件夹内书签按**输入顺序**排放，未排序 → 同文件夹内检索困难。 |
| S4 | **P2** | 导出整体 | 无目录索引 / 分隔 / 计数标注（如"— N 个 —"），大量书签时导航成本高。 |

### 2.5 输出格式合规（对照参考模板）

| # | 严重度 | 位置 | 问题 |
|---|---|---|---|
| F1 | **P0/P1** | 深度政策（C3 / 1.2 表） | 层级深度三方不一致：团队说 2 级、代码 ≤3 级、参考 3 级。需拍板。 |
| F2 | **P1** | `category-export.ts:119-122` | 参考模板在 `书签栏` 上带 `PERSONAL_TOOLBAR_FOLDER="true"`（ref 第 9 行），代码**未输出**该属性 → 部分导入器可能不把它识别为书签栏。 |
| F3 | **P1** | 标题兜底（T1） | `首页 \| 高德控制台` 形态代码无法复现。 |
| F4 | **P1** | L1 排序（S1/S2） | L1 顺序代码无法复现参考模板。 |
| F5 | **P2** | `category-export.ts:188-193` | `<DL>` 故意不闭合（对齐历史/参考形态）。能导入，但脆弱，建议加注释并补测试锁定。 |

---

## 3. 优化方案（逐问题可落地）

### 3.1 分类归纳规则显式化（修复 C1–C3）

**a) 长度规则二选一并落到代码**（消除 C1）：
- 建议：文件夹名**软上限 12 字、硬上限 24 字**。prompt 明确写"建议 ≤12 字；超过 24 字将被截断"，`MAX_TAG_LENGTH` 维持 24 作硬截断。
- prompt 改写片段：

```text
- 文件夹命名：中文为主（专有名词保留原文 React/Python）；建议 ≤ 12 字，
  最长不超过 24 字（超出将被自动截断）；去掉「官网/网站/首页」等无信息后缀；
  优先复用已有节点，不为同一主题建多个近义文件夹。
```

**b) 删除与规则矛盾的示例（修复 C2）**：把 `React 官网` 示例改为 `React`（或 `React 官网`→改规则允许"官网"当产品固定名时保留，二选一，不要同时出现）。建议示例统一为「品牌/产品名」：`高德开放平台`、`React`、`阿里云 OSS`。

**c) 给出可执行的 L3 触发条件（修复 C3）**：

```text
- 默认两级：[领域, 具体网站/产品]。
- 仅当满足全部条件才加第三级：
  (1) 同一 L2 下确实出现≥2 个明显不同的子模块；
  (2) 该子模块自身会被≥2 个书签复用；
  (3) 子模块名具体可辨（如 "React › Router"、"阿里云 OSS › 控制台"）。
  否则不要为凑层级硬造中间层。
```

**d) 限制 L1 自由度（减少重叠）**：当 `vocab` 已有 L1 时，prompt 明确"L1 必须从下列已有领域中选，除非都不合适才新建，且新建 L1 须是宽泛、长期可复用的领域"。把现有 L1 列表显式喂给模型（已在 `selectVocabularyHierarchical` 中，但需强调"优先复用"）。

### 3.2 去重与归并策略（修复 D1/D2 — 你最关心的跨分片一致性）

**方案 A（推荐，硬约束）— 站点标签规范化，强制 L2 同源**：
新增 `functions/_lib/ai/site-label.ts`：

```ts
import { KNOWN_BRANDS, brandFromHost } from './domain-fallback'; // 复用已有映射

const OVERRIDES: Record<string, string> = { ...KNOWN_BRANDS }; // 集中维护

/** 同一 URL 永远得到同一个 L2 站点名；跨分片、跨子路径一致。 */
export function canonicalSiteLabel(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (OVERRIDES[host]) return OVERRIDES[host];
    // 子域匹配：console.amap.com → 高德（若登记）
    for (const [k, v] of Object.entries(OVERRIDES)) {
      if (host.endsWith('.' + k) || host === k) return v;
    }
    return brandFromHost(host); // 兜底：注册域名首字母大写
  } catch { return '未命名站点'; }
}
```

在 `engine.ts` `categorizeBookmarks` 写回前，对 `path.length >= 2` 的 placement 做**归并**：

```ts
// 伪代码：分类完成后、写库前
if (normalized.path.length >= 2) {
  const site = canonicalSiteLabel(input.url);
  // 仅当模型给的 L2 与站点标签语义相近（normalizeKey 相等或相似）时，用规范名覆盖
  if (normalizeKey(normalized.path[1]) === normalizeKey(site) || similarity > 0.8) {
    normalized.path[1] = site;
  }
}
```

这样"同站点 ⇒ 同 L2"由**确定性函数**保证，不再依赖模型当次发挥，跨分片天然一致。

**方案 B（软约束，配合 A 更佳）— 运行内 + 运行后归并**：
1. `engine.ts` 在分片循环里维护一个 `inRunNodes: Set<string>`（normalizeKey），新建节点先查它再查 `vocab`，命中则复用而非再建（消除 D1 跨分片发散）。
2. 运行结束后对本次新建/命中的 L1/L2 跑一次 `findDuplicateClusters` 风格的近义归并（复用 `taxonomy.ts` 的 `normalizeKey`+`similarity`），把"开发/开发技术"合并。

> 建议 **A + B 同时做**：A 保证站点级一致性（最高优先级），B 兜底领域级近义。

### 3.3 术语 / 命名规范统一（修复 T1–T4）

- **单一数据源**：导出 `normalizeBookmarkTitle` 改为调用 `canonicalSiteLabel(url)`（3.2 的共享函数）而非私有 `hostLabelOf`，使"首页 | 高德控制台"可被复现，且与 rename、兜底标签三者统一为友好品牌名。
- 统一 `GENERIC_TITLES`：把导出、rename、categorize 的"无信息标题"判定收口到一处常量 + 函数 `isGenericTitle()`。
- 新建节点风格：在 `normalizePlacement` 落库前，对 `isNew` 段的命名做一次 `normalizeKey` 比对，逼近已有节点则直接复用（与 3.2-B 同机制）。

导出标题函数改造示例：

```ts
export function normalizeBookmarkTitle(title: string, url: string): string {
  const raw = (title ?? '').replace(/\s+/g, ' ').trim();
  const lc = raw.toLowerCase();
  if (raw === '' || isGenericTitle(lc)) {
    const brand = canonicalSiteLabel(url);            // 友好品牌，复用全局映射
    return `首页 | ${brand}`;
  }
  const host = safeHost(url);
  if (lc === host || lc === hostLabelOf(url)) return `首页 | ${canonicalSiteLabel(url)}`;
  if (lc.includes(hostLabelOf(url))) return raw;     // 已含站点，不重复
  return raw;
}
```

### 3.4 层级与排序优化（修复 S1–S4）

定义**确定性、利于检索**的排序，写进 `toNetscapeBookmarksHtml`：

```ts
// L1/L2：先按该层下书签数降序，数量相同按拼音升序；文件夹内书签按标题拼音升序
function pinyinCompare(a: string, b: string) { return a.localeCompare(b, 'zh-Hans-CN'); }
const byCountThenPinyin = (x: {name:string; count:number}, y: {name:string; count:number}) =>
  y.count - x.count || pinyinCompare(x.name, y.name);
```

- 当前 `localeCompare('zh')`（S1）改为 `localeCompare(b,'zh-Hans-CN')` 以逼近**拼音序**（更贴近中文用户直觉），且层级用"数量降序 + 拼音兜底"。
- 同文件夹内书签按标题拼音升序（S3）。
- 可选增强（S4）：在每个 L1 头后插一行注释 `<!-- 12 个书签 -->` 或 HTML 注释做目录索引；或在会话层顶部加一个"索引"文件夹指向各 L1。

> 注意：参考模板顺序不自洽，**不要对齐它**，而是以本规则重新生成参考模板作为唯一标杆（见 5-待明确 2）。

### 3.5 输出格式校验（对齐参考，修复 F1–F5）

1. `书签栏` 的 `<H3>` 增加 `PERSONAL_TOOLBAR_FOLDER="true"`（F2）。
2. 以 3.4 规则重算顺序 + 3.3 标题规范后，**重新导出一份参考模板**，替换桌面那份作为验收基线（F3/F4）。
3. 新增**结构校验器** `assertExportShape(html)`：断言 `书签栏 › 会话层 › L* › 书签` 包裹正确、深度 ≤ 配置上限、无重复 `<H3>` 头、每个书签恰出现一次。在单测中作为快照门槛（F5）。
4. 明确深度政策（F1）后再定 `MAX_CATEGORY_DEPTH` 是否降为 2。

---

## 4. 文件改动清单（仅方案，待实施）

| 文件 | 改什么 |
|---|---|
| `functions/_lib/ai/prompt.ts` | C1：统一长度规则措辞；C2：删除/修正 `React 官网` 矛盾示例；C3：补充可执行的 L3 触发条件；强化"L1 必须复用已有领域"约束。 |
| `functions/_lib/ai/domain-fallback.ts` | 抽出/导出 `KNOWN_BRANDS` + `brandFromHost` 供全局复用（T1/T2 统一品牌源）。 |
| `functions/_lib/ai/site-label.ts`（**新增**） | `canonicalSiteLabel(url)`：站点→规范 L2 名的单一数据源（D2/T1）。 |
| `functions/_lib/ai/engine.ts` | D1/D2：分片循环维护 `inRunNodes` 运行内去重 + 写回前用 `canonicalSiteLabel` 归并 L2；T3：统一 `isGenericTitle`。 |
| `functions/_lib/ai/store.ts` | 若采用 B 方案：分片间回读 `tags` 使 `vocab` 包含本运行新建节点；保证 accepted placement 用规范 L2。 |
| `src/lib/category-export.ts` | F2：加 `PERSONAL_TOOLBAR_FOLDER="true"`；S1/S2：改为数量降序+拼音排序；S3：文件夹内书签排序；T1：标题兜底改用 `canonicalSiteLabel`；F5：补结构校验。 |
| `src/lib/category-export.test.ts` | 新增：深度上限、确定性排序、去重无重复头、`PERSONAL_TOOLBAR`、标题兜底友好品牌 等断言。 |
| `tests/categorize-prompt.test.ts` | 同步新 prompt 文案断言（C1/C2/C3）。 |
| `tests/export-format.test.ts`（**新增**） | 参考模板一致性/结构校验快照测试。 |

---

## 5. 待明确事项（需 team-lead / 产品经理拍板）

1. **输出层级**：究竟是 **2 级**（团队描述）还是 **3 级**（参考模板 + 代码支持）？这决定 `MAX_CATEGORY_DEPTH`、prompt 与排序，是最高优先级决策（F1/C3）。
2. **L1 排序规则**：建议 **"数量降序 + 拼音兜底"**（确定性、利于检索）。参考模板自身不自洽，**不应盲目对齐**，请确认是否以新规则重生成参考模板为唯一标杆（S1/S2）。
3. **是否允许 L3**：若允许，触发条件与命名规则是否采用 3.1-c 的三条硬条件？
4. **标题兜底格式**：采用 **`首页 | <友好品牌名>`**（对齐参考 + rename + 兜底标签三者统一），还是维持当前 `首页 | <注册域名>`？需统一数据源（3.3）。
5. **跨分片一致性强度**：是否接受 **方案 A 的硬约束**（强制 L2=规范站点标签，牺牲少量模型自由度换一致性），还是仅做 **方案 B 软约束**（运行内/后近义归并）？建议 A+B。
6. **导出增强**：是否要 `PERSONAL_TOOLBAR_FOLDER="true"` 与目录索引/计数标注（F2/S4）？
