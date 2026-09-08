#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

# This command is installed outside release worktrees as the forced command for
# the dedicated GitHub Actions SSH key. It accepts only `deploy <full-main-SHA>`
# and bootstraps the deployment controller from immutable Git objects at that
# SHA before executing any release-provided code.
readonly PATH="/usr/local/bin:/usr/bin:/bin"
readonly DEFAULT_REPOSITORY_DIR="/srv/danicode/projects/al-lio"
readonly DEFAULT_RELEASES_DIR="/srv/danicode/releases"
readonly CANONICAL_REPOSITORY_URL="https://github.com/danielgarciaortega-dev/al-lio.git"
readonly -a TRUSTED_CONTROLLER_FILES=(
  "scripts/deploy-production.sh:100755"
  "scripts/lib/production-transition-policy.sh:100644"
  "scripts/lib/compose-env-guard.sh:100644"
  "scripts/lib/release-worktree-integrity.sh:100644"
  "scripts/prepare-release-env.sh:100644"
)

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

harden_git_environment() {
  unset \
    GIT_DIR \
    GIT_WORK_TREE \
    GIT_COMMON_DIR \
    GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES \
    GIT_INDEX_FILE \
    GIT_NAMESPACE \
    GIT_REPLACE_REF_BASE \
    GIT_EXTERNAL_DIFF \
    GIT_DIFF_OPTS \
    GIT_CONFIG \
    GIT_CONFIG_SYSTEM \
    GIT_CONFIG_PARAMETERS \
    GIT_ASKPASS \
    SSH_ASKPASS

  export GIT_NO_REPLACE_OBJECTS=1
  export GIT_GRAFT_FILE=/dev/null
  export GIT_CONFIG_NOSYSTEM=1
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_ATTR_NOSYSTEM=1
  export GIT_TERMINAL_PROMPT=0

  # Command-scope configuration outranks mutable repository configuration.
  # Hooks and fsmonitor are disabled because both can execute local programs;
  # the canonical remote prevents the historical checkout URL from becoming a
  # trust decision; unsafe local transports and credential helpers are disabled.
  export GIT_CONFIG_COUNT=6
  export GIT_CONFIG_KEY_0=core.hooksPath
  export GIT_CONFIG_VALUE_0=/dev/null
  export GIT_CONFIG_KEY_1=core.fsmonitor
  export GIT_CONFIG_VALUE_1=false
  export GIT_CONFIG_KEY_2=remote.origin.url
  export GIT_CONFIG_VALUE_2="$CANONICAL_REPOSITORY_URL"
  export GIT_CONFIG_KEY_3=protocol.ext.allow
  export GIT_CONFIG_VALUE_3=never
  export GIT_CONFIG_KEY_4=protocol.file.allow
  export GIT_CONFIG_VALUE_4=never
  export GIT_CONFIG_KEY_5=credential.helper
  export GIT_CONFIG_VALUE_5=""
}

validate_repository_git_metadata() {
  local git_dir=""
  local dangerous_config=""

  git_dir="$(git -C "$repository_dir" rev-parse --absolute-git-dir)" ||
    fail "Cannot resolve the canonical repository Git directory."
  git_dir="$(readlink -f -- "$git_dir")"
  [[ -n "$git_dir" && -d "$git_dir" ]] || fail "Invalid canonical repository Git directory."

  # Repository-local attributes can select executable clean/smudge filters.
  # Global/system attributes are already disabled by harden_git_environment.
  [[ ! -s "$git_dir/info/attributes" ]] ||
    fail "Repository-local info/attributes is not permitted for production deployment."

  dangerous_config="$(
    git -C "$repository_dir" config --get-regexp \
      '^(url\..*\.insteadof|core\.attributesfile|filter\..*\.(clean|smudge|process|required)|diff\.external|diff\..*\.(command|textconv))$' \
      2>/dev/null || true
  )"
  [[ -z "$dangerous_config" ]] ||
    fail "Repository Git configuration contains production-unsafe executable or URL-rewrite settings."
}

