#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
config="$root/teaching/deploy/.env"
action=${1:-help}
if [ "$action" = init ]; then
  if [ -e "$config" ]; then echo "Configuration already exists: $config (kept)"; exit 0; fi
  address=${2:-http://localhost}
  case "$address" in
    http://localhost|http://127.0.0.1) http_port=8080; https_port=8443; secure=0 ;;
    *://*|*/*|*:*|'') echo 'Public address must be a hostname, e.g. mars.example.edu' >&2; exit 1 ;;
    *) http_port=80; https_port=443; secure=1 ;;
  esac
  command -v openssl >/dev/null 2>&1 || { echo 'Install OpenSSL to generate the service token.' >&2; exit 1; }
  token=$(openssl rand -hex 32)
  umask 077
  cat > "$config" <<CONFIG
MARS_SITE_ADDRESS=$address
MARS_HTTP_PORT=$http_port
MARS_HTTPS_PORT=$https_port
MARS_SECURE_COOKIE=$secure
MARS_GATEWAY_TOKEN=$token
MARS_MAX_SESSIONS=8
MARS_MEMORY_LIMIT=2800m
MARS_IDLE_SECONDS=600
MARS_COMMAND_TIMEOUT=20
CONFIG
  echo "Created $config. Start with: sh teaching/scripts/teacher.sh up"
  exit 0
fi
case "$action" in
  up|update|down|logs|status) ;;
  *) echo 'Usage: teacher.sh init [mars.example.edu] | up | update | down | logs | status'; exit 0 ;;
esac
[ -f "$config" ] || { echo 'First run: sh teaching/scripts/teacher.sh init [mars.example.edu]' >&2; exit 1; }
set -- docker compose --project-directory "$root/teaching/deploy" --env-file "$config" -f "$root/teaching/deploy/compose.yaml"
case "$action" in
  up|update) exec "$@" up --build -d ;;
  down) exec "$@" down ;;
  logs) exec "$@" logs --tail=100 -f ;;
  status) exec "$@" ps ;;
esac
