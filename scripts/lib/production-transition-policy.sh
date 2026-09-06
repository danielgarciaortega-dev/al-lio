#!/usr/bin/env bash

# One fail-closed policy for validating an exact current-production SHA against
# a candidate SHA. The deploy command, behavioral tests, and future CI checks
# all call validate_production_transition rather than reproducing these rules.

production_transition_error=""
production_transition_allowed_compose_additions=()
production_transition_allowed_compose_removals=()
production_transition_staged_compose_removal_approvals=()
production_transition_consumed_compose_removal_approvals=()
production_transition_revoked_compose_removal_approvals=()
production_transition_added_migrations=()
production_transition_validated_blob_object=""

readonly PRODUCTION_TRANSITION_COMPOSE_FILE="infra/docker-compose.prod.yml"
readonly PRODUCTION_TRANSITION_APPROVALS_REPO_PATH="scripts/config/production-compose-env-removals.allowlist"
readonly -a PRODUCTION_TRANSITION_PROTECTED_CONTROL_PLANE=(
  ".dockerignore"
  ".github/workflows/ci.yml"
  ".github/workflows/deploy-production.yml"
  "scripts/deploy-production.sh"
  "scripts/github-actions-deploy-entrypoint.sh"
  "scripts/lib/production-transition-policy.sh"
  "scripts/lib/compose-env-guard.sh"
  "scripts/lib/release-worktree-integrity.sh"
  "scripts/prepare-release-env.sh"
  "scripts/validate-production-transition.sh"
  "scripts/validate-production-deploy-readiness.mjs"
  "scripts/postgres"
  "infra/postgres/schema.sql"
  "infra/postgres/baseline.sha256"
)

production_transition_policy_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/compose-env-guard.sh
source "$production_transition_policy_dir/compose-env-guard.sh"

production_transition_reject() {
  production_transition_error="$1"
  return 1
}

validate_regular_git_blob() {
  local repository="$1"
  local sha="$2"
  local path="$3"
  local label="$4"
  local tree_entry=""
  local mode=""
  local type=""
  local object=""
  local listed_path=""

  tree_entry="$(git -C "$repository" ls-tree "$sha" -- "$path")"
  [[ -n "$tree_entry" ]] ||
    production_transition_reject "$label is missing: $path" || return 1
  IFS=$' \t' read -r mode type object listed_path <<< "$tree_entry"
  [[ "$mode" == "100644" && "$type" == "blob" && -n "$object" && "$listed_path" == "$path" ]] ||
    production_transition_reject "$label must be one regular non-executable 100644 blob, found mode=${mode:-missing} type=${type:-missing}: $path" || return 1
  production_transition_validated_blob_object="$object"
}

