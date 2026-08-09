# 书签三级 ML 分类体系（设计规范）

> 源码：`functions/_lib/ai/taxonomy-ml.ts`、`functions/_lib/ai/classifier.ts`、
> `functions/_lib/ai/classify-apply.ts`、`functions/api/ai/classify.ts`、`shared/types.ts`
> 提交：`af9b00b`（已推送 `origin/main`）

## 1. 目标与设计原则

把书签按 **AI 智能三级分类体系** 自动归类，用机器学习模型替代 `if/string.includes` 规则，
以提升分类的 **精度（precision）** 与 **一致性（consistency）**，并保证 **批量处理时结果稳定可复现**。

- **一级大类 → 二级子类 → 三级具体标签** 三级层级。
- 引擎为 **多项式朴素贝叶斯（Naive Bayes）**，训练于 `taxonomy-ml.ts` 的特征词表。
- 纯 JS 实现，运行于 Cloudflare 边缘，**无需 API Key、可离线、确定性强**（相同输入恒得相同输出）。
- 与外部 LLM 解耦：`classifyBookmark` 的 I/O 契约稳定，未来可用 LLM 替换打分逻辑而不改调用方。

> **与 `grouping.ts` 的关系**：`grouping.ts` 对 *已有标签* 做三级分组；本模块对 *书签内容*
> （title + url + description + tags）做分类。两者正交、互不依赖、可独立演进。

## 2. 三级分类层级结构

- **一级大类（category）**：顶层分组，共 **13** 个。
- **二级子类（subcategory）**：每个大类下的细分，共 **47** 个；每个子类携带一组代表该子类内容的 **特征词（features）**。
- **三级具体标签（suggestedTag）**：**不在体系中预枚举**，而是在分类时推断得出——
  优先取「书签已有、且命中该类的标签」，否则回退为「子类名」。

### 2.1 层级总览（13 个一级大类 / 47 个二级子类）

| 一级大类 | 二级子类 |
| --- | --- |
| 学习资料 | 教程与课程 · 文档参考 · 学术论文 · 求职面试 · 认证考试 |
| 人工智能 | 大模型 · 机器学习 · 计算机视觉 · 自然语言处理 |
| 数据分析 | 数据分析 · 数据可视化 · 分析工具 |
| 运维与云 | DevOps · 容器编排 · 云服务 · 服务器与主机 |
| 营销与运营 | SEO/SEM · 增长黑客 · 社媒运营 |
| 技术社区 | 开源社区 · 开发者论坛 |
| 开发技术 | 前端开发 · 后端开发 · 数据与存储 · 算法 · 安全 · 版本控制 |
| 设计与创意 | 界面与交互 · 视觉与品牌 · 设计工具 · 摄影与图像 |
| 在线工具 | 效率办公 · 浏览器插件 · 实用工具 |
| 博客 | 博客 |
| 阅读与资讯 | 新闻资讯 · RSS订阅 · 阅读 · 财经 |
| 内容 | 视频 · 播客 · 阅读与创作 |
| 娱乐与生活 | 娱乐休闲 · 美食 · 旅行 · 健康 · 生活方式 |

> 特征词（如 `react`、`教程`、`docker`、`nlp` 等，含中英文与缩写）完整定义见
> `taxonomy-ml.ts` 的 `CLASSIFICATION_TAXONOMY`。三级标签是运行时从书签自身的标签/标题恢复，
> 不在此处枚举。

### 2.2 模型训练（从特征词到类）

- 每个二级子类 = 一个训练「文档」，由「该子类的特征词 + 大类名 + 子类名」组成。
- 大类名 / 子类名作为 **锚点（anchor）** 被加重重复（见 `ANCHOR_WEIGHT`）；特征词重复 `FEATURE_WEIGHT` 次。
- Laplace 平滑（α=1）保证未见特征概率有限。
- **IDF 重加权**：稀有、有区分度的特征（如 `react`）权重高；多类共享的通用词（如 `文档`）被压低——
  这是「React 文档」能正确归入「开发技术 › 前端开发」而非「学习资料 › 文档参考」的关键。

## 3. 分类输入输出格式（I/O 契约）

### 3.1 输入 `BookmarkClassInput`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string` | 书签唯一 ID（必填） |
| `title` | `string` | 标题 |
| `url` | `string` | URL（域名 token 亦参与特征提取） |
| `description` | `string \| null` | 描述（可选） |
| `tags` | `string[]` | 已有标签名（**三级标签的强信号**） |

