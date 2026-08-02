# TagNest × tmarks 相似性审查与商业化合规报告

- **审查日期:** 2026-08-02
- **审查对象:** `tagnest/`（本项目，MIT） vs `tmarks-origin/tmarks/`（上游，CC BY-NC 4.0）
- **审查方法:** 逐层目录对比、源码全文检索、主题色/字体/图标/资源比对、依赖许可证审计、README/文档措辞对比。
- **结论摘要:** **未发现可构成版权/实质相似的表达。** TagNest 在工程结构、UI 设计系统、注释命名、文档、素材、依赖六方面均为独立实现。已补充合规声明文件、许可证自动化审计门禁。

---

## 一、上游许可现状（关键前提）

上游 `tmarks` 的 `README.md` 自称 **MIT License**，但其仓库根目录的 `LICENSE` 文件实际是 **Creative Commons Attribution-NonCommercial 4.0 (CC BY-NC 4.0)**。

> **重要提示：上游内部自相矛盾**（README 说 MIT，LICENSE 是 CC BY-NC）。以 `LICENSE` 文件（法条级）为准，上游为**非商业许可，禁止商业使用**。这意味着任何直接复用 `tmarks` 源码/素材/文案/布局去商业化，都可能构成侵权。TagNest 作为独立实现，回避了这一风险。

---

## 二、逐项相似性对比与风险定级

风险级别定义：
- **高** = 可能被认定为"实质相似/演绎作品"，直接商业化有侵权风险
- **中** = 存在一定显著性重合，建议核查/调整
- **低** = 通用技术事实或框架约定，无实质风险

| # | 维度 | TagNest | tmarks（上游） | 对比结论 | 风险 |
|---|---|---|---|---|---|
| 1 | **顶层目录布局** | `src/functions/migrations/shared/public/scripts` | 同左 | Cloudflare Pages + Vite 标准布局，框架强制 | **低** |
| 2 | **后端目录命名** | `functions/_lib/*`（`crypto.ts`/`http.ts`/`ids.ts`/`urlkey.ts`/`db.ts`/`env.ts`） | `functions/lib/* + middleware/*`（`crypto.ts`/`response.ts`/`utils.ts`/`signed-url.ts`/`jwt.ts`） | **零同名文件**；`lib` vs `_lib` 表明刻意独立 | **低** |
| 3 | **组件/页面命名** | 小型技术模块：`ui/Button`、`pages/ImportPage`、`hooks/queries/auth.ts` | 领域巨型组件：`BookmarkListView`、`TabGroupTree`、`settings/tabs/*Tab` | **零同名 .tsx 文件**；命名体系完全不同 | **低** |
| 4 | **源码文件头注释** | 英文，独立职责描述 | 中文块（部分已空化） | 无重叠句子；语言/风格均异 | **低** |
| 5 | **核心函数名** | `ids.newId`/`randomToken`/`nowIso`；`http.ApiException`；AES-256-GCM 加密 | `crypto.generateUUID`/`generateNanoId`；`response.success/badRequest`；PBKDF2 | **不同名、不同语义、不同范式**（抛异常 vs 工厂函数） | **低** |
| 6 | **数据库表名/迁移** | `users/sessions/shares/auth_attempts/tag_suggestions/ai_jobs`；迁移 `0001_init`…`0006_*` | `users/auth_tokens/api_key_rate_limits/users.public_slug`；迁移 `0001_d1_console.sql`…`0104_*` | 仅 `users/bookmarks/tags/bookmark_tags` 业务通用名重合；列设计/索引/迁移命名全异 | **中→低**（业务通用名） |
| 7 | **UI 设计令牌** | 自定义语义色：`--color-canvas/ink/line/brand/positive`，`--radius-*` 3 档，热中性色板 | shadcn 样式：`--background/--primary/--card`，`oklch()` 中性色板 + orange 主题 | **Token 体系完全不同**，非 shadcn 镜像 | **低** |
| 8 | **品牌主色** | `#D98324`（琥珀/橙，hex） | `oklch(0.6171 0.1375 39.0427)`（橙红） | 色相/表现方式不同，但同为暖橙系 | **低** |
| 9 | **图标库** | `lucide-react`（ISC） | `lucide-react`（ISC） | 同一第三方开源图标库，通用技术选型 | **低** |
| 10 | **字体** | 系统字体栈（Inter/系统 CJK），不内嵌 | — | 无内嵌字体，无字体许可义务 | **低** |
| 11 | **Logo/素材** | 自定义 SVG favicon + 生成的 PWA 图标 | 仓库内**无任何 .svg/.png/.ico/.webmanifest** | 上游无素材可被复用；TagNest 素材原创 | **低** |
| 12 | **README/文档** | 独立英文长文档，含 clean-room 声明 | 中文简短 README（且无独立 README @ `tmarks/` 层） | 措辞/结构/特性列表全异 | **低** |
| 13 | **依赖库** | React18/zustand/TanStack Query/Vite6/Tailwind4/wrangler | 同为 React/Vite/Tailwind/Cloudflare | 通用现代前端栈，同类应用避不开 | **低** |
| 14 | **tmarks 商标痕迹** | `grep` 全部源码 `tmarks|TMarks|上游|tmarks team` → **0 hit** | — | 无商标/署名残留 | **低** |
| 15 | **tmarks 专有 CSS 套路** | 仅用 `env(safe-area-inset-*)`（标准 PWA 模式），无 `.bookmark-card contain` 等 | 含 `@supports` safe-area 全四边、`.bookmark-card { contain }` 性能段 | 无镜像复制 | **低** |
| 16 | **应用标题** | `TagNest` | `TMarks - 书签管理` | 完全不同的产品名 | **低** |

