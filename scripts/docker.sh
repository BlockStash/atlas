#!/usr/bin/env bash
# Build the Atlas images and run the containers.
#   ./scripts/docker.sh            build images, then start everything (default)
#   ./scripts/docker.sh build      build images only
#   ./scripts/docker.sh start      start containers from existing images
#   ./scripts/docker.sh stop       stop containers
#   ./scripts/docker.sh restart    restart containers
#   ./scripts/docker.sh logs [svc] follow logs (backend | frontend | admin)
#   ./scripts/docker.sh status     show container status
#   ./scripts/docker.sh down       remove containers (keeps your data volume)
#   ./scripts/docker.sh clean      remove containers AND the data volume
set -euo pipefail
cd "$(dirname "$0")/.."

command -v docker >/dev/null || { echo "Docker is not installed." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker Desktop and retry." >&2; exit 1; }

# First run: create backend/.env from the template, as `npm run setup` does.
if [ ! -f backend/.env ]; then
  cp backend/.env.example backend/.env
  echo "Created backend/.env from the template. Add your keys there, then re-run if needed."
fi

# NEXT_PUBLIC_* values are baked into the frontend at build time: reuse the local ones if present.
if [ -f frontend/.env.local ]; then
  set -a
  # shellcheck disable=SC1090
  . <(grep -E '^NEXT_PUBLIC_[A-Z_]+=' frontend/.env.local)
  set +a
fi

dc() { docker compose "$@"; }

urls() {
  cat <<EOT

Atlas is running:
  App        http://127.0.0.1:3000
  Admin      http://127.0.0.1:3001
  API        http://127.0.0.1:4000/api/health
EOT
}

case "${1:-up}" in
  build)   dc build ;;
  up)      dc build && dc up -d && urls ;;
  start)   dc up -d && urls ;;
  stop)    dc stop ;;
  restart) dc restart ;;
  logs)    shift || true; dc logs -f --tail=100 "$@" ;;
  status)  dc ps ;;
  down)    dc down ;;
  clean)   dc down -v ;;
  *)       sed -n '2,12p' "$0"; exit 1 ;;
esac
