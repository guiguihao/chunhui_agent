# SmartHomeClaw - 智能家居 AI Agent

基于 **Node.js + 大模型工具调用 (Function Calling)** 驱动的自主智能家居 AI 管家系统，具备长期记忆、MCP 工具扩展、自动化定时任务与多端交互能力。

---

## 🌟 核心特性

- 🤖 **多模型决策与高可用**：基于标准 OpenAI 兼容 API 驱动，支持 DeepSeek、OpenAI、NVIDIA NIM、Ollama 等主流模型，具备主备模型故障自动降级（Fallback）与轮询机制。
- 🔌 **MCP Server 深度集成**：内置 `mcporter` 客户端，开箱即用支持 Home Assistant (`ha-mcp`)、米家 (`miot-mcp`)、悠瑞智能家居 (`ureal-mcp`) 与小度度秘等标准 MCP 服务端。
- 🧠 **持久化分层记忆**：自动学习并沉淀用户习惯，划分为用户画像 (`USER_PROFILE.md`)、长期知识 (`KNOWLEDGE.md`)、事实记录 (`FACTS.md`) 与即时上下文 (`CONTEXT.md`)。
- ⚡ **扩展技能系统**：集成了百度搜索、基于 `browser-use` 的浏览器自动化、自媒体图文生成与推送等丰富技能扩展。
- ⏰ **定时调度与心跳巡检**：
  - **Cron 定时调度**：支持标准 Cron 表达式自动化任务，支持动态任务创建与持久化，执行结果自动广播通知。
  - **智能心跳自检**：定时巡检温湿度、水压、设备离线状态等指标，发现异常实时推送信使警报。
- 📱 **多渠道与可视化交互**：
  - **飞书 (Lark) 接入**：基于官方 SDK WebSocket 长连接，支持交互式卡片、打字机流式渐进更新与原生表格渲染。
  - **WebUI 控制台**：基于 React + Vite 的可视化控制台，支持会话监控、配置热重载、心跳与定时任务配置。

---

## 🏛️ 系统架构

```
┌────────────────────────────────────────────────────────────────────────┐
│                          交互层 (Interface Layer)                       │
│        飞书机器人 (WebSocket)        │        WebUI 管理端 (React+Vite) │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│                       调度主控 (SmartHomeAgent)                        │
│   生命周期管理  │  配置热重载  │  消息广播中心 (MessengerBridge)        │
└─────────────────┬───────────────────────────────────┬──────────────────┘
                  │                                   │
        ┌─────────▼──────────────┐          ┌─────────▼──────────────┐
        │     定时任务调度器     │          │      心跳自检引擎      │
        │  (Scheduler/cron.yaml) │          │ (Heartbeat/heartbeat)  │
        └─────────┬──────────────┘          └─────────┬──────────────┘
                  │                                   │
┌─────────────────▼───────────────────────────────────▼──────────────────┐
│                        核心引擎 (CoreAgent)                            │
│  - System Prompt 组装与 README/记忆注入                                │
│  - 多轮上下文管理 (Session Manager)                                    │
│  - 工具调用循环 (Function Calling Loop, maxToolIterations: 10)         │
│  - 工作区安全沙箱 (Workspace Confinement Sandbox)                       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
    ┌───────────────────────────────┼──────────────────────────────┐
    ▼                               ▼                              ▼
┌──────────────┐            ┌──────────────┐              ┌──────────────┐
│  记忆管理    │            │ 技能扩展系统 │              │ MCPorter 桥接│
│(MemoryService)│           │(SkillService)│              │ (MCP Server) │
├──────────────┤            ├──────────────┤              ├──────────────┤
│- 用户偏好画像│            │- 百度搜索    │              │- ha-mcp      │
│- 事实与知识库│            │- 浏览器操作  │              │- ureal-mcp   │
│- 即时对话背景│            │-  
└──────────────┘            └──────────────┘              └──────────────┘
```

---

## 🚀 快速开始

### 1. 环境准备
- Node.js >= 22.0.0（`weixin-agent-sdk` 要求，低版本会导致该渠道无法加载）
- pnpm (推荐) 或 npm
- Python >= 3.10（可选，仅 `skills/` 下的 Python 脚本需要）