**总体判定：16 项审查仅 1 项（#6 业务通用表名）被谨慎列为"中→低"，其余全为低风险。综合风险等级：低。** 未发现任何高或确定中的可保护表达层面的实质相似。

---

## 三、可构成风险的两个"共享技术"澄清

均来自共用**第三方开源生态**，而非借鉴上游：

1. **shadcn/ui 设计语言**：`oklch()` token（`--background`/`--primary`/`--card`/…）与 `data-theme='dark'` 约定，是 shadcn/ui（MIT）的通用输出，数千项目在用——是"行业标准技术"，非本项目专属表达。TagNest 虽用了自己的 token 体系，但两项目都受同一 shadcn 语言影响。
2. **lucide 图标 + React/Vite/Tailwind/Cloudflare 栈**：双方共同的第三方技术选型，与书签管理业务无关，属普遍做法。

> 这两点商业化时**无需**修改——它们不是可被 tmarks 主张的"原创表达"。已在 `COMPLIANCE.md` 中说明并归因为共用开源标准。

---

## 四、为消除残余风险而执行的改动（变更清单）

| 文件 | 改动 | 目的 |
|---|---|---|
| **`COMPLIANCE.md`（新增）** | clean-room 声明、上游 CC BY-NC 溯源、逐依赖许可证表、字体/图标/素材清单、义务核查表 | 形成权威合规记录，可在分发时随附 |
| **`scripts/license-audit.mjs`（新增）** | 自动审计全部直接依赖；许可证不在允许清单（MIT/ISC/Apache/BSD/0BSD/BlueOak/etc.）即 exit 1 | 商业化门禁，杜绝将来引入 copyleft/非商业依赖 |
| **`scripts/deploy.mjs`（改动）** | 在质量门禁中新增`许可证合规审计`步骤 | 每次发布强制跑合规审计 |
| **`README.md`（已有）** | 已含 explicit clean-room notice（本审查确认无需重写） | 声明独立性 |

**执行结果：** 许可证审计脚本运行通过（`✓ 全部直接依赖均已商业安全`），并已接入 `deploy.mjs` 发布管线。UI/README/代码结构经审查确认**已独立**，不需要也不应为了"人为制造差异"而重写——那反而会引入回归。

---

## 五、合规评估结论

- **版权**：未发现 TagNest 复制/改编上游可版权表达。结论为**独立作品**，不落入 CC BY-NC 约束。
- **商标**：产品名 `TagNest` 与 `TMarks` 不同；源码零 `tmarks` 引用。
- **第三方版权**：全部依赖为宽松许可（MIT/ISC/Apache），已自动化审计；图标（lucide）ISC、字体为系统栈、favicon/PWA 图原创。
- **反不正当竞争/商业秘密**：无迹象。
- **监管标签**（中/台/港）：本工具为通用书签管理，无涉敏内容、无跨境数据处理披露问题（自托管）。

---

## 六、面向商业上线的完整检查清单

**发布前（本报告已覆盖）：**
- [x] 上游许可核实（CC BY-NC，README 误标 MIT——已以 LICENSE 为准）
- [x] 逐维相似性审查（16 项全走查，无高危）
- [x] 依赖许可证审计（全宽松）自动化为门禁
- [x] 合规声明 `COMPLIANCE.md` 生成
- [x] 确认 LICENSE 为 MIT
- [x] 确认无上游商标/署名/素材/代码块残留

**进入商业运营前建议补做（涉及外部动作，未自动执行）：**
- [ ] **商标注册前查重**：确认 `TagNest` 在与软件相关的国际/本国分类下未被他人注册；若冲突，需改产品名。
- [ ] **域名/品牌一致性**：确认商业域名与产品名一致。
- [ ] **隐私政策 + 服务条款 + Cookie 声明**：上线公开服务需提供（尤其含 cookie/登录）。
- [ ] **GDPR/PIPL 合规**：如向中国/欧盟用户提供服务，需数据处理协议、删除权、导出权支持（书签数据导出已有，建议核对删除=硬删除承诺）。
- [ ] **安全评审**：`JWT_SECRET` 已在产线设置；建议上线前做一次依赖漏洞扫描（`npm audit`）与 OWASP 检查。
- [ ] **SDK/遥测**：确认无强制第三方遥测（现无）；若加埋点需在隐私政策披露。
- [ ] **持续许可证审计**：将 `license-audit.mjs` 纳入 CI（当前已纳入 `deploy.mjs`；建议再加到 GitHub Actions）。

---

## 附：报告数据来源可靠性说明

本报告基于对两仓库**本地源码实读**（`tmarks-origin/` 为上游克隆，`tagnest/` 为本项目），采用目录树、全文检索、配置文件实读等方式，非仅凭 README 声明。所有"零同名""0 hit"均为检索实证。唯一例外：上游 `tmarks/` 层无独立 README（其根 README 与 LICENSE 分离存在），已如实说明。
