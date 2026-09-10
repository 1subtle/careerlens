#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# Internal port configuration for single-port deployment.
FRONTEND_PORT="3000"
BACKEND_PORT="8000"

# Print banner
print_banner() {
    echo -e "${CYAN}"
    cat << 'EOF'

 ██████╗ ███████╗███████╗██╗   ██╗███╗   ███╗███████╗
 ██╔══██╗██╔════╝██╔════╝██║   ██║████╗ ████║██╔════╝
 ██████╔╝█████╗  ███████╗██║   ██║██╔████╔██║█████╗
 ██╔══██╗██╔══╝  ╚════██║██║   ██║██║╚██╔╝██║██╔══╝
 ██║  ██║███████╗███████║╚██████╔╝██║ ╚═╝ ██║███████╗
 ╚═╝  ╚═╝╚══════╝╚══════╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝

 ███╗   ███╗ █████╗ ████████╗ ██████╗██╗  ██╗███████╗██████╗
 ████╗ ████║██╔══██╗╚══██╔══╝██╔════╝██║  ██║██╔════╝██╔══██╗
 ██╔████╔██║███████║   ██║   ██║     ███████║█████╗  ██████╔╝
 ██║╚██╔╝██║██╔══██║   ██║   ██║     ██╔══██║██╔══╝  ██╔══██╗
 ██║ ╚═╝ ██║██║  ██║   ██║   ╚██████╗██║  ██║███████╗██║  ██║
 ╚═╝     ╚═╝╚═╝  ╚═╝   ╚═╝    ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝

EOF
    echo -e "${NC}"
    echo -e "${BOLD}        Crazy Stuff with Resumes and Cover letters${NC}"
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

# Print status message
status() {
    echo -e "${GREEN}[✓]${NC} $1" >&2
}

# Print info message
info() {
    echo -e "${BLUE}[i]${NC} $1" >&2
}

# Print warning message
warn() {
    echo -e "${YELLOW}[!]${NC} $1" >&2
}

# Print error message
error() {
    echo -e "${RED}[✗]${NC} $1" >&2
}

# Docker-style secret loader: supports VAR or VAR_FILE
file_env() {
    local var="$1"
    local def="${2:-}"
    local file_var="${var}_FILE"

    if [ -n "${!var:-}" ] && [ -n "${!file_var:-}" ]; then
        error "Both $var and $file_var are set (but are exclusive)"
        exit 1
    fi

    local val="$def"
    if [ -n "${!var:-}" ]; then
        val="${!var}"
    elif [ -n "${!file_var:-}" ]; then
        if [ ! -r "${!file_var}" ]; then
            error "Cannot read ${!file_var} for $file_var"
            exit 1
        fi
        val="$(< "${!file_var}")"
    fi

    export "$var"="$val"
    unset "$file_var"
}

normalize_log_level() {
    local value="${1^^}"
    local fallback="${2}"
    local name="${3}"

    case "$value" in
        CRITICAL|ERROR|WARNING|INFO|DEBUG)
            echo "$value"
            ;;
        *)
            warn "Invalid ${name}='$1', using ${fallback}"
            echo "$fallback"
            ;;
    esac
}

# Cleanup function for graceful shutdown
cleanup() {
    local exit_code=$?
    # Prevent re-entry from signals during cleanup
    trap - EXIT
    trap '' SIGTERM SIGINT SIGQUIT

    echo "" >&2
    info "Shutting down Resume Matcher..."

    # Stop both children before waiting for either one to finish.
    local pid
    for pid in "$FRONTEND_PID" "$BACKEND_PID"; do
        if [ -n "$pid" ]; then
            kill "$pid" 2>/dev/null || true
        fi
    done
    for pid in "$FRONTEND_PID" "$BACKEND_PID"; do
        if [ -n "$pid" ]; then
            wait "$pid" 2>/dev/null || true
        fi
    done

    status "Shutdown complete"
    exit "$exit_code"
}

wait_for_service() {
    local name="$1" pid="$2" url="$3" i
    for i in {1..30}; do
        if ! kill -0 "$pid" 2>/dev/null; then
            error "$name process (PID: $pid) died during startup"
            return 1
        fi
        if curl -fsS --max-time 2 "$url" > /dev/null 2>&1; then
            status "$name is ready (PID: $pid)"
            return 0
        fi
        sleep 1
    done
    error "$name failed readiness checks"
    return 1
}

# Initialize PIDs so cleanup doesn't fail on early exit
BACKEND_PID=""
FRONTEND_PID=""

# Set up signal handlers
trap cleanup EXIT
trap 'exit 0' SIGTERM SIGINT SIGQUIT

# Print banner
print_banner

