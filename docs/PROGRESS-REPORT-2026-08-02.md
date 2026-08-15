# TagNest 进度汇报 & 需求清单报告

> 📦 **归档说明**：本文是 2026-08-02 的历史进度快照，其中列出的需求与状态**已被 2026-08-15 修复覆盖**。
> 当前有效基线见工作区 `TagNest-PM优化清单.md`；本文仅作存档，请勿据此判断现状。

> **日期**：2026-08-02 · **报告性质**：实证盘点（git / 台账 / 测试 / 线上状态）
> **线上**：https://tagnest.pages.dev · **仓库**：tideleap/tagnest · **HEAD**：`ebe69d2`

---

## 一、当前进度总览

### 状态速览
| 维度 | 数值 | 说明 |
|------|------|------|
| 需求台账 | **49 项 / 独立 47** | ✅ done 44 ／ ➖ superseded 2 ／ ⏸ blocked-external 1 |
| 独立待办 | **0 项** | F-P1-5/F-P1-6 为 alias（镜像到已完成的 B7/O11） |
| 测试 | 后端 **191** / UI **24** | 20 个后端文件 + 4 个 UI 组件/store 文件 |
| 质量门禁 | 全绿 | typecheck / lint / test / themes:check / backlog:check |
| CI + Deploy | ✅ success（`ebe69d2`） | 最新提交已部署上线 |
| 生产健康 | ✅ /api/health 200 | D1/KV/auth 全绿 |
| git 同步 | ✅ 工作区干净，远端=本地 | — |

### 里程碑完成情况
- **生产功能**：书签 / 标签 / 浏览 / 归档 / 回收站 / 搜索 / 导入导出 / 分享 / 标签页组 / API 密钥 / 快捷指令 / PWA 离线 / 多主题 / 浏览器扩展 — 全部实现。
- **优化阶段**：①紧急修复（4 项）②重要改进（4 项）③建议优化（C-1~C-5）— **全部完成**（详见 §四）。

---

## 二、需求清单（需求台账 `docs/backlog.json`，单一事实源）

> 台账 = 48 条 F/O/Q/R + 1 条 B9（CI/CD 流水线），共 49 条，含 2 条跨文档别名。状态经 CI `backlog:check` 强校验，防止"标 done 却没做 / 做了却没标"。

### 2.1 全部完成项（done 44）
| 编号 | 需求 | 优先级 | 状态 |
|------|------|--------|------|
| F-P1-1~4 | 书签/标签/搜索/列表 等核心功能 | P0-P1 | ✅ |
| F-P1-5 | 数据层健壮性（alias→B7） | P1 | ✅ 已镜像 |
| F-P1-6 | AI 能力（alias→O11） | P1 | ✅ 已镜像 |
| O5 | API 密钥（个人访问密钥） | P0 | ✅ |
| O7 | 公共分享页 | P0 | ✅ |
| O8 | 系统级辅助能力（设置/导入等） | P1 | ✅ |
| O10 | 浏览器扩展（MV3） | P2 | ✅ |
| O11 | AI 自动标签/摘要（provider 适配器） | P1 | ✅ |
| O12 | 标签页组（含一键收纳） | P2 | ✅ |
| Q8a-f | 访问统计/标签色/深色/封面/导入进度/PWA | P2-P3 | ✅ |
| R1-R4 | 风险项（README 失实纠正、认证安全等） | P0-P2 | ✅ |
| B7 | 请求超时与重试分流 | P1 | ✅ |
| B8 | 概览页 /dashboard | P3 | ✅ |
| B9 | CI/CD 自动化部署流水线 | — | ✅ |

### 2.2 净室取代项（superseded 2）
净室重写中已通过其它实现覆盖，未单独开发：
- 多数 Q8 项在净室落地（访问统计/标签色/深色已内建）。

### 2.3 唯一待办队列项（open 2 — 均为 alias 镜像）
- `F-P1-5` → 目标 **B7 done** → 镜像 ✅
- `F-P1-6` → 目标 **O11 done** → 镜像 ✅
> **非真正待办**：BACKLOG.md 已显示 ✅ done。

### 2.4 阻塞项（blocked-external 1）— 需你人工处理
- **R5 凭证卫生（P0）**：🔑 到 GitHub → Settings → Developer settings → Personal access tokens，**手动吊销** `ghp_OrnyH…` 与 `ghp_y2Uw…`（曾泄露；Agent 无法代吊销）。可用的 `ghp_DJhd…` 已存 `~/.git-credentials` 供自动推送，建议用一段后轮换。

---

## 三、功能模块矩阵（实现 vs 测试覆盖）