materialize_controller_file() {
  local path="$1"
  local expected_mode="$2"
  local metadata=""
  local entry_path=""
  local mode=""
  local type=""
  local object=""
  local target_path="$controller_dir/$path"

  IFS=$'\t' read -r metadata entry_path < <(
    git -C "$repository_dir" ls-tree "$release_sha" -- "$path"
  )
  read -r mode type object <<< "$metadata"

  if [[ "$entry_path" != "$path" || "$mode" != "$expected_mode" || "$type" != "blob" ||
    ! "$object" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]]; then
    fail "Trusted deployment controller path is not the expected Git blob: $path"
  fi

  mkdir -p -- "$(dirname "$target_path")"
  git -C "$repository_dir" cat-file blob "$object" > "$target_path"
  if [[ "$(git hash-object --no-filters "$target_path")" != "$object" ]]; then
    fail "Trusted deployment controller blob changed while materializing: $path"
  fi

  if [[ "$expected_mode" == "100755" ]]; then
    chmod 700 "$target_path"
  else
    chmod 600 "$target_path"
  fi
}

cleanup_controller() {
  if [[ -n "${controller_dir:-}" && -d "$controller_dir" ]]; then
    rm -rf -- "$controller_dir"
  fi
}

original_command="${SSH_ORIGINAL_COMMAND:-}"
[[ "$original_command" =~ ^deploy[[:space:]]([0-9a-f]{40})$ ]] ||
  fail "This SSH key accepts only: deploy <full-40-character-main-commit-sha>"

release_sha="${BASH_REMATCH[1]}"
repository_dir="${AL_LIO_REPOSITORY_DIR:-$DEFAULT_REPOSITORY_DIR}"
releases_dir="${AL_LIO_RELEASES_DIR:-$DEFAULT_RELEASES_DIR}"
controller_dir=""

harden_git_environment

for command_name in git docker readlink dirname mktemp mkdir chmod rm; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Required command not found: $command_name"
done

[[ "$(id -u)" -ne 0 ]] || fail "The deployment entrypoint must not run as root."
[[ -d "$repository_dir/.git" ]] || fail "Repository not found at $repository_dir"
repository_dir="$(readlink -f -- "$repository_dir")"
releases_dir="$(readlink -f -- "$releases_dir")"
[[ -n "$repository_dir" && "$repository_dir" != "/" ]] || fail "Invalid repository directory."
[[ -n "$releases_dir" && "$releases_dir" != "/" ]] || fail "Invalid releases directory."
validate_repository_git_metadata

compose_dir="$(docker inspect al_lio_web --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')"
[[ -n "$compose_dir" ]] || fail "The production web container has no Compose working-directory label."
release_dir="$(readlink -f -- "$(dirname "$compose_dir")")"
case "$release_dir" in
  "$releases_dir"/al-lio-*) ;;
  *) fail "Current production release is outside $releases_dir: $release_dir" ;;
esac

git -C "$repository_dir" fetch --tags origin \
  "+refs/heads/main:refs/remotes/origin/main"
git -C "$repository_dir" cat-file -e "${release_sha}^{commit}" ||
  fail "Requested release is not a Git commit available from the canonical repository."
git -C "$repository_dir" merge-base --is-ancestor "$release_sha" origin/main ||
  fail "Requested release is not reachable from origin/main."

controller_dir="$(mktemp -d "${TMPDIR:-/tmp}/al-lio-deploy-controller.XXXXXXXXXX")"
chmod 700 "$controller_dir"
trap cleanup_controller EXIT INT TERM

for controller_spec in "${TRUSTED_CONTROLLER_FILES[@]}"; do
  IFS=: read -r controller_path controller_mode <<< "$controller_spec"
  materialize_controller_file "$controller_path" "$controller_mode"
done

(
  cd "$controller_dir"
  AL_LIO_DEPLOY_CONFIRMATION="$release_sha" \
    ./scripts/deploy-production.sh "$release_sha"
)