validate_production_transition() {
  local repository="$1"
  local current_sha="$2"
  local candidate_sha="$3"
  local main_ref="${4:-origin/main}"
  local current_approval_data=""
  local candidate_approval_data=""
  local protected_control_plane_changes=""
  local blocked_runtime_changes=""
  local migration_changes=""
  local change_status=""
  local migration_path=""
  local migration_object=""
  local extra_path=""
  local migration_sql=""

  production_transition_error=""
  production_transition_allowed_compose_additions=()
  production_transition_allowed_compose_removals=()
  production_transition_staged_compose_removal_approvals=()
  production_transition_consumed_compose_removal_approvals=()
  production_transition_revoked_compose_removal_approvals=()
  production_transition_added_migrations=()
  production_transition_validated_blob_object=""

  [[ "$current_sha" =~ ^[0-9a-f]{40}$ ]] ||
    production_transition_reject "Current production SHA must be a full lowercase 40-character commit SHA." || return 1
  [[ "$candidate_sha" =~ ^[0-9a-f]{40}$ ]] ||
    production_transition_reject "Candidate SHA must be a full lowercase 40-character commit SHA." || return 1
  git -C "$repository" cat-file -e "${current_sha}^{commit}" 2>/dev/null ||
    production_transition_reject "Current production commit does not exist: $current_sha" || return 1
  git -C "$repository" cat-file -e "${candidate_sha}^{commit}" 2>/dev/null ||
    production_transition_reject "Candidate commit does not exist: $candidate_sha" || return 1
  git -C "$repository" rev-parse --verify "${main_ref}^{commit}" >/dev/null 2>&1 ||
    production_transition_reject "Main reference does not resolve to a commit: $main_ref" || return 1
  git -C "$repository" merge-base --is-ancestor "$candidate_sha" "$main_ref" ||
    production_transition_reject "The candidate commit is not reachable from $main_ref." || return 1
  git -C "$repository" merge-base --is-ancestor "$current_sha" "$candidate_sha" ||
    production_transition_reject "The candidate commit would be a downgrade or divergent release. Use the rollback runbook instead." || return 1

  validate_regular_git_blob "$repository" "$current_sha" "$PRODUCTION_TRANSITION_APPROVALS_REPO_PATH" "Current release policy data" || return 1
  validate_regular_git_blob "$repository" "$candidate_sha" "$PRODUCTION_TRANSITION_APPROVALS_REPO_PATH" "Candidate release policy data" || return 1
  current_approval_data="$(git -C "$repository" show "$current_sha:$PRODUCTION_TRANSITION_APPROVALS_REPO_PATH")" ||
    production_transition_reject "Cannot read current release policy data: $PRODUCTION_TRANSITION_APPROVALS_REPO_PATH" || return 1
  candidate_approval_data="$(git -C "$repository" show "$candidate_sha:$PRODUCTION_TRANSITION_APPROVALS_REPO_PATH")" ||
    production_transition_reject "Cannot read candidate release policy data: $PRODUCTION_TRANSITION_APPROVALS_REPO_PATH" || return 1

  protected_control_plane_changes="$(git -C "$repository" diff --name-only "$current_sha" "$candidate_sha" -- \
    "${PRODUCTION_TRANSITION_PROTECTED_CONTROL_PLANE[@]}")"
  if [[ -n "$protected_control_plane_changes" ]]; then
    production_transition_reject "This routine release changes the protected production control-plane: ${protected_control_plane_changes//$'\n'/, }. Follow docs/operations/DEPLOY_VPS.md as an explicitly reviewed exceptional transition." || return 1
  fi

  blocked_runtime_changes="$(git -C "$repository" diff --name-only "$current_sha" "$candidate_sha" -- \
    infra/Dockerfile data/learning-competencies.json scripts/import-learning-competencies.mjs)"
  if [[ -n "$blocked_runtime_changes" ]]; then
    production_transition_reject "This release changes infrastructure or an operator-managed catalogue: ${blocked_runtime_changes//$'\n'/, }. Follow docs/operations/DEPLOY_VPS.md manually." || return 1
  fi

  if ! validate_compose_env_transition \
    "$repository" \
    "$current_sha" \
    "$candidate_sha" \
    "$PRODUCTION_TRANSITION_COMPOSE_FILE" \
    "$current_approval_data" \
    "$candidate_approval_data"; then
    production_transition_reject "Docker Compose changed outside the approved service environment transition policy: $compose_env_guard_error Follow docs/operations/DEPLOY_VPS.md manually." || return 1
  fi
  production_transition_allowed_compose_additions=("${allowed_compose_env_mappings[@]}")
  production_transition_allowed_compose_removals=("${allowed_compose_env_removals[@]}")
  production_transition_staged_compose_removal_approvals=("${staged_compose_env_removal_approvals[@]}")
  production_transition_consumed_compose_removal_approvals=("${consumed_compose_env_removal_approvals[@]}")
  production_transition_revoked_compose_removal_approvals=("${revoked_compose_env_removal_approvals[@]}")

  migration_changes="$(git -C "$repository" diff --name-status "$current_sha" "$candidate_sha" -- infra/postgres/migrations)"
  if [[ -n "$migration_changes" ]]; then
    while IFS=$'\t' read -r change_status migration_path extra_path; do
      [[ -n "$change_status" ]] || continue
      [[ "$change_status" == "A" && -z "${extra_path:-}" ]] ||
        production_transition_reject "Applied migration history changed ($change_status $migration_path). Existing migrations are immutable." || return 1
      [[ "$migration_path" =~ ^infra/postgres/migrations/[0-9]{4}_[a-z0-9_]+\.sql$ ]] ||
        production_transition_reject "Unexpected migration file: $migration_path" || return 1
      validate_regular_git_blob "$repository" "$candidate_sha" "$migration_path" "New migration" || return 1
      migration_object="$production_transition_validated_blob_object"
      if ! migration_sql="$(git -C "$repository" cat-file blob "$migration_object")"; then
        production_transition_reject "Cannot read validated candidate migration blob $migration_object: $migration_path" || return 1
      fi
      if grep -Eiq '(^|[^[:alnum:]_])(drop[[:space:]]+(table|schema|column|index)|truncate[[:space:]]+table|delete[[:space:]]+from|alter[[:space:]]+table[^;]*(drop[[:space:]]+column|alter[[:space:]]+column|rename[[:space:]]))([^[:alnum:]_]|$)' <<< "$migration_sql"; then
        production_transition_reject "Migration $migration_path contains a destructive or structural statement that requires the manual runbook." || return 1
      fi
      production_transition_added_migrations+=("$migration_path")
    done <<< "$migration_changes"
  fi
}

print_approval_records() {
  local heading="$1"
  shift
  local record=""
  local service=""
  local key=""
  local source_key=""
  local default_value=""

  [[ "$#" -gt 0 ]] || return 0
  printf '%s\n' "$heading"
  for record in "$@"; do
    IFS='|' read -r service key source_key default_value <<< "$record"
    printf '  - service=%s destination=%s source=%s default=%s\n' \
      "$service" "$key" "$source_key" "${default_value:-<empty>}"
  done
}

print_production_transition_summary() {
  local current_sha="$1"
  local candidate_sha="$2"

  printf 'Current release: %s\nCandidate release: %s\n' "$current_sha" "$candidate_sha"
  if [[ "${#production_transition_allowed_compose_additions[@]}" -gt 0 ]]; then
    printf 'Approved service environment additions (inactive until configured):\n'
    printf '  - %s\n' "${production_transition_allowed_compose_additions[@]}"
  fi
  if [[ "${#production_transition_allowed_compose_removals[@]}" -gt 0 ]]; then
    printf 'Consumed service environment removal approvals:\n'
    printf '  - %s\n' "${production_transition_allowed_compose_removals[@]}"
  fi
  print_approval_records \
    "STAGED PRODUCTION COMPOSE REMOVAL APPROVALS:" \
    "${production_transition_staged_compose_removal_approvals[@]}"
  print_approval_records \
    "CONSUMED PRODUCTION COMPOSE REMOVAL APPROVALS:" \
    "${production_transition_consumed_compose_removal_approvals[@]}"
  print_approval_records \
    "REVOKED PRODUCTION COMPOSE REMOVAL APPROVALS:" \
    "${production_transition_revoked_compose_removal_approvals[@]}"
  if [[ "${#production_transition_added_migrations[@]}" -gt 0 ]]; then
    printf 'New additive migrations:\n'
    printf '  - %s\n' "${production_transition_added_migrations[@]}"
  else
    printf 'New migrations: none\n'
  fi
}
