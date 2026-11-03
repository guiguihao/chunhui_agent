# CODEBUDDY.md This file provides guidance to CodeBuddy when working with code in this repository.

SmartHomeClaw / `ureal`：Node.js (ESM) 智能家居 AI Agent，用 OpenAI 兼容的 Function Calling 驱动，接入 MCP 工具、飞书长连接与 React WebUI。代码注释、配置说明与 UI 文案均为中文；注意：本文件用英文撰写，回复用户仍用中文。

## 常用命令

**安装依赖**

```bash
pnpm install                      # 根目录（后端）；README 推荐 pnpm
cd webui && npm install           # 前端独立工程，依赖不共享
pip install requests python-dotenv   # 仅 skills/*/scripts/*.py 需要；仓库无 requirements.txt
```

Python 依赖是例外：agent 本体（Node）不依赖 Python，全仓仅 `skills/baidu-search/scripts/search.py` 需要 `requests` + `python-dotenv`。`browser-use` 是 CLI，若要用需单独安装（`uv tool install browser-use` 或 `pipx install browser-use`，另需浏览器），不要指望包管理器带。

**启动**

```bash
npm start          # 生产：node src/agent.js，同时拉起 Express(8080)、飞书 WS、MCP、cron、心跳
npm run dev        # node --watch，改后端代码自动重启（会中断长连接）
cd webui && npm run dev   # 前端 Vite 于 :3000，代理 /api → http://localhost:8080
```

改 UI 必须同时跑后端（`npm start`）和 Vite；Express 只提供 `/api/*`，不托管前端静态文件，`webui/dist` 仅由 `npm run build` 产出。

**前端构建与 lint**

```bash
cd webui && npm run build   # 输出 webui/dist（已在 .gitignore）
cd webui && npm run lint    # 注意：仓库未提交 eslint 配置（无 .eslintrc*/eslint.config.js），直接跑会因找不到配置而失败
```

**测试**（`node --test`，无 jest/vitest）

```bash
npm test                                       # unit + integration + smoke
npm run test:unit                              # 纯逻辑/tmpdir，无网络
npm run test:integration                       # 起本地 HTTP/Express 桩，需 loopback 端口
npm run test:smoke                             # 校验真实 config/*.yaml 完整性
npm run test:cov                               # --experimental-test-coverage

node --test tests/unit/cron-utils.test.js                        # 单文件
node --test --test-name-pattern="cron" tests/unit/cron-utils.test.js   # 单用例
```

**MCP 配置校验**

```bash
npm run setup-mcp   # 扫描 mcp/ 目录并与 config/mcporter.json 比对，只读不改配置
```

**部署（Docker，生产）**

```bash
cp .env.example .env && vim .env   # 必填 key，chmod 600
./deploy/docker-up.sh              # 建状态目录 → docker compose up -d --build → 轮询 /api/health
./deploy/docker-up.sh --no-build   # 交叉构建并 docker load 之后用
```

`Dockerfile` 只装后端（`webui` 已被 `.dockerignore` 排除，由同机 nginx 托管 `dist`）；`docker-compose.yml` 用 `network_mode: host`，这样 `config/mcporter.json` 里的 `127.0.0.1:8123`（HA）无需改动。约束：**单实例**（会话锁在进程内、飞书/微信长连接不能多副本）；`config`/`memory`/`sessions`/`workspace`/`data`/`.env`/`.openclaw` 必须挂卷且可写，否则 WebUI 回写会 500、重启丢记忆。host 网络下 8080 无鉴权，需防火墙只放行 nginx。


## 架构总览

### 组合根：`src/agent.js`

`SmartHomeAgent` 是唯一的装配点，不承载业务逻辑。`init()` 的顺序即依赖顺序：读 `.env` 记录键基线 → `loadConfig()` 并行解析 `config/{agent,cron,heartbeat,plugin}.yaml`（`${VAR}`/`$VAR` 用 `process.env` 替换，缺失时保留原样）→ `MemoryService` → `CoreAgent` → `SkillService` → `Scheduler` → `Heartbeat` → `MessengerBridge` → 按 `plugin.yaml` 的 `enabled` 实例化 `FeishuService`/`MCPorterService`/`WebUIService`。

服务之间通过 setter 注入而非构造参数：`setMemory`/`setSkill`/`setWorkspace`/`setScheduler`/`setHeartbeat`/`setMCPTools`，加上回写回调 `setOnCronTaskExecute`、`setOnCronTasksChanged`、`heartbeat.setOnDynamicChanged`。新增子系统时沿用此模式，否则 `CoreAgent` 内部拿不到服务实例，对应工具也不会注册。

