#!/usr/bin/env bash
set -euo pipefail
# Give each service its own process group so Ctrl+C also stops npm's children.
set -m
career_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$career_root/.local/runtime.env" ]]; then source "$career_root/.local/runtime.env"; fi
for executable in uv node npm; do
  command -v "$executable" >/dev/null || { echo "缺少 $executable，请先运行安装步骤。"; exit 1; }
done
career_log_dir="$career_root/.local/logs"
mkdir -p "$career_log_dir"
career_backend_pid=''
career_frontend_pid=''
cleanup() {
  [[ -z "$career_backend_pid" ]] || kill -- "-$career_backend_pid" 2>/dev/null || true
  [[ -z "$career_frontend_pid" ]] || kill -- "-$career_frontend_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
(
  cd "$career_root/app/apps/backend"
  export FRONTEND_BASE_URL=http://127.0.0.1:3000
  exec uv run --frozen python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
) >> "$career_log_dir/backend.log" 2>&1 &
career_backend_pid=$!
(
  cd "$career_root/app/apps/frontend"
  export NEXT_TELEMETRY_DISABLED=1
  exec npm run dev -- --hostname 127.0.0.1 --port 3000
) >> "$career_log_dir/frontend.log" 2>&1 &
career_frontend_pid=$!
echo "CareerLens：http://127.0.0.1:3000；接口文档：http://127.0.0.1:8000/docs"
echo "日志：$career_log_dir/backend.log 和 frontend.log"
echo "按 Ctrl+C 停止服务。"
while kill -0 "$career_backend_pid" 2>/dev/null && kill -0 "$career_frontend_pid" 2>/dev/null; do sleep 2; done
echo "一个服务已退出，请检查日志和 3000 / 8000 端口占用。"
tail -n 20 "$career_log_dir/backend.log" "$career_log_dir/frontend.log"
exit 1
