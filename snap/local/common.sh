# Shared helpers for the snap's hooks, services and commands. Sourced, not run.
#
# Layout:
#   $SNAP/bin              these scripts, nakama, caddy
#   $SNAP/modules          the server modules (index.js)
#   $SNAP/config           base Nakama config
#   $SNAP_DATA/secrets     generated and admin-provided secrets (root only)
#   $SNAP_DATA/nakama      generated Nakama config (readable by snap_daemon)
#   $SNAP_COMMON/postgresql/16/main   bundled database (snap_daemon, 0700)
#   $SNAP_COMMON/backups   nightly database dumps
#   $SNAP_COMMON/caddy     TLS certificates
#
# Strict confinement gives root no CAP_DAC_OVERRIDE, so files that services
# running as snap_daemon must read are written by root and then handed over
# with write_for_daemon (write, chown, rename), never edited in place.

# Variables here are used by the scripts that source this file.
# shellcheck disable=SC2034
set -euo pipefail

# snap_daemon is the shared system user snapd creates for system-usernames.
DAEMON_UID=584788
PG_MAJOR=16
PG_BIN="$SNAP/usr/lib/postgresql/$PG_MAJOR/bin"
PGDATA="$SNAP_COMMON/postgresql/$PG_MAJOR/main"
SECRETS="$SNAP_DATA/secrets"
NAKAMA_DIR="$SNAP_DATA/nakama"
BACKUP_DIR="$SNAP_COMMON/backups"

export LC_ALL=C.UTF-8
export PATH="$SNAP/bin:$SNAP/usr/bin:$PATH"
# Libraries staged from Ubuntu packages (PostgreSQL, jq). aarch64 and x86_64
# match their Debian multiarch names.
LD_LIBRARY_PATH="$SNAP/usr/lib/$(uname -m)-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export LD_LIBRARY_PATH

log() {
  echo "$*" >&2
}

# cfg KEY DEFAULT: a snap config value, or DEFAULT when unset.
cfg() {
  local v
  v="$(snapctl get "$1" 2>/dev/null || true)"
  if [ -z "$v" ]; then
    echo "${2:-}"
  else
    echo "$v"
  fi
}

as_daemon() {
  setpriv --clear-groups --reuid "$DAEMON_UID" --regid "$DAEMON_UID" -- "$@"
}

random_hex() {
  od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
}

secret_path() {
  echo "$SECRETS/$1"
}

secret_get() {
  local f
  f="$(secret_path "$1")"
  if [ -s "$f" ]; then
    cat "$f"
  fi
}

secret_set() {
  mkdir -p "$SECRETS"
  chmod 0700 "$SECRETS"
  local tmp
  tmp="$(mktemp "$SECRETS/.tmp.XXXXXX")"
  printf '%s' "$2" >"$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$(secret_path "$1")"
}

# Generate a secret once; keep it across restarts and refreshes.
secret_ensure() {
  if [ -z "$(secret_get "$1")" ]; then
    secret_set "$1" "$(random_hex "${2:-32}")"
  fi
}

ensure_secrets() {
  secret_ensure session-encryption-key 32
  secret_ensure session-refresh-encryption-key 32
  secret_ensure console-signing-key 32
  secret_ensure console-password 12
  secret_ensure runtime-http-key 32
  secret_ensure postgres-password 24
  secret_ensure nakama-db-password 24
}

# write_for_daemon PATH: copy stdin to PATH, owned by snap_daemon, mode 0600.
write_for_daemon() {
  local dest="$1" dir tmp
  dir="$(dirname "$dest")"
  mkdir -p "$dir"
  tmp="$(mktemp "$dir/.tmp.XXXXXX")"
  cat >"$tmp"
  chmod 0600 "$tmp"
  chown "$DAEMON_UID:$DAEMON_UID" "$tmp"
  mv -f "$tmp" "$dest"
}

