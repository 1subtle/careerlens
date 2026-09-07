#!/usr/bin/env bash
set -euo pipefail
career_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$career_root/.local/runtime.env" ]]; then source "$career_root/.local/runtime.env"; fi
for executable in uv node npm; do
  command -v "$executable" >/dev/null || { echo "缺少 $executable，请按 README 安装运行环境。"; exit 1; }
done
cd "$career_root/app/apps/backend"
uv sync --frozen --extra dev
uv run --frozen python -m playwright install chromium
uv run --frozen python -m app.scripts.career_data init
cd "$career_root/app/apps/frontend"
npm ci --no-audit --no-fund
echo "依赖与数据库已准备好。运行 bash scripts/dev.sh 启动。"