`thinkAndAct(prompt, options)` 只是 `agent.decide()` 的薄包装，所有渠道（WebUI、飞书、cron、心跳）都走这一条路径。

**入口守卫必须保留**：文件末尾用 `process.argv[1] === import.meta.url` 判断才自启动。`tests/unit/restart.test.js` 直接 `import src/agent.js` 依赖这一点；去掉会让测试真的拉起 MCP/飞书写连接。

### 对话主循环：`src/services/coreagent.js`

`decide(prompt, options)` → `runExclusive(sessionId, ...)`：按 `sessionId` 用 Promise 链串行化，同时用 `AsyncLocalStorage` 识别「同会话重入」直接放行——这是为了允许 skill 内部再次调用 `agent.decide()` 而不自锁。任何新增的递归/嵌套调用路径都要遵守这个约定。

每轮的装配：

- 系统提示 `_buildSystemPrompt` 替换占位符 `{name}` `{workspace}` `{readme.md}` `{time}`（Asia/Shanghai）。默认只注入内置 `README_SUMMARY`，`agent.prompt.include_readme: true` 才注入 README 全文。
- 记忆上下文由 `_loadMemoryContext()` 拼成 `## 上下文`，长度受 `memory.max_context_chars` 限制。
- Skill 的 md 正文**按需**注入：只有当 prompt 里出现技能名或调用方指定 `options.targetSkill` 时才追加，避免 prompt 膨胀。
- 模型：`primaryConfigs` 支持数组轮询（`models.default` 可写数组），请求失败依次试 `fallbackConfigs`（`models.fallback`）；provider 通过 `api_key_env` 取 key。每轮新建 OpenAI client，用局部变量避免并发回合互相污染。
- 工具循环默认 `maxToolIterations`（`agent.yaml: agent.max_tool_iterations`，15），cron/心跳传 `background_tool_iterations`（5）。最后一轮不再下发 tools，强制模型收敛为文字。重复的 `name + 参数` 调用直接复用上次结果；工具结果 >20000 字符截断；工具抛异常降级为文本而非冒泡。
- 会话落盘 `sessions/<sessionId>.json`（`toSessionId()` 清洗文件名，保留中文）；历史超 `max_context_turns*2` 条或 30000 字符时自动摘要压缩，失败退化为硬截断。

### 工具注册（新增工具必须改两个文件）

- `src/services/tools/registry.js`：`getAllTools(ctx)` 按 `ctx` 上是否注入了服务条件性 push 工具定义。前缀约定：`memory_*`、`mgmt_cron_*`/`mgmt_heartbeat_*`、`file_*`、`cmd_exec`、每个 skill 一个同名顶级工具（描述带 `[Skill]` 前缀）、MCP 工具 `mcp_<server>_<tool>`。
- `src/services/tools/dispatcher.js`：`handleToolCall` 是一条显式 if 链（`memory_` → `mgmt_` → `mcp_` → `file_` → `cmd_` → skill 兜底）。**没有通用路由表**，新前缀必须在这里加分支，否则会掉进「未知工具」。

工具名必须在注册阶段过 `sanitizeToolName`（`src/services/toolname.js`，非法字符转 `_`、限长 64）和 `dedupeToolName`（冲突加 `_2`），因为 toolMap 的键必须与 LLM 看到的字符串完全一致。

文件工具不经 `pathguard` 之外的路径解析；`cmd_exec` 超时优先级为 `args.timeout_ms` > 脚本类型默认（生图/浏览器 600s，普通 Python 120s）> 30s。

### 技能：`src/services/skill.js` + `skills/`

发现规则（无 JSON manifest）：顶层 `*.js` → 子目录含 `index.js` → 子目录含 `SKILL.md`（YAML frontmatter 提供 `name`/`description`/`parameters`）。解析顺序是 `<dir>/<name>.js` → `<dir>/<name>/index.js` → `<dir>/<name>/SKILL.md`，所以同时存在 `SKILL.md` 与 `src/index.js` 的技能（如 `tasktodolist`）实际按 md 技能处理，由模型用 `cmd_exec` 运行脚本。

- `.js` 技能导出 `default` 或 `execute`，签名 `(agent, params)`，以 `?v=<mtimeMs>` 动态 import 以支持热重载。
- `.md` 技能：正文作为「参考手册」拼进 prompt，再调 `agent.decide()`，并传 `toolFilter` 排除所有 `[Skill]` 工具以禁止技能递归。
- Python 能力一律通过 md 技能 + `cmd_exec` 调 `skills/*/scripts/*.py`。

### 安全边界：`src/services/pathguard.js`