# daemon_dir PATH [MODE]: create a directory owned by snap_daemon. Root may
# not change it afterwards (no CAP_FOWNER), so an existing one is left alone.
daemon_dir() {
  if [ ! -d "$1" ]; then
    mkdir -p "$1"
    chmod "${2:-0700}" "$1"
    chown "$DAEMON_UID:$DAEMON_UID" "$1"
  fi
}

role() {
  cfg role all
}

# The database URL Nakama uses: an external one if the admin set it,
# otherwise the bundled PostgreSQL.
external_db_url() {
  secret_get database-url
}

uses_bundled_db() {
  [ "$(role)" != "api" ] && [ -z "$(external_db_url)" ]
}

db_port() {
  cfg postgres.port 5432
}

nakama_db_url() {
  local ext
  ext="$(external_db_url)"
  if [ -n "$ext" ]; then
    echo "$ext"
  else
    echo "nakama:$(secret_get nakama-db-password)@127.0.0.1:$(db_port)/nakama?sslmode=disable"
  fi
}

# YAML double-quoted string.
yq() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

# Runtime env for the modules, one KEY=VALUE per line, from snap config:
#   games.<id>.<setting>   -> GAME_<ID>_<SETTING>
#   blobs.<setting>        -> S3_<SETTING> (secret key comes from secrets)
#   shares.hide-threshold  -> SHARE_HIDE_THRESHOLD
runtime_env() {
  snapctl get -d games 2>/dev/null | jq -r '
    (.games // {}) | to_entries[] | .key as $g | (.value // {}) | to_entries[]
    | "GAME_\($g | ascii_upcase | gsub("-"; "_"))_\(.key | ascii_upcase | gsub("-"; "_"))=\(.value)"' || true
  local k v
  for k in endpoint region bucket access-key-id public-url virtual-host internal-endpoint; do
    v="$(cfg "blobs.$k")"
    if [ -n "$v" ]; then
      echo "S3_$(echo "$k" | tr 'a-z-' 'A-Z_')=$v"
    fi
  done
  v="$(secret_get s3-secret-access-key)"
  if [ -n "$v" ]; then
    echo "S3_SECRET_ACCESS_KEY=$v"
  fi
  v="$(cfg shares.hide-threshold)"
  if [ -n "$v" ]; then
    echo "SHARE_HIDE_THRESHOLD=$v"
  fi
}

modules_path() {
  # Community servers can drop in their own build of the modules.
  if [ -f "$SNAP_COMMON/modules/index.js" ]; then
    echo "$SNAP_COMMON/modules"
  else
    echo "$SNAP/modules"
  fi
}

api_address() {
  local default="0.0.0.0"
  if [ -n "$(cfg domain)" ]; then
    default="127.0.0.1"
  fi
  cfg api.address "$default"
}

wait_for_postgres() {
  local _
  for _ in $(seq 1 60); do
    if "$PG_BIN/pg_isready" -q -h 127.0.0.1 -p "$(db_port)"; then
      return 0
    fi
    sleep 1
  done
  log "PostgreSQL did not become ready on port $(db_port)"
  return 1
}

# Run SQL as the bundled database's superuser.
psql_admin() {
  PGPASSWORD="$(secret_get postgres-password)" "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 \
    -h 127.0.0.1 -p "$(db_port)" -U postgres "$@"
}

# Create Nakama's role and database in the bundled PostgreSQL (idempotent).
# SQL goes through stdin so the password never appears in a process list.
ensure_nakama_db() {
  wait_for_postgres
  if ! psql_admin -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'nakama'" | grep -q 1; then
    log "Creating the nakama database role"
    echo "CREATE ROLE nakama LOGIN PASSWORD '$(secret_get nakama-db-password)'" | psql_admin -d postgres
  fi
  if ! psql_admin -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'nakama'" | grep -q 1; then
    log "Creating the nakama database"
    psql_admin -d postgres -c "CREATE DATABASE nakama OWNER nakama ENCODING 'UTF8' TEMPLATE template0"
  fi
}