### 3.2 输出 `BookmarkClassPrediction`（每条书签一个）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `bookmarkId` | `string` | 回应用户 ID |
| `category` | `string \| null` | 一级大类；低于阈值或隔离时为 `null` |
| `subcategory` | `string \| null` | 二级子类；低于阈值或隔离时为 `null` |
| `suggestedTag` | `string \| null` | 三级具体标签（已有命中标签 或 子类名） |
| `confidence` | `number` | 校准概率，∈ [0,1] |
| `engine` | `'model' \| 'none'` | 始终为 `model` |
| `needsReview` | `boolean` | `true` 表示置信度低于阈值 / 无信号 / 被隔离，需人工确认 |
| `quarantined` | `boolean` | `true` 表示命中内容安全词表，**绝不归入任何分类** |
| `quarantineReason` | `string?` | 隔离原因（仅隔离时存在） |
| `reason` | `string` | 给审核队列的简短可读说明 |

### 3.3 批量输出 `BatchClassifyResult`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `total` | `number` | 处理总数 |
| `classified` | `number` | 自动归类数（已写入类目、非待复核、非隔离） |
| `needsReview` | `number` | 待人工确认数 |
| `quarantined` | `number` | 内容安全隔离数 |
| `avgConfidence` | `number` | 自动归类项的平均置信度 |
| `confidenceHistogram` | `{band,count}[]` | 置信度分箱统计（见 §5.3） |
| `byCategory` | `Record<string,number>` | 各一级大类的自动归类计数 |
| `predictions` | `BookmarkClassPrediction[]` | 逐条预测，**保持输入顺序** |
| `engine` | `'model'` | 固定 |

### 3.4 API 契约类型（`shared/types.ts`）

- `ClassifyScope`：`{ type: 'all' | 'untagged' | 'ids'; ids?: string[] }`
- `ClassifyRequest`：`{ mode?, scope?, confidenceThreshold? }`
- `ClassifyResponse`：`{ mode, scope, confidenceThreshold, summary, byCategory, predictions, linksCreated?, linksRemoved? }`

## 4. 机器学习模型

### 4.1 特征提取 `extractFeatures(text)`
- 拉丁/数字串（词、缩写、域名 token 如 `react`）：正则 `[a-z0-9][...][a-z0-9]`，长度 ≥ 2。
- 中日韩连续段：切分为 **1–3 字 n-gram**（bigram 让「教程」「前端」等双字特征精确命中）。
- 评分阶段仅取 **长度 ≥ 2** 的特征，避免单字 n-gram（如「字」是「字体」子串）造成误命中。

### 4.2 打分（log 空间，朴素贝叶斯 + IDF）
对每个类：`score = logPrior + Σ ( logLik(f) × idf(f) )`（仅累加书签命中的特征）。

### 4.3 置信度（margin + sigmoid）
不取 softmax 顶部概率（~30 个类时顶部值趋近于 0，永远过不了阈值），而取
**「胜者相对亚军的领先幅度」**：

```
margin   = top.score - second.score
K        = 1 / max(0.05, temperature)
confidence = 1 / (1 + exp(-K × margin))
if matched == 0: confidence *= zeroSignalFactor   // 零信号再压低
confidence = clamp01(confidence)
```

`temperature` 越小 → 概率越「尖锐」、排序越严格。

## 5. 置信度阈值与约束条件

### 5.1 默认参数 `DEFAULT_CLASSIFY_OPTIONS`

| 参数 | 默认值 | 含义 / 约束 |
| --- | --- | --- |
| `confidenceThreshold` | **`0.5`** | 自动归类的置信度下限；低于则 `needsReview`，且 `category/subcategory=null`（绝不写入错误层级） |
| `temperature` | `0.5` | softmax 温度；越小越严格 |
| `zeroSignalFactor` | `0.2` | 零特征命中（完全无信号）时置信度乘子，防止仅凭先验拔高 |
| `minCoverage` | `0.15` | 书签特征在词表中最小覆盖率；低于则置信度线性衰减 |

> ⚠️ **已知不一致**：源码多处注释写成「default 0.6」（如 `classifier.ts` L33/L396、
> `api/ai/classify.ts` L25），但 `DEFAULT_CLASSIFY_OPTIONS.confidenceThreshold` 的实际运行时值为
> **`0.5`**。本表与运行时行为一致，注释待修正。

### 5.2 硬性约束（满足「稳定可靠」）

1. **阈值门控**：`confidence < confidenceThreshold` ⇒ `needsReview=true`，`category/subcategory/suggestedTag` 置空，不写任何层级边。
2. **零信号保护**：书签无任何特征命中 ⇒ `confidence` 再乘 `zeroSignalFactor`，几乎必然落入待复核。
3. **覆盖率保护**：`minCoverage` 以下的弱信号被线性衰减，避免「擦边」归类。
4. **内容安全优先**：命中 `SAFETY_LEXICON` ⇒ `quarantined=true`，**最高优先级、不进入任何分类**。
5. **确定性**：纯函数 `classifyBookmark` + 单次建模范 `classifyBatch` ⇒ 相同输入恒得相同输出，可重放、可复现。

