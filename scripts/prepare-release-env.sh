#!/usr/bin/env bash
set -Eeuo pipefail

# Creates a private release-specific environment file from the previous release
# and injects the immutable image and application identity. Values are updated
# without evaluating or printing any environment-file content.

prepare_release_env_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/release-worktree-integrity.sh
source "$prepare_release_env_dir/lib/release-worktree-integrity.sh"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/prepare-release-env.sh <previous-env> <release-env> <release-sha>
EOF
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

write_env_value() {
  local key="$1"
  local value="$2"
  local env_file="$3"
  local temp_file="${env_file}.tmp.$$"

  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    $0 ~ "^[[:space:]]*(export[[:space:]]+)?" key "=" {
      if (!found) print key "=" value
      found = 1
      next
    }
    { print }
    END { if (!found) print key "=" value }
  ' "$env_file" > "$temp_file"

  chmod 600 "$temp_file"
  mv -- "$temp_file" "$env_file"
}

validate_managed_env_value() {
  local key="$1"
  local expected_value="$2"
  local env_file="$3"
  local definition_count=""
  local actual_value=""

  definition_count="$(awk -v key="$key" '
    $0 ~ "^[[:space:]]*(export[[:space:]]+)?" key "=" { count++ }
    END { print count + 0 }
  ' "$env_file")"
  [[ "$definition_count" -eq 1 ]] ||
    fail "$key must appear exactly once in the prepared release environment."
  actual_value="$(awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$env_file")"
  [[ "$actual_value" == "$expected_value" ]] ||
    fail "$key does not match the candidate release SHA after preparation."
}

[[ "$#" -eq 3 ]] || {
  usage >&2
  exit 2
}

readonly previous_env="$1"
readonly release_env="$2"
readonly release_sha="$3"
readonly release_dir="$(dirname "$release_env")"

[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || fail "Release SHA must be a full lowercase 40-character commit SHA."
[[ -f "$previous_env" ]] || fail "Previous release environment file not found: $previous_env"
[[ -d "$release_dir" ]] || fail "Release directory not found: $release_dir"
validate_release_worktree_integrity "$release_dir" "$release_sha" ||
  fail "$release_worktree_integrity_error"

umask 077
install -m 600 "$previous_env" "$release_env"
write_env_value AL_LIO_IMAGE_TAG "$release_sha" "$release_env"
write_env_value AL_LIO_RELEASE_SHA "$release_sha" "$release_env"
chmod 600 "$release_env"
validate_managed_env_value AL_LIO_IMAGE_TAG "$release_sha" "$release_env"
validate_managed_env_value AL_LIO_RELEASE_SHA "$release_sha" "$release_env"

printf 'Prepared private release environment for %s.\n' "$release_sha"