### 2. 安装依赖
```bash
pnpm install
# 或 npm install
```

Python 依赖不在包管理器内（仓库已不再维护 `requirements.txt`），仅 `baidu-search` 技能需要：

```bash
pip install requests python-dotenv
```

`skills/baidu-search/scripts/search.py` 用到 `requests` 与 `python-dotenv`；其余技能均为纯 JS / Markdown，不依赖 Python。

若另行安装 `browser-use` 做浏览器自动化，注意它是命令行工具而非 Python 库，需自带浏览器二进制，安装方式以其官方文档为准。

### 3. 配置环境变量
复制示例配置文件并填入相应的 API Key 与凭证：
```bash
cp .env.example .env
```
配置项包括：
- `DEEPSEEK_API_KEY` / `NVIDIA_API_KEY`：大模型 API Key
- `HA_TOKEN`：Home Assistant 长效访问令牌
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET`：飞书应用凭证（若启用飞书）
- `UREAL_TOKEN` / `UREAL_APP_KEY`：悠瑞智能家居 MCP 鉴权

### 4. 验证 MCP Server 配置
```bash
npm run setup-mcp
```

### 5. 启动服务
```bash
# 生产模式启动
npm start

# 开发监控模式（代码变动自动重载）
npm run dev
```

---

## 🐳 Docker 部署（生产推荐）

仓库自带 `Dockerfile` / `.dockerignore` / `docker-compose.yml`。**镜像内只有后端**；前端 `webui/` 由同机的 nginx 容器托管 `webui/dist`，两者通过 `network_mode: host` 共用宿主机网络。

### 前置条件

- Linux 服务器，`uname -m` 为 `aarch64` 或 `x86_64`（官方 `node:22` 无 32 位 ARM 镜像）
- Docker 与 Compose v2
- nginx 容器与 agent 同机（`config/mcporter.json` 里 HA 是 `127.0.0.1:8123`，靠 host 网络直通）

### 一键部署

```bash
git clone <repo> /opt/urealagent && cd /opt/urealagent   # 或 rsync 上传
cp .env.example .env && vim .env                          # 填 API Key
./deploy/docker-up.sh                                     # 建目录 → 构建 → 启动 → 健康检查
```

脚本做的事与手动等价：`mkdir -p config memory sessions workspace data .openclaw` → `docker compose up -d --build` → 轮询 `/api/health`。

### 数据与状态

| 宿主目录 | 容器内 | 内容 | 备份必要性 |
| --- | --- | --- | --- |
| `config/` | `/app/config` | agent/cron/heartbeat/plugin 配置，WebUI 会回写 | ✅ |
| `memory/` | `/app/memory` | 长期记忆 | ✅ |
| `sessions/` | `/app/sessions` | 会话历史 | ✅ |
| `workspace/` | `/app/workspace` | Agent 产出沙箱 | 可选 |
| `data/` | `/app/data` | 节假日缓存（可重新拉取） | 否 |
| `.env` | `/app/.env` | 凭据（单文件挂载，`/api/env` 会改写） | ✅ |
| `.openclaw/` | `/app/.openclaw` | 微信扫码登录态 | 可选 |

```bash
# 备份（cron 每日一次即可）
tar czf /backup/ureal-$(date +%F).tgz -C /opt/urealagent config memory sessions .env
```

### 日常更新（改代码后，免 rebuild）

`src/`、`plugin/`、`skills/`、`README.md` 已以**只读卷**挂载进容器，所以改后端代码不需要重新构建镜像，同步文件后重启进程即可：

```bash
# 本地执行：同步 → 远程 restart → 健康检查（失败自动打印日志）
./deploy/docker-sync.sh user@board

# 依赖或 Dockerfile 变了才需要重建
./deploy/docker-sync.sh user@board --build
```

等价的手工命令：

```bash
rsync -avz ./src ./plugin ./skills ./deploy ./README.md ./Dockerfile ./docker-compose.yml \
  ./package.json ./pnpm-lock.yaml user@board:/opt/urealagent/