# Display routing configuration
info "Routing configuration:"
echo -e "  Public port:   ${BOLD}${FRONTEND_PORT}${NC}"
echo -e "  Internal API:  ${BOLD}${BACKEND_PORT}${NC} (proxied at /api)"
echo ""

# Resolve env vars and optional *_FILE secret mounts
info "Loading configuration from environment and *_FILE secrets..."
file_env "LOG_LEVEL" "INFO"
file_env "LOG_LLM" "WARNING"

file_env "LLM_PROVIDER" "openai"

# Only resolve optional LLM_* vars if they (or their *_FILE variants) are provided,
# so we don't override backend defaults with empty strings.
if [ -n "${LLM_MODEL:-}" ] || [ -n "${LLM_MODEL_FILE:-}" ]; then
    file_env "LLM_MODEL"
fi

if [ -n "${LLM_API_KEY:-}" ] || [ -n "${LLM_API_KEY_FILE:-}" ]; then
    file_env "LLM_API_KEY"
fi

if [ -n "${LLM_API_BASE:-}" ] || [ -n "${LLM_API_BASE_FILE:-}" ]; then
    file_env "LLM_API_BASE"
fi
APP_LOG_LEVEL="$(normalize_log_level "${LOG_LEVEL}" "INFO" "LOG_LEVEL")"
LLM_LOG_LEVEL="$(normalize_log_level "${LOG_LLM}" "WARNING" "LOG_LLM")"
export LOG_LEVEL="${APP_LOG_LEVEL}"
export LOG_LLM="${LLM_LOG_LEVEL}"
UVICORN_LOG_LEVEL="$(echo "${APP_LOG_LEVEL}" | tr '[:upper:]' '[:lower:]')"
info "Application log level: ${BOLD}${LOG_LEVEL}${NC}"
info "LiteLLM log level:     ${BOLD}${LOG_LLM}${NC}"
if [ "${LOG_LLM}" = "DEBUG" ]; then
    warn "LOG_LLM=DEBUG may log API keys in plaintext. Do not use in production."
fi
status "Configuration loaded"

# Check and create data directory
info "Checking data directory..."
export DATA_DIR="${DATA_DIR:-/app/backend/data}"
if [ ! -d "$DATA_DIR" ]; then
    mkdir -p "$DATA_DIR"
    status "Created data directory: $DATA_DIR"
else
    status "Data directory exists: $DATA_DIR"
fi

# Restore missing or damaged model files from the image, without network access.
info "Preparing local embedding model..."
cd /app/backend
python - <<'PY'
import hashlib
import shutil
from pathlib import Path

from app.config import settings
from app.services.semantic import FILES, model_dir

directory = model_dir()
seed = Path("/opt/careerlens-seed") / directory.relative_to(settings.data_dir)
for name, expected in FILES.items():
    target = directory / name
    if target.is_file():
        with target.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() == expected:
                continue
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".part")
    shutil.copyfile(seed / name, temporary)
    temporary.replace(target)
PY
status "Local embedding model is ready"

# Verify Chromium can actually launch; missing libraries must fail startup.
info "Checking Playwright browsers..."
python -c "from playwright.sync_api import sync_playwright; p = sync_playwright().start(); browser = p.chromium.launch(headless=True); browser.close(); p.stop()"
status "Playwright Chromium is ready"

# Start backend
echo ""
info "Starting backend server on internal port ${BACKEND_PORT}..."
cd /app/backend
python -m uvicorn app.main:app --host 127.0.0.1 --port "${BACKEND_PORT}" --proxy-headers --forwarded-allow-ips 127.0.0.1 --log-level "${UVICORN_LOG_LEVEL}" &
BACKEND_PID=$!

# Wait for backend to be ready
info "Waiting for backend to be ready..."
wait_for_service "Backend" "$BACKEND_PID" "http://127.0.0.1:${BACKEND_PORT}/api/v1/health"

# Start frontend
echo ""
info "Starting frontend server on port ${FRONTEND_PORT}..."
cd /app/frontend

# Next.js uses PORT environment variable
export HOSTNAME="0.0.0.0"
export PORT="${FRONTEND_PORT}"
if [ ! -f "server.js" ]; then
    error "Missing frontend standalone server.js. Rebuild the Docker image."
    exit 1
fi

node server.js "$@" &
FRONTEND_PID=$!
wait_for_service "Frontend" "$FRONTEND_PID" "http://127.0.0.1:${FRONTEND_PORT}/"

# Wait for either process to exit, but ignore errexit for this wait
set +e
wait -n "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null
EXIT_CODE=$?
set -e
warn "A process exited unexpectedly (exit code: ${EXIT_CODE}), shutting down..."
# A server exiting by itself, even successfully, requires a container restart.
if [ "$EXIT_CODE" -eq 0 ]; then
    EXIT_CODE=1
fi
exit "$EXIT_CODE"
