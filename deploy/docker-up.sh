#!/usr/bin/env bash
#
# ureal SmartHome Agent 一键部署（同机 + host 网络）
#
# 用法：
#   ./deploy/docker-up.sh            # 首次部署：建目录、检查 .env、构建并启动
#   ./deploy/docker-up.sh --no-build # 已有镜像（如交叉构建后 docker load），直接启动
#
# 约定：在项目根目录执行（脚本会自动 cd 到根目录）。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NO_BUILD=0
[[ "${1:-}" == "--no-build" ]] && NO_BUILD=1

green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[0;33m%s\033[0m\n' "$*"; }
die()   { printf '\033[0;31m%s\033[0m\n' "$*" >&2; exit 1; }

# ── 1. 前置检查 ────────────────────────────────────────────────
command -v docker >/dev/null || die "未找到 docker，请先安装"
docker compose version >/dev/null 2>&1 || die "未找到 docker compose（需要 v2 插件）"

ARCH="$(uname -m)"
if [[ "$ARCH" != "aarch64" && "$ARCH" != "x86_64" ]]; then
  die "不支持的架构: $ARCH（官方 Node 22 镜像只提供 amd64 / arm64）"
fi

# ── 2. 状态目录（Docker 自动创建会属 root，这里先建好）─────────
mkdir -p config memory sessions workspace data .openclaw
green "[1/4] 状态目录就绪: config memory sessions workspace data .openclaw"

# ── 3. .env ───────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  if [[ -f .env.example ]]; then
    cp .env.example .env
    chmod 600 .env
    warn "[2/4] 已生成 .env，请填写 API Key 后重新执行本脚本："
    warn "      vim $ROOT/.env"
    exit 0
  fi
  die "缺少 .env 与 .env.example，无法继续"
fi
green "[2/4] 已存在 .env（如刚改过，可继续；改动会在下次重启生效）"

# 前端产物：nginx 服务挂载 webui/dist，缺了会 404
if [[ ! -f webui/dist/index.html ]]; then
  warn "[2/4] 未找到 webui/dist/index.html —— nginx 将返回 404"
  warn "      本地执行: cd webui && npm install && npm run build"
  warn "      然后同步: rsync -avz ./webui/dist user@board:$ROOT/webui/"
fi

# ── 4. 构建并启动 ─────────────────────────────────────────────
if [[ "$NO_BUILD" -eq 1 ]]; then
  green "[3/4] 跳过构建（--no-build）"
  docker compose up -d --no-build
else
  green "[3/4] 构建镜像（首次或代码更新后较慢，ARM 小机器建议先确认 swap 已启用）"
  DOCKER_BUILDKIT=1 docker compose build
  docker compose up -d
fi

# ── 5. 健康检查（最多等 60s）──────────────────────────────────
green "[4/4] 等待 /api/health ..."
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1; then
    green "✅ 启动成功: $(curl -fsS http://127.0.0.1:8080/api/health)"
    echo
    echo "查看日志: docker compose logs -f agent"
    warn "提醒：host 网络下 8080 直接对外且无鉴权，请用防火墙只放行 nginx 的 80/443"
    exit 0
  fi
  sleep 2
done

die "60s 内未通过健康检查，请执行 docker compose logs --tail=100 agent 排查"