`FileAccessPolicy` 是唯一文件策略实现，被 `dispatcher` 的文件工具和 WebUI 的 `/api/file`、`/api/memory` 复用。规则：黑名单优先（`.env*`、`.ssh/.aws/.git`、`*.pem|key|crt|db`、路径含 `credential|secret|token|auth_data`）→ 写只允许 `workspace/` → 读允许 `workspace/` + `agent.file_read_roots` + media-only 根（`~/.miot-mcp` 等，仅图片）。归属判定用 `path.relative()`，不要改成字符串 `startsWith`（会被 `workspace-evil` 绕过）。

### 日期限定：周末 / 法定假日（`src/services/holiday.js`）

5 段 cron 无法表达「排除周末」「排除法定假日」，因此这类规则**不进 cron**，而是作为调度元数据存在 `cron.yaml` 的 `weekend`/`holiday` 字段（`any|only|exclude`），由 `Scheduler._runTask()` 与 `Heartbeat._runCheck()` 在触发时按 `Asia/Shanghai` 的当天日期判断是否跳过。加新的日期规则时只改这两个入口，不要去改 cron 表达式。

数据来源优先级：`config/holidays.yaml`（人工维护，覆盖一切）→ `data/holidays-cache.json`（远程缓存，`/data/holidays-cache.json` 已 gitignore）→ 远程接口（缺该年份时按需拉取，3s 超时，6 小时内失败不重试）。三者都拿不到时**放行**（`known: false`）并告警，避免数据问题导致任务静默停摆。调休补班的周六日按工作日算，「排除周末」不会误杀它们。`reloadSubsystem('holiday')` 重新读取文件与缓存。

### 状态与配置即事实来源

配置在运行期会被回写，写回时必须保留注释与格式：

- `config/cron.yaml`：`saveCronTasks()` 从 `scheduler.listTasks()` 全量重写，用 `_cronSaveQueue` 串行化；WebUI 直接改文件后调 `reloadSubsystem('cron')`。
- `config/heartbeat.yaml`：动态巡检内容用**文本行替换**只改 `dynamic_prompt`，不要 `yaml.stringify` 整个文件（会丢注释）。
- `config/agent.yaml`：WebUI 的 `/api/config` 用 `patchScalar` 做单行标量替换并同步 `models.default`。
- `.env`：`reloadEnv()` 以启动时的键集合为基线，文件里删掉的变量会从 `process.env` 移除。
- `memory/*.md`：`archive_after_chars` 触发时按 `## ` 章节把最旧内容移入 `memory/_archive/`；写入按整行去重。
- 热重载能力不一致，`reloadSubsystem('model'|'cron'|'heartbeat'|'mcp'|'env')` 会显式返回 `requiresRestart`，不要假装已生效。

### 渠道：`src/services/messenger.js`

`register(name, service)` + `broadcast(text)`：有 `broadcast` 方法的服务自行分发，否则走 `notificationChatId + send`。飞书 `chatId → sessionId = feishu_<chatId>`；WebUI 的 `broadcast` 同时 push SSE 事件并写入当前会话历史。新增渠道只需实现 `send`/`broadcast` 并注册。

微信渠道（`plugin/weixin.js`）另有两个坑：`broadcast` 必须内部 catch 后返回 false（`MessengerBridge.broadcast` 用 `Promise.all`，抛错会拖垮整轮广播）；`context_token` 由入站消息下发且只存 SDK 进程内存，所以进程启动后必须先收到一条消息才能主动推送，重启即失效。

### WebUI（`webui/`）

React 18 + Vite，无路由库、无状态库：`App.jsx` + `components/`（`SessionView`、`CronView`、`HeartbeatView`、`ConfigView`、`MCPView`、`Sidebar`）与后端 `/api/chat`（SSE 流式）、`/api/events`（SSE 事件）、`/api/{cron,heartbeat,config,mcp,env,memory}` 一一对应。`plugin/webui.js` 是单文件 Express 服务，导出 `buildDisplayHistory`/`formatEnvValue`/`parseEnvValue`/`patchDefaultModel` 供单测直接 import。

### 测试边界

`tests/unit` 不联网（用 `tmpdir`、`fakeAgent`、打桩）；`tests/integration` 起真实 loopback 服务（`coreagent.test.js` 用本地 http 桩模拟 OpenAI，`webui.test.js` 占用 18099–18104 端口并需要清理 `app.closeAllConnections()`）；`tests/smoke/config.test.js` 读**真实** `config/*.yaml`，所以改动 cron 表达式（必须 5 段）、任务 ID 唯一性、`heartbeat.interval` 都会直接让 smoke 失败。
