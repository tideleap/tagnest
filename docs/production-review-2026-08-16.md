# TagNest 生产就绪全面审查报告

**审查日期**：2026-08-16
**审查范围**：前端 SPA（src/）、后端 Functions（functions/，125 个端点）、配置与依赖、CI/CD
**结论**：**达到生产上线标准**。发现并修复 5 处问题（含 1 处生产级缺陷），六大维度全部通过。

---

## 一、修复清单（5 项）

### 1. [生产缺陷] CSP 阻断 Google Fonts — `public/_headers`
- **问题**：CSP 的 `style-src 'self'` 与 `font-src 'self'` 未放行 Google Fonts 域名，导致 atelier 展示字体（Space Grotesk / Instrument Serif）在生产环境被浏览器静默拦截，降级为系统字体。
- **修复**：`style-src` 增加 `https://fonts.googleapis.com`，`font-src` 增加 `https://fonts.gstatic.com`。保持其余策略不变（无 `script-src` 放宽、无通配符）。

### 2. [可观测性] 缺少全局运行时错误捕获 — `src/main.tsx`
- **问题**：ErrorBoundary 只覆盖渲染期异常；事件处理器、定时器、动态导入中的异步 rejection 会逃逸到 React 树外，生产环境无遥测。
- **修复**：新增 `window.addEventListener('error')` 与 `unhandledrejection` 监听，统一 `[tagnest]` 前缀输出，便于生产 console 检索。

### 3. [代码质量] 死代码 — `src/components/atelier/Atmosphere.tsx`
- **问题**：`ink` 颜色变量被读取（2 处）但从未使用。
- **修复**：删除声明与重读逻辑，减少每帧无关的样式计算。

### 4. [代码质量] 冗余 eslint-disable — `functions/_lib/feed.ts`
- **问题**：`no-cond-assign` 的 disable 指令已无对应告警（Unused directive）。
- **修复**：删除该行。

### 5. [代码质量] 未使用变量 — `functions/_lib/healthcheck.ts`
- **问题**：`catch (e)` 中 `e` 未使用。
- **修复**：改为无绑定 `catch`。

---

## 二、六大维度审查结论

### 1. 代码质量 — 通过
- `as any` 使用：**0 处**（类型纪律优秀）
- 全部 7 处 `JSON.parse` 均有 try/catch 防护或上游校验
- 5 处非空断言（`!`）均有前置 `has()` 守卫或 `??` 兜底
- 前端仅 2 处 console 语句，均为合理错误日志（SW 注册、渲染错误边界）

### 2. 错误处理 — 通过
- **后端**：`ApiException` 统一错误体系 + 中间件集中捕获 + 不透明 500（不泄露表名/列名）+ `readJson` 请求体校验 + 405 方法守卫
- **前端**：ErrorBoundary + API 层 `classifyFetchFailure` + HttpError retriable 标志驱动的智能重试
- 关键路径（auth/vault/import）全部有降级与失败关闭策略

### 3. 性能 — 通过
- LibraryPage 使用 `@tanstack/react-virtual` 虚拟滚动 + 无限加载
- BookmarkCard 已 `memo` 化，避免列表重渲染
- React Query：`refetchOnWindowFocus: false`、`staleTime: 30s`、仅重试瞬态错误
- 全部 16 个页面懒加载（代码分割）
- Atmosphere canvas：DPR 上限 2、粒子数按视口面积缩放、页面隐藏暂停、reduced-motion 静帧
- **观察项**：`similarBookmarks` 候选池无 LIMIT（功能正确性所需，大书签库用户为 O(n) 扫描，暂可接受）

### 4. 安全性 — 通过
- **密钥管理**：`DEV_SECRET` 回退在 `CF_PAGES=1` 时 fail-closed 拒绝（auth.ts + crypto.ts 双处）；JWT_SECRET 走 `wrangler pages secret`，不入库
- **SSRF**：字面主机分类器覆盖全部保留段（RFC1918/CGNAT/link-local/ULA/NAT64/IPv4-mapped），不可解析即拦截
- **认证**：登录时序均衡（防账户枚举）、PBKDF2 100k 迭代、D1 分布式限流（IP 20 次 + email 8 次 / 15 分钟）
- **Cookie**：HttpOnly + SameSite=Lax + Secure + Path 限定 `/api/auth`
- **输入校验**：URL 仅允许 http/https（拒绝 javascript:/data:/file:），创建与更新端点均校验；私密恢复路径在 db 层二次校验（纵深防御）
- **XSS**：0 处 `dangerouslySetInnerHTML`；CSP + X-Frame-Options DENY + nosniff
- **CORS**：白名单回显（非 `*`），credentials-aware

### 5. 配置与依赖 — 通过
- wrangler.toml：D1/KV/R2/Browser Run 绑定齐全，全部可选绑定有优雅降级
- CI：typecheck + lint + 后端测试 + UI 测试 + 主题一致性 + backlog 一致性
- 部署：健康检查 + 自动回滚 + 迁移幂等探针
- 依赖无版本冲突，构建测试全通过
- **跟进项**：npm audit 因华为云镜像不支持审计端点（405）无法执行；zustand/wrangler 等有 semver 范围内小版本更新，因 safe-delete 钩子环境问题未在本次执行，建议干净环境处理

### 6. 日志与可观测性 — 通过
- 结构化 JSON 日志（`[tagnest]` 前缀，Cloudflare Logs 可查询）
- 中间件记录每个请求（method/path/status/duration/userId）与错误
- 关键事件覆盖：user.signup、import.*、ai.job.*、ai.enrich.*
- 本次补充前端全局错误捕获（见修复 #2）

---

## 三、最终验证数据

| 检查项 | 基线 | 最终 |
|---|---|---|
| ESLint | 0 错误 / 2 警告 | **0 错误 / 0 警告** |
| TypeScript | 通过 | 通过 |
| 后端测试 | 72 文件 / 729 通过 | **72 文件 / 729 通过** |
| UI 测试 | 14 文件 / 71 通过 | **14 文件 / 71 通过** |
| 生产构建 | 通过 | **通过（5.09s）** |
| 主包体积 | 156.34 kB | **156.49 kB（gzip 51.91 kB）** |

主包 +0.15 kB 来自全局错误捕获监听，可忽略。

---

## 四、上线建议

1. **立即可上线**：当前代码库通过全部质量门。
2. **上线后验证**：确认生产 CSP 头包含 fonts.googleapis.com（`curl -I https://tagnest.pages.dev` 检查 Content-Security-Policy），并打开 DevTools Network 确认 Space Grotesk 字体文件 200 加载。
3. **后续跟进**（非阻塞）：
   - 干净环境执行 `npm update`（semver 范围内补丁）
   - 接入官方 npm registry 后补跑 `npm audit`
   - 大书签库场景关注 similarBookmarks 响应时间
