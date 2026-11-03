#!/usr/bin/env bash
# 每日备份 cron 安装脚本（fix-261104-01 / issue #56）
#
# 设计原则：**默认只打印，不装**。运维看一眼确认后再 `--install`。
#   bash scripts/install-backup-cron.sh            # 只打印将要追加的 cron 行（默认）
#   bash scripts/install-backup-cron.sh --install  # 真的写入 crontab（幂等：已存在则不加）
#   bash scripts/install-backup-cron.sh --check    # 只检查是否已安装（已装退出码 0，未装 1）
#
# 幂等实现：整行 `grep -Fqx` 精确匹配；同一行已存在 ⇒ 直接跳过，不重复追加。
# ⚠ 脚本不碰 crontab 以外的东西：不重启容器、不改 compose、不建目录（日志目录只提示）。
# ⚠ 本机 crontab 是**本地时区（UTC+8）**，所以 20 3 = 每天 03:20（UTC+8）。
set -uo pipefail

CRON_LINE="${BACKUP_CRON_LINE:-20 3 * * * docker exec meeting_asr_app-app-1 node /app/scripts/db-backup.mjs >> /home/eric/logs/meeting-asr-backup.log 2>&1}"
LOG_PATH="${BACKUP_LOG_PATH:-/home/eric/logs/meeting-asr-backup.log}"
LOG_DIR="$(dirname "$LOG_PATH")"
MODE="print"

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --install) MODE="install" ;;
    --check) MODE="check" ;;
    --help|-h) usage; exit 0 ;;
    *)
      echo "[install-backup-cron] 未知参数: $arg（支持 --install / --check / --help）" >&2
      exit 2
      ;;
  esac
done

crontab_available() {
  command -v crontab >/dev/null 2>&1
}

current_crontab() {
  crontab -l 2>/dev/null || true
}

already_installed() {
  current_crontab | grep -Fqx -- "$CRON_LINE"
}

case "$MODE" in
  print)
    cat <<EOF
[install-backup-cron] 将追加这一行到当前用户 crontab（默认不写，确认后加 --install）：

$CRON_LINE

说明：
  - 时区：本机 crontab 为本地时间（UTC+8）⇒ 每天 03:20 执行
  - 日志：$LOG_PATH（目录需存在：mkdir -p $LOG_DIR）
  - 成功判据：日志里出现 \`RESULT: OK\` 行；失败为 \`RESULT: FAIL code=...\` 且退出码 1
  - 手动先验一次：docker exec meeting_asr_app-app-1 node /app/scripts/db-backup.mjs
EOF
    exit 0
    ;;
  check)
    if ! crontab_available; then
      echo "[install-backup-cron] 本机没有 crontab 命令" >&2
      exit 1
    fi
    if already_installed; then
      echo "[install-backup-cron] 已安装：$CRON_LINE"
      exit 0
    fi
    echo "[install-backup-cron] 未安装"
    exit 1
    ;;
  install)
    if ! crontab_available; then
      echo "[install-backup-cron] 本机没有 crontab 命令，无法安装" >&2
      exit 1
    fi
    if already_installed; then
      echo "[install-backup-cron] 已存在同一行，跳过（幂等）"
      exit 0
    fi
    if [ ! -d "$LOG_DIR" ]; then
      echo "[install-backup-cron] ⚠ 日志目录不存在：$LOG_DIR（cron 会静默失败，请先 mkdir -p）" >&2
    fi
    { current_crontab; printf '%s\n' "$CRON_LINE"; } | crontab -
    if already_installed; then
      echo "[install-backup-cron] 已安装：$CRON_LINE"
      exit 0
    fi
    echo "[install-backup-cron] 安装后校验失败，请手动检查 crontab -l" >&2
    exit 1
    ;;
esac