ssh user@board 'cd /opt/urealagent && docker compose restart agent'
```

改动类型与动作对照：

| 改动内容 | 需要做什么 | 耗时 |
| --- | --- | --- |
| `skills/**`（`SKILL.md` 或 `*.js`） | 无需重启：md 技能每次执行重新读文件，js 技能按 `mtimeMs` 动态 import | 0 |
| `src/**`、`plugin/**` | `docker compose restart agent` | ~5s |
| `config/*.yaml`、`.env` | 重启进程，或直接在 WebUI 里改（部分走 `reloadSubsystem` 热重载） | ~5s |
| `memory/*.md` | 无需重启，下一轮对话自动读取 | 0 |
| `package.json` / `pnpm-lock.yaml` / `Dockerfile` | **必须重建**：`./deploy/docker-sync.sh user@board --build` | 5–15min |

> ⚠️ 首次应用只读挂载（或任何 `volumes` / `network_mode` 改动）必须用 `docker compose up -d` 重建容器，`restart` 不会应用 compose 文件本身的变更。
>
> ⚠️ WebUI 的 `/api/restart` 是**进程内软重启**（`src/agent.js` 的 `restart()`），已 import 的 ESM 模块不会重新求值，因此改 `src/` 后必须重启容器，而不仅仅是点重启。

### 小内存 / ARM 设备交叉构建

RK3528 这类 1–4GB 内存的板子直接在机上构建容易 OOM，推荐在 x86 上构建后灌入（依赖全是纯 JS，无 native 编译）：

```bash
# x86 机器
docker run --privileged --rm tonistiigi/binfmt --install arm64
docker buildx build --platform linux/arm64 -t ureal-agent:latest --load .
docker save ureal-agent:latest | gzip > ureal-agent-arm64.tgz
scp ureal-agent-arm64.tgz user@board:/tmp/

# 板子
gunzip -c /tmp/ureal-agent-arm64.tgz | docker load
./deploy/docker-up.sh --no-build
```

机上构建则先确认 swap 可用（`free -h`），再 `DOCKER_BUILDKIT=1 docker compose build`。

### nginx（已包含在 compose 内）

`docker-compose.yml` 里 `nginx` 服务与 `agent` 同栈，同样用 `network_mode: host`：

| 项 | 值 |
| --- | --- |
| 镜像 | `nginx:alpine`（多架构，ARM 直接可用） |
| 配置 | `deploy/nginx/ureal.conf` → `/etc/nginx/conf.d/default.conf`（只读） |
| 站点根 | 宿主机 `webui/dist` → `/usr/share/nginx/html`（只读） |
| 监听 | 80（如启用 TLS 则再加 443） |

配置要点（完整见文件本身）：`/api/` 反代 `127.0.0.1:8080` 且 `proxy_buffering off` + `gzip off`（`/api/chat`、`/api/events` 是 SSE，缓冲会让流式回复攒到最后一次性出现）；`/assets/` 长缓存（vite 产物带内容哈希）；`/index.html` 不缓存；`location /` 走 SPA fallback。

**前端产物必须先构建**（静态文件与架构无关，在本地 Mac 上 build 最快）：

```bash
cd webui && npm install && npm run build     # 产出 webui/dist
rsync -avz --delete ./webui/dist user@board:/opt/urealagent/webui/
```

之后 `./deploy/docker-sync.sh user@board` 会自动带上 `webui/dist`（已构建时），并在同步后 reload nginx。

**端口冲突**：两个容器都用 host 网络，nginx 直接占用宿主机 80/443。如果之前单独跑过 nginx 容器，先停掉：

```bash
docker ps --format '{{.Names}}\t{{.Ports}}' | grep ':80'
docker rm -f <旧nginx容器名>
```

启用 HTTPS 时在 `ureal.conf` 里补一个 443 的 server 块，并把证书目录挂进来（compose 里已留注释位）：

```nginx
server {
    listen 443 ssl;
    server_name your.domain.com;

    ssl_certificate     /etc/nginx/certs/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/privkey.pem;

    root /usr/share/nginx/html;
    index index.html;

    # 其余 location（/api/、/assets/、/）与 80 端口那份保持一致
}
```

### ⚠️ 安全

host 网络下 8080 直接落在宿主机上，而 WebUI 的 `/api/env`、`/api/file`、`/api/config` **没有任何鉴权**，能读出全部 API Key 与家庭设备信息。务必只放行 nginx 的 80/443：

```bash
sudo ufw deny 8080
```

同时保持**单实例**：`CoreAgent` 的会话锁在进程内，多副本会并发写同一份 `sessions/*.json`，飞书 / 微信长连接也会重复回复。

---

## 📁 目录结构

```
urealagent_new/
├── config/                      # 系统配置目录
│   ├── agent.yaml               # Agent 基础提示词与模型 Provider 配置
│   ├── mcporter.json            # MCP Server 注册与连接配置
│   ├── cron.yaml                # 定时任务配置（支持热更新回写）
│   ├── heartbeat.yaml           # 心跳自检规则与巡检项目
│   └── plugin.yaml              # 飞书、MCPorter、WebUI 等插件启用配置
├── memory/                      # 持久化长期记忆库 (Markdown)
│   ├── USER_PROFILE.md          # 用户画像与行为偏好
│   ├── KNOWLEDGE.md             # 长期业务经验与通用知识
│   ├── FACTS.md                 # 关键事实与设备硬件信息
│   └── CONTEXT.md               # 阶段性对话背景上下文
├── mcp/                         # 本地 MCP Server 源码与服务
│   ├── miot-mcp/                # 米家设备接入协议与服务端
│   └── ureal-mcp/               # 悠瑞智能家居控制与审计日志
├── plugin/                      # 外部通信与界面扩展插件
│   ├── feishu.js                # 飞书交互式卡片长连接服务
│   ├── weixin.js                # 微信渠道（长轮询 + 扫码登录 + 主动推送）
│   ├── mcporter.js              # MCPporter 客户端及工具动态发现
│   └── webui.js                 # WebUI 后端 API 与安全服务
├── deploy/                      # 部署脚本与 nginx 配置
│   ├── docker-up.sh             # 一键部署（建目录 → build → 健康检查）
│   ├── docker-sync.sh           # 增量更新（rsync → restart，免 rebuild）
│   └── nginx/ureal.conf         # 前端静态托管 + /api 反代
├── skills/                      # 扩展技能目录 (Markdown/JS/Python)
│   ├── baidu-search/            # 百度搜索调用
│   ├── tasktodolist/            # 待办清单管理
│   └── weather/                 # 天气与环境数据查询
├── src/                         # 核心业务源码
│   ├── agent.js                 # 主控制程序与生命周期调度
│   └── services/                # 核心功能服务模块
│       ├── coreagent.js         # CoreAgent 模型循环与安全沙箱
│       ├── memory.js            # 记忆管理服务
│       ├── scheduler.js         # 定时任务执行引擎
│       ├── heartbeat.js         # 心跳自检服务
│       ├── skill.js             # 技能动态注册与调度
│       └── messenger.js         # 多通道消息路由广播器
├── webui/                       # WebUI 前端工程 (React + Vite)
├── workspace/                   # Agent 执行临时文件与报表输出沙箱
├── scripts/                     # 运维辅助与配置检查脚本
│   └── setup-mcp.js             # MCP Server 状态验证脚本
├── .env.example                 # 环境变量模板
├── Dockerfile                   # 后端镜像（node:22-slim + python venv）
├── docker-compose.yml           # agent + nginx 两服务编排（host 网络）
├── package.json
└── README.md
```

---

## ⚙️ 核心配置说明

- **[config/agent.yaml](file:///Volumes/ssd/project/xuexi/urealagent_new/config/agent.yaml)**：定义管家姓名、核心行动准则、工作区路径、模型 Providers 及默认主/备模型配置。
- **[config/mcporter.json](file:///Volumes/ssd/project/xuexi/urealagent_new/config/mcporter.json)**：配置所连接的外部或本地 MCP 服务端（URL、命令、鉴权 Headers 等）。
- **[config/cron.yaml](file:///Volumes/ssd/project/xuexi/urealagent_new/config/cron.yaml)**：配置静态定时任务，支持 AI 动态添加与启停管理，数据自动持久化。
- **[config/heartbeat.yaml](file:///Volumes/ssd/project/xuexi/urealagent_new/config/heartbeat.yaml)**：配置自检间隔与自检 Prompt，异常时自动触发报警。
- **[config/plugin.yaml](file:///Volumes/ssd/project/xuexi/urealagent_new/config/plugin.yaml)**：配置飞书机器人、MCP 端口及 WebUI 服务端口。

---

## 💬 渠道管理（WebUI / 飞书 / 微信）

WebUI 侧边栏「渠道管理」汇总所有消息渠道的实时状态，并支持在页面上完成微信扫码接入。

- **飞书**：在 `config/plugin.yaml` 填好 `app_id` / `app_secret`（或 `.env` 中的变量），启动即自动连接。
- **微信**：基于第三方 SDK [`weixin-agent-sdk`](https://github.com/wong2/weixin-agent-sdk) 的长轮询实现，**非微信官方协议**，请自行评估账号风险。
  1. 启动服务后打开 WebUI →「渠道管理」→ 微信卡片点击「连接微信」；
  2. 弹窗展示二维码，手机微信扫码并在手机上确认；
  3. 凭据写入 `${OPENCLAW_STATE_DIR:-~/.openclaw}/openclaw-weixin/accounts/`，下次启动自动重连（无需再扫码）。

微信渠道的限制（协议决定，无法规避）：

| 限制 | 说明 |
|------|------|
| 单账号 | 每次扫码会覆盖上一个账号，不支持多号并存 |
| 主动推送需先有入站消息 | 微信下发的 `context_token` 只存在进程内存里，**本次启动后必须先在微信里给机器人发一条消息**，定时任务/心跳告警才能推送到微信；重启后需再发一条 |
| 纯文本 | 回复会自动去除 Markdown（表格改写成「项目：值」逐行形式） |
| 无需公网 | 走长轮询 `getupdates`，本机可直连，不用内网穿透 |

---

## 🛡️ 安全与沙箱机制

1. **环境隔离**：所有敏感凭证（如 Home Assistant JWT Token、各类 API Key）严格通过 `.env` 注入，杜绝硬编码。
2. **文件系统沙箱**：所有文件工具读写均受统一策略（`src/services/pathguard.js`）约束 —— 写操作仅限 `workspace/`；读操作默认仅限 `workspace/`，`~/.miot-mcp` 等目录仅可读图片资源，其余路径一律拒绝。判定使用 `path.relative()`，杜绝 `workspace-evil` 类前缀绕过。
3. **敏感黑名单优先**：无论位于哪个目录，`.env*`、`.ssh/`、`.aws/`、`*.pem`/`*.key`/`*.db` 及含 `token`/`secret`/`credential` 的文件一律拒绝访问。
4. **接口防越权**：WebUI 的 `/api/file`、`/api/memory` 复用同一套策略，禁止读取 `.env`、`config/` 及各类密钥证书。

> 若需让 Agent 读取额外目录，可在 `config/agent.yaml` 中配置：
> ```yaml
> agent:
>   file_read_roots:
>     - "/data/reports"
> ```

---

## 🧪 测试

```bash
npm test                 # 全部测试
npm run test:unit        # 单元测试（无网络依赖）
npm run test:integration # 集成测试
npm run test:smoke       # 配置完整性冒烟测试
npm run test:cov         # 带覆盖率
```

---

## ♻️ 记忆生命周期

记忆文件（`memory/*.md`）此前只增不减且每轮全量注入提示词，token 成本随时间线性上升。现提供治理参数，在 `config/agent.yaml` 中配置：

```yaml
memory:
  # 单个文件超过该字符数时，最旧的章节自动移入 memory/_archive/
  archive_after_chars: 30000
  # 每个文件注入系统提示的长度上限（保留最新内容），0 表示不限制
  max_context_chars: 4000

agent:
  prompt:
    # 是否将完整 README 注入系统提示（默认 false，改用精简摘要）
    include_readme: false
```

---

## 📄 许可证

本项目基于 [MIT License](file:///Volumes/ssd/project/xuexi/urealagent_new/LICENSE) 开源。