### 5.3 置信度分箱（监控面）
`confidenceHistogram` 分箱：`0.0–0.2 / 0.2–0.4 / 0.4–0.6 / 0.6–0.8 / 0.8–1.0`，
用于批量运行后观察「自动归类 vs 待复核」的分布，判断阈值是否需要调整。

## 6. 批量处理稳定性与确定性

- **`classifyBatch(inputs)`**：模型只构建一次并复用于全部书签 ⇒ 成本随批量大小线性增长，
  **适合上千书签**；预测结果 **保持输入顺序**（可预测、稳定）；返回逐条预测 + 聚合统计。
- **确定性（可复现）**：对同一份未变动的书签库重跑，得到 **完全相同** 的 `predictions` 与聚合值——
  这是「确保批量书签处理时分类结果稳定可靠」的核心保证。
- **幂等（apply）**：`INSERT OR IGNORE` 主键 `(bookmark_id, tag_id)`，重复运行不产生重复链接。
- **可逆（revert）**：因分类确定性，对同 scope 重分类得到相同的 `(category, subcategory)`，
  据此 `DELETE` 恰好是 apply 创建的链接，**无需保存 manifest** 即可回滚。

## 7. 三种模式与 API 契约

### 7.1 模式（`mode`）

| 模式 | 行为 | 副作用 |
| --- | --- | --- |
| `report`（默认） | 对 scope 分类并返回结构结果 | 只读，安全可反复运行 |
| `apply` | 把自动归类的书签链接到其一级/二级标签（缺失标签按需创建、按归一化名复用） | 幂等写（`INSERT OR IGNORE`，按 90 分批） |
| `revert` | 移除 apply 创建的一级/二级层级链接 | 确定性删除（无需 manifest） |

> 三种模式均 **跳过** `quarantined` / `needsReview` / 无类目项，不会把低置信或成人内容写入层级。

### 7.2 端点 `POST /api/ai/classify`

请求体：

```json
{
  "mode": "report | apply | revert",          // 默认 report
  "scope": { "type": "all | untagged | ids", "ids": ["..."] },
  "confidenceThreshold": 0.5                   // 仅此参数经 API 暴露；其余用 DEFAULT
}
```

校验：
- `mode ∈ {report, apply, revert}`；否则 `400 mode 必须是 report | apply | revert`。
- `scope.type ∈ {all, untagged, ids}`；`type=ids` 时 `ids` 必非空，否则 `400`。
- `confidenceThreshold` 须在 [0,1]，否则回退默认值（**`0.5`**）。

响应（`ClassifyResponse`）：`mode / scope / confidenceThreshold / summary / byCategory / predictions`，
外加 `apply` 模式的 `linksCreated`、`revert` 模式的 `linksRemoved`。

```jsonc
// 示例：report 响应（节选）
{
  "mode": "report",
  "scope": { "type": "all" },
  "confidenceThreshold": 0.5,
  "summary": { "total": 1280, "classified": 1102, "needsReview": 165, "quarantined": 13, "avgConfidence": 0.83 },
  "byCategory": { "开发技术": 312, "设计与创意": 128, "...": 0 },
  "predictions": [
    { "bookmarkId": "b1", "category": "开发技术", "subcategory": "前端开发",
      "suggestedTag": "react", "confidence": 0.97, "needsReview": false, "quarantined": false,
      "reason": "命中「开发技术 > 前端开发」（置信度 0.97）" }
  ]
}
```

## 8. 内容安全（隔离而非分类）

`SAFETY_LEXICON`（`taxonomy-ml.ts`）为成人 / NSFW 词表（如 成人、色情、porn、xxx、nsfw、onlyfans …）。
`matchesSafety(text)` 做大小写无关的子串匹配；命中即返回 `quarantined: true`、置信度记为 `1`、
**不归入任何分类**，交由人工复核。该词表可随合规要求增删，不影响分类模型本身。

## 9. 约束条件汇总

| 维度 | 约束 | 目的 |
| --- | --- | --- |
| 阈值 | `confidence < 0.5` ⇒ `needsReview` & 类目置空 | 防错分 |
| 零信号 | `matched == 0` ⇒ `× 0.2` | 防仅凭先验拔高 |
| 覆盖率 | `< 0.15` ⇒ 线性衰减 | 防擦边归类 |
| 确定性 | 纯函数 + 单次建模范 | 批量可复现 |
| 幂等 | `INSERT OR IGNORE` | apply 可重跑 |
| 可逆 | 确定性重分类 + `DELETE` | revert 无需 manifest |
| 安全 | 命中词表 ⇒ 隔离 | 成人内容不进层级 |

## 10. 后续可演进

- 从用户的「采纳 / 忽略」反馈中重新训练模型（特征词表形状不变，仅更新权重）。
- 在 API 暴露 `temperature / zeroSignalFactor / minCoverage`，让调用方按需调参。
- 修正 §5.1 注释中遗留的 `0.6` 与运行时 `0.5` 的不一致。
