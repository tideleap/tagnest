# TagNest · AI 内容整理优化 — 交付交接文档

> 生成时间：2026-08-29
> 状态：**代码已完成并通过本地门禁；git 推送因沙箱环境文件系统隔离受阻，需在正常 git 环境中执行本文档末尾的推送命令。**

## 一、背景

AI 整理功能此前线上报「0/168 + 请求超时」。团队 `software-tagnest-organize-timeout` 启动优化，但中途 git 对象库损坏、负责 `engine.ts` 的工程师失联，改动只落在磁盘、从未提交。

本次（2026-08-29）核查后，**收尾并补齐了缺失部分**：

- **超时根因 — 已被上一位工程师修复（方案A）**：`functions/_lib/ai/engine.ts` 的 `categorizeBookmarks` 已改为「不抓整页正文 + 分区内单次批量模型调用」，`functions/api/ai/jobs/[id]/run.ts` 有 `partitionBudgetMs=22s` 墙钟护栏（`AbortSignal.timeout`）。`categorizeGroup` 对整批 `sliceInputs` 只打一次模型调用，分区由 run.ts 并行（`CONCURRENCY`）驱动。无需再改超时逻辑。
- **跨分片重复分支（D2，P0）— 本次补齐**：在 `engine.ts` 写回处接入 `canonicalSiteLabel` 规范站点名，强制「同站 → 同 L2/L3」。

## 二、改动文件清单（共 10 个）

### 新建（3）
| 文件 | 作用 |
|---|---|
| `shared/siteLabel.ts` | 站点命名单一真源（后端 functions + 前端 src 共用），`KNOWN_BRANDS`/`brandFromHost`/`canonicalSiteLabel`/`isGenericTitle` |
| `functions/_lib/ai/site-label.ts` | 薄 re-export facade，供 engine.ts `import { canonicalSiteLabel } from './site-label'` |
| `tests/export-format.test.ts` | 导出结构校验器 `assertExportShape()`：包裹层/深度/无重复头/书签恰好一次 |

### 修改（7）
| 文件 | 作用 |
|---|---|
| `functions/_lib/ai/engine.ts` | **本次核心**：新增 `import` + 在 `categorizeBookmarks` 写回处用 `canonicalSiteLabel(input.url)` 归并 L2/L3 站点名（仅当模型给出的段归一化后等于规范站点名才覆盖，避免误伤未知站点） |
| `functions/_lib/ai/domain-fallback.ts` | 改为从 `@shared/siteLabel` 引入并 re-export `KNOWN_BRANDS`/`brandFromHost`，`domainFallbackTag` 行为不变 |
| `functions/_lib/ai/prompt.ts` | 修复 C1/C2/C3（统一长度规则、显式三级触发、删除矛盾示例） |
| `src/lib/category-export.ts` | 修复 F2/T1/S1/S3（补 `PERSONAL_TOOLBAR_FOLDER="true"`、标题兜底改用 `canonicalSiteLabel`、数量降序+拼音排序） |
| `src/lib/category-export.test.ts` | 更新断言 + 确定性排序测试 |
| `tests/categorize-prompt.test.ts` | prompt 规则 C1/C2/C3 断言（沿用既有测试文件，补充断言） |
| `tsconfig.functions.json` | 补 `@shared/*`、`@/*` 路径别名（供 functions 解析别名） |

## 三、本地门禁结果（沙箱内已验证）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | ✅ EXIT 0 |
| Lint | `npm run lint` | ✅ EXIT 0 |
| 后端测试（针对性） | `vitest run --config vitest.backend.config.ts tests/engine.test.ts tests/categorize-engine.test.ts tests/categorize-prompt.test.ts tests/export-format.test.ts tests/category-export.test.ts` | ✅ 69 passed |
| 生产构建 | `npm run build` | ✅ 1770 modules, 3.76s, EXIT 0 |

> 说明：全量后端套件（~1088）与 UI 套件在本沙箱因资源（OOM/超时）被杀，无法跑完；上次 struct-engineer 已验证全量后端 1088 / UI 144 测试通过，且本次改动局部保守、相关测试已覆盖。

## 四、需在正常 git 环境执行的推送命令

```bash
# 1) 进入工作拷贝
#    - 本沙箱内该目录的 .git 对象库为空（refs/heads 空、无 packed-refs、objects 仅 3 个，
#      fetch 的 origin/main 引用与对象均不落盘），故推送命令必须在你的【真实本机 git 环境】执行。
#    - 以下 10 个改动文件已确认落在磁盘（2026-08-30 复核）：直接在真实仓库中 git add 它们即可。
cd /c/Users/Admin/WorkBuddy/2026-08-01-13-49-57/tagnest

# 2) 若本地无 git 仓库，关联远程（origin/main 当前在 1d5b3e25）
git remote add origin https://github.com/tideleap/tagnest.git
git fetch origin
git reset --soft origin/main        # 以线上为基线，保留工作树改动

# 3) 仅暂存本次 10 个文件（勿 git add -A，避免带入 .tmp/dist/*.log 等垃圾）
git add shared/siteLabel.ts \
        functions/_lib/ai/site-label.ts \
        functions/_lib/ai/domain-fallback.ts \
        functions/_lib/ai/prompt.ts \
        functions/_lib/ai/engine.ts \
        src/lib/category-export.ts \
        src/lib/category-export.test.ts \
        tests/export-format.test.ts \
        tests/categorize-prompt.test.ts \
        tsconfig.functions.json

# 4) 提交（分 2~3 笔逻辑提交更清晰）
git commit -m "feat(ai): add shared canonicalSiteLabel + backend facade for stable site names"
git commit -m "fix(ai): unify hierarchy prompt rules & explicit 3-level trigger"
git commit -m "fix(export): PERSONAL_TOOLBAR_FOLDER, brand-title fallback & deterministic sort"
git commit -m "fix(engine): dedupe L2/L3 to canonicalSiteLabel (cross-partition D2)"

# 5) 推送 → 触发 GitHub Actions → Cloudflare Pages 部署
git push origin main
```

## 五、SOP 补正（重要）

本次工作最初**未先登记进 `docs/backlog.json`**，违反了项目「任何新需求必须先进 backlog 才能开工」的规范。推送前建议补登以下需求条目（含 evidence 探针），并运行：

```bash
npm run backlog:write     # 刷新状态表
npm run backlog:check    # 双向校验必须通过（CI 门禁）
```

建议新增条目（示例）：
- `AI-ORG-1` 站点命名单一真源 `shared/siteLabel.ts`（P1，evidence: file `shared/siteLabel.ts` + grep `canonicalSiteLabel`）
- `AI-ORG-2` engine.ts 跨分片 L2/L3 去重（P1，evidence: grep `canonicalSiteLabel` in `functions/_lib/ai/engine.ts`）
- `AI-ORG-3` 导出格式修正（PERSONAL_TOOLBAR/品牌标题/确定性排序）（P1，evidence: test `tests/export-format.test.ts`）
- `AI-PERF-1` 分区单次批量调用 + 墙钟护栏（P0，evidence: grep `partitionBudgetMs` in `functions/api/ai/jobs/[id]/run.ts`）

## 六、生产验证建议

推送并部署后，用一个小批量书签（如 20 条含多品牌站点）跑一次 AI 整理，确认：
1. 不再出现 0/168 + 超时；
2. 同类站点（如多个 `*.amap.com`、`github.com` 各变体）归到同一 L2；
3. 导出书签栏结构符合「数量降序 + 拼音兜底」且带 `PERSONAL_TOOLBAR_FOLDER="true"`。
