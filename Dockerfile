# syntax=docker/dockerfile:1
#
# ureal SmartHome Agent 生产镜像（ARM64 / x86_64 通用）
# 前端 webui/ 不在本镜像内，由同机 nginx 容器托管 webui/dist
#
FROM node:22-bookworm-slim

# python3 仅供 skills/baidu-search/scripts/search.py 使用（仓库已不再维护 requirements.txt）
# tini：cmd_exec 会大量派生 python 子进程，PID 1 必须能正确收尸
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv tini curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    OPENCLAW_STATE_DIR=/app/.openclaw

# 配置、记忆、技能、工作区的路径全部基于 process.cwd()，这里必须是项目根
WORKDIR /app

# 依赖层单独一层：改业务代码不必重装依赖（lockfileVersion 9.0 → pnpm 9）
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@9 --activate \
    && pnpm install --prod --frozen-lockfile

# 唯一的 Python 依赖；Debian 12 有 PEP 668，必须走 venv
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir requests python-dotenv
ENV PATH="/opt/venv/bin:$PATH"

# 业务代码（.dockerignore 已排除 webui/、node_modules/、.env、sessions/ 等）
COPY . .

# 卷挂载点先建好，避免首次启动因目录缺失报错
RUN mkdir -p config memory sessions workspace data .openclaw

EXPOSE 8080

# /api/health 是现成接口，直接作为容器探针
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/agent.js"]
