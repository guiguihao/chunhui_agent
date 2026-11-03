#!/usr/bin/env bash
#
# ureal SmartHome Agent 增量更新（本地执行）
#
# 前提：服务器上 docker-compose.yml 已挂载源码卷（src/plugin/skills/README.md），
#       因此改后端代码只需 restart，不必 rebuild。
#
# 用法：
#   ./deploy/docker-sync.sh user@board                # 同步代码 + 重启 + 健康检查
#   ./deploy/docker-sync.sh user@board --build        # 依赖/Dockerfile 变更时：同步 + 重建镜像
#   ./deploy/docker-sync.sh user@board /opt/urealagent # 自定义远程目录（默认 /opt/urealagent）
#
# 安全约定：不使用 rsync --delete，避免误删服务器上的 config / memory / sessions 等状态。

set -euo pipefail

REMOTE=""
DEST="/opt/urealagent"
BUILD=0

for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    -*) printf '\033[0;31m未知参数: %s\033[0m\n' "$arg" >&2; exit 1 ;;
    *) if [[ -z "$REMOTE" ]]; then REMOTE="$arg"; else DEST="$arg"; fi ;;
  esac
done

[[ -n "$REMOTE" ]] || { printf '用法: %s user@host [远程目录] [--build]\n' "$0" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[0;33m%s\033[0m\n' "$*"; }

# ── 1. 同步代码 ────────────────────────────────────────────────
green "[1/3] 同步代码 → $REMOTE:$DEST"
rsync -avz \
  ./src ./plugin ./skills ./deploy \
  ./README.md ./Dockerfile ./docker-compose.yml \
  ./package.json ./pnpm-lock.yaml \
  "$REMOTE:$DEST/"

# 前端产物（webui/dist 被 gitignore，需本地 npm run build 后单独同步）
if [[ -f ./webui/dist/index.html ]]; then
  green "[1/3] 同步前端产物 → $REMOTE:$DEST/webui/dist"
  rsync -avz --delete ./webui/dist "$REMOTE:$DEST/webui/"
else
  warn "[1/3] 未找到 webui/dist/index.html，跳过前端同步（先执行: cd webui && npm run build）"
fi

# ── 2. 远程执行 ────────────────────────────────────────────────
if [[ "$BUILD" -eq 1 ]]; then
  green "[2/3] 重建镜像（依赖或 Dockerfile 有变更）"
else
  green "[2/3] 重启进程（不重建镜像）"
fi

ssh "$REMOTE" bash -s -- "$DEST" "$BUILD" <<'REMOTE_SCRIPT'
set -euo pipefail
DEST="$1"
BUILD="$2"
cd "$DEST"

if [[ "$BUILD" -eq 1 ]]; then
  DOCKER_BUILDKIT=1 docker compose up -d --build
else
  docker compose restart agent
  # nginx 配置是 bind mount，改了 conf 需要 reload/restart 才生效
  if docker compose ps --status running --services 2>/dev/null | grep -qx nginx; then
    docker compose exec -T nginx nginx -t >/dev/null 2>&1 \
      && docker compose exec -T nginx nginx -s reload \
      || docker compose restart nginx
  fi
fi

for _ in $(seq 1 15); do
  if curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1; then
    printf '\033[0;32m[3/3] 已生效\033[0m\n'
    curl -s http://127.0.0.1:8080/api/health
    echo
    exit 0
  fi
  sleep 2
done

printf '\033[0;31m[3/3] 健康检查失败（30s 未就绪），最近日志：\033[0m\n' >&2
docker compose logs --tail=50 agent
exit 1
REMOTE_SCRIPT

warn "提示：本次若未加 --build 而日志出现 Cannot find package，说明依赖变了，请重跑并加上 --build"