| 模块 | 后端实现 | 前端实现 | 测试覆盖 |
|------|---------|---------|---------|
| 认证（注册/登录/会话轮换） | ✅ | ✅ | ✅ auth/throttle/signup |
| 书签 CRUD + 幂等唯一索引 | ✅ | ✅ | ✅ db/urlkey |
| 标签 + 合并 | ✅ | ✅ | ✅ db |
| 搜索（fts5 trigram） | ✅ | ✅ | ✅ db |
| 概览页 /dashboard | ✅(/stats) | ✅ | —(UI 构建验证) |
| 导入（HTML/JSON/CSV + 进度流） | ✅ | ✅ | ✅ import-parsers/import-progress |
| 导出 CSV（注入防护） | ✅ | — | ✅ |
| 分享页（含配色选配 C-3） | ✅ | ✅ | ✅ shares |
| 标签页组 | ✅ | ✅ | ✅ tabgroups |
| API 密钥 | ✅ | ✅ | ✅ apikeys |
| AI 标签/摘要（provider 适配） | ✅ | ✅ | ✅ ai/ai-readiness |
| 多主题（5 套 + system） | — | ✅ | ✅ themes/ui/Appearance |
| 浏览器扩展（MV3） | — | ✅ | ✅ extension |
| PWA 离线 | — | ✅ | ✅ pwa |
| CI/CD + D1 迁移 | ✅ | — | ✅(backlog/migrate) |

---

## 四、近期交付（本批次优化阶段完成情况）

### 阶段①【紧急修复】— 安全/正确性 (d639b05..74c8cc3)
- **A-3 幂等化**：DB 部分唯一索引 `(user_id,url_key) WHERE deleted_at IS NULL`，并发同 URL 二写返 409。
- **A-4 迁移阻塞**：D1 可达时迁移失败即卡发布；probe-d1 判定 token D1 scope，缺权限则降级跳过。
- **A-1 邀请码门禁**：`INVITE_CODE` 常数时间校验 + 失败节流。
- **A-2 AI 可见化**：设置页实时就绪横幅（绿=就绪/琥珀=列缺失）。

### 阶段②【重要改进】(bda0190..67f2e04)
- **B-1 前端组件测试基建**：happy-dom + RTL，`test:ui` + CI 步骤。
- **B-2 RemoteImage**：图片加载统一兜底。
- **B-3 设置页拆分**：922→73 行。
- **B-4 主题一致性校验**：SPA vs 扩展防漂移，接入 CI。

### 阶段③【建议优化】(ec6f330..ebe69d2; 含一次生产修复)
- **C-1+C-6 queries 拆分**：617 行 → 7 域 + re-export 桶。
- **C-2 exhaustive-deps 注释**：3 处裸 disable 加理由。
- **C-3 分享页配色选配**：migration 0005 shares.palette + 前后端。
- **C-4 retriable 错误契约**：后端标志 → 前端 HttpError → react-query 重试策略。
- **C-5 oklch 降级**：theme.css 130 处 hex fallback。
- **生产修复**：migrate.mjs 探针补 0004/0005（防 `_d1_migrations` 登记滞后重跑失败）。

---

## 五、关键决策与经验沉淀

1. **DB 唯一索引为部分索引**（`WHERE deleted_at IS NULL`）——既要防并发重复，又保住"回收站后再加同 URL"的恢复路径。
2. **迁移脚本免疫**：`MIGRATION_PROBES` 按 schema 探测"已应用未登记"，规避既有迁移的重跑失败；新技术支持 ADD COLUMN 的迁移一律同步登记探针。
3. **大文件重构交 Agent + trust-but-verify**：拆分后用备份逐字比对 + 自己重跑全门禁。
4. **共享代码/经验已写入记忆**：GitHub API 用 `Bearer`、vite 产物校验路径、zustand store 测试复位、CI 部署无 token 注入等。

---

## 六、遗留事项

| 项 | 类型 | 说明 | 状态 |
|----|------|------|------|
| R5 吊销旧 PAT | blocked-external | `ghp_OrnyH…`/`ghp_y2Uw…` 需你手动吊销 | ⏸ 待人工 |
| Cloudflare token D1 scope | 环境 | 已确认可用（迁移 0004/0005 已应用生产） | ✅ 已解决 |
| oklch 回退即启发式 | 建议 | 129 处 hex fallback 已上线；新配色编辑后用 `scripts/oklch-fallback.py` 重生成 | ✅ 已覆盖 |

**结论：全部可自动执行的需求/优化阶段均已圆满完成并部署上线；唯一需你配合的是 R5 的 PAT 吊销。**
