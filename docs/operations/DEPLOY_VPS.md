# Controlled VPS deployment

This runbook is for an exceptional, reviewed release that the automatic
current-to-candidate policy has intentionally rejected. Routine releases use
`scripts/deploy-production.sh`. A policy rejection is evidence to review, not
an instruction to bypass the failed rule generically.

The manual path preserves the same topology as automation:

```text
canonical repository -> detached immutable release worktree
                     -> release-specific private .env
                     -> SHA-tagged image
                     -> Compose from that release
                     -> private release record
                     -> previous release retained for rollback
```

For example, a candidate is created at
`/srv/danicode/releases/al-lio-0123456789ab`; it is never run from the canonical
repository checkout.

Run the blocks in sections 1-11 in one Bash session as the dedicated non-root
deploy user. The rollback and database-recovery blocks are separate incident
paths and run only when their stated condition applies. Stop until every
rejected Compose, Dockerfile and migration line has an owner, rationale and
review.

## 1. Establish a guarded operator session

Set the exact reviewed candidate and a non-secret review reference. The lock is
the same lock used by automation.

```bash
set -Eeuo pipefail
umask 077

export AL_LIO_REPOSITORY_DIR=/srv/danicode/projects/al-lio
export AL_LIO_RELEASES_DIR=/srv/danicode/releases
export AL_LIO_BACKUP_DIR=/srv/danicode/backups/al-lio
export AL_LIO_RELEASE_SHA="REPLACE_WITH_FULL_40_CHARACTER_REVIEWED_MAIN_SHA"
export AL_LIO_EXCEPTION_REASON="REPLACE_WITH_REVIEWED_TICKET_OR_CHANGE_REFERENCE"

for AL_LIO_REQUIRED_VALUE_NAME in AL_LIO_RELEASE_SHA AL_LIO_EXCEPTION_REASON; do
  AL_LIO_REQUIRED_VALUE="${!AL_LIO_REQUIRED_VALUE_NAME:-}"
  if [[ -z "$AL_LIO_REQUIRED_VALUE" || "$AL_LIO_REQUIRED_VALUE" == REPLACE_WITH_* ]]; then
    printf 'ERROR: replace the placeholder for %s before continuing.\n' \
      "$AL_LIO_REQUIRED_VALUE_NAME" >&2
    exit 1
  fi
done
unset AL_LIO_REQUIRED_VALUE_NAME AL_LIO_REQUIRED_VALUE
[[ "$AL_LIO_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]]
if [[ "${#AL_LIO_EXCEPTION_REASON}" -gt 256 ||
  "$AL_LIO_EXCEPTION_REASON" == *$'\n'* ||
  "$AL_LIO_EXCEPTION_REASON" == *$'\r'* ]] ||
  ! LC_ALL=C grep -Eq '^[ -~]+$' <<< "$AL_LIO_EXCEPTION_REASON"; then
  printf 'ERROR: AL_LIO_EXCEPTION_REASON must be 1-256 printable ASCII bytes on one line.\n' >&2
  exit 1
fi
[[ "$(id -u)" -ne 0 ]]
mkdir -p -- "$AL_LIO_RELEASES_DIR" "$AL_LIO_BACKUP_DIR"
command -v timeout >/dev/null || {
  printf 'ERROR: GNU timeout is required for bounded container HTTP probes.\n' >&2
  exit 1
}
exec 9>"$AL_LIO_BACKUP_DIR/deploy-production.lock"
flock -n 9
```

Define cleanup before changing runtime state. It removes only an isolated
rehearsal database, rolls web back after a failed cutover, and restarts the
preserved Radar container when necessary.

```bash
read_env_value() {
  local key="$1" env_file="$2" line value
  line="$(grep -E "^${key}=" "$env_file" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 1
  value="${line#*=}"
  value="${value%$'\r'}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

wait_for_web_health() {
  local attempt state health
  for ((attempt = 1; attempt <= 30; attempt++)); do
    state="$(docker inspect al_lio_web --format '{{.State.Status}}' 2>/dev/null || true)"
    health="$(docker inspect al_lio_web --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
    [[ "$state" == running && "$health" == healthy ]] && return 0
    [[ "$state" == exited || "$health" == unhealthy ]] && return 1
    sleep 5
  done
  return 1
}

AL_LIO_REHEARSAL_DB=""
AL_LIO_RADAR_STOPPED=0
AL_LIO_CUTOVER_STARTED=0
AL_LIO_RUNTIME_RECOVERY_LOG="$AL_LIO_BACKUP_DIR/runtime-recovery-${AL_LIO_RELEASE_SHA:0:12}.log"

record_runtime_recovery_event() {
  local result="$1" detail="$2"
  if ! printf \
    'timestamp_utc=%s result=%s detail=%s\ndb_backup_path=%s\ndb_backup_checksum=%s\nlearning_import_result=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$result" "$detail" \
    "${AL_LIO_POSTGRES_BACKUP:-not-created}" \
    "${AL_LIO_POSTGRES_BACKUP_CHECKSUM:-not-created}" \
    "${AL_LIO_LEARNING_IMPORT_RESULT:-not-started}" >> \
    "$AL_LIO_RUNTIME_RECOVERY_LOG"; then
    printf 'CRITICAL: runtime recovery evidence could not be written to %s.\n' \
      "$AL_LIO_RUNTIME_RECOVERY_LOG" >&2
    return 1
  fi
  if ! chmod 600 "$AL_LIO_RUNTIME_RECOVERY_LOG"; then
    printf 'CRITICAL: runtime recovery evidence could not be secured at %s.\n' \
      "$AL_LIO_RUNTIME_RECOVERY_LOG" >&2
    return 1
  fi
}

cleanup_manual_release() {
  local status=$?
  local recovery_failed=0
  trap - EXIT INT TERM
  if [[ -n "$AL_LIO_REHEARSAL_DB" ]]; then
    if ! docker exec al_lio_postgres dropdb -U al_lio --if-exists \
      "$AL_LIO_REHEARSAL_DB" >/dev/null 2>&1; then
      printf 'WARNING: temporary rehearsal database cleanup failed: %s.\n' \
        "$AL_LIO_REHEARSAL_DB" >&2
    fi
  fi
  if [[ "$status" -ne 0 && "$AL_LIO_CUTOVER_STARTED" -eq 1 ]]; then
    printf 'ERROR: deployment failed after cutover; restoring the previous web release.\n' >&2
    if ! (
      cd "$AL_LIO_PREVIOUS_RELEASE_DIR"
      docker compose -f infra/docker-compose.prod.yml --env-file .env \
        up -d --no-deps al_lio_web </dev/null
    ); then
      printf 'CRITICAL: automatic web rollback command failed. Production requires operator recovery.\n' >&2
      record_runtime_recovery_event failed automatic-web-rollback-command || recovery_failed=1
      recovery_failed=1
    elif ! wait_for_web_health; then
      printf 'CRITICAL: previous web release did not become healthy after automatic rollback.\n' >&2
      record_runtime_recovery_event failed automatic-web-rollback-health || recovery_failed=1
      recovery_failed=1
    else
      record_runtime_recovery_event restored automatic-web-rollback || recovery_failed=1
    fi
  fi
  if [[ "$AL_LIO_RADAR_STOPPED" -eq 1 ]]; then
    if ! docker start al_lio_radar >/dev/null ||
      [[ "$(docker inspect al_lio_radar --format '{{.State.Status}}' 2>/dev/null)" != running ]]; then
      printf 'CRITICAL: automatic Radar restart failed. Production requires operator recovery.\n' >&2
      record_runtime_recovery_event failed automatic-radar-restart || recovery_failed=1
      recovery_failed=1
    else
      record_runtime_recovery_event restored automatic-radar-restart || recovery_failed=1
    fi
  fi
  if [[ "$recovery_failed" -ne 0 ]]; then
    printf 'CRITICAL: automatic runtime recovery is incomplete; evidence: %s\n' \
      "$AL_LIO_RUNTIME_RECOVERY_LOG" >&2
    status=1
  fi
  exit "$status"
}

trap cleanup_manual_release EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
```

## 2. Identify and verify the active release

Read the runtime identity from Docker and derive the active immutable worktree.
The current image tag, Git object and release directory must agree.

```bash
export AL_LIO_CURRENT_IMAGE="$(docker inspect al_lio_web --format '{{.Config.Image}}')"
[[ "$AL_LIO_CURRENT_IMAGE" == al-lio-web:* ]]
export AL_LIO_CURRENT_SHA="${AL_LIO_CURRENT_IMAGE#al-lio-web:}"
[[ "$AL_LIO_CURRENT_SHA" =~ ^[0-9a-f]{40}$ ]]

export AL_LIO_CURRENT_COMPOSE_DIR="$(docker inspect al_lio_web --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')"
export AL_LIO_PREVIOUS_RELEASE_DIR="$(readlink -f -- "$(dirname "$AL_LIO_CURRENT_COMPOSE_DIR")")"
export AL_LIO_RELEASE_DIR="$AL_LIO_RELEASES_DIR/al-lio-${AL_LIO_RELEASE_SHA:0:12}"

case "$AL_LIO_PREVIOUS_RELEASE_DIR" in "$AL_LIO_RELEASES_DIR"/al-lio-*) ;; *) exit 1 ;; esac
case "$AL_LIO_RELEASE_DIR" in "$AL_LIO_RELEASES_DIR"/al-lio-*) ;; *) exit 1 ;; esac
[[ -f "$AL_LIO_PREVIOUS_RELEASE_DIR/.env" ]]
[[ "$(git -C "$AL_LIO_PREVIOUS_RELEASE_DIR" rev-parse HEAD)" == "$AL_LIO_CURRENT_SHA" ]]
[[ -z "$(git -C "$AL_LIO_PREVIOUS_RELEASE_DIR" status --porcelain --untracked-files=all)" ]]
[[ "$(read_env_value AL_LIO_IMAGE_TAG "$AL_LIO_PREVIOUS_RELEASE_DIR/.env")" == "$AL_LIO_CURRENT_SHA" ]]

AL_LIO_CURRENT_RELEASE_IDENTITY="$(read_env_value AL_LIO_RELEASE_SHA "$AL_LIO_PREVIOUS_RELEASE_DIR/.env" || true)"
if [[ -n "$AL_LIO_CURRENT_RELEASE_IDENTITY" ]]; then
  [[ "$AL_LIO_CURRENT_RELEASE_IDENTITY" == "$AL_LIO_CURRENT_SHA" ]]
fi

export AL_LIO_BASE_URL="$(read_env_value BASE_URL "$AL_LIO_PREVIOUS_RELEASE_DIR/.env")"
[[ "$AL_LIO_BASE_URL" == https://* ]]
[[ "$(docker inspect al_lio_web --format '{{.State.Status}}')" == running ]]
[[ "$(docker inspect al_lio_web --format '{{.State.Health.Status}}')" == healthy ]]
[[ "$(docker inspect al_lio_postgres --format '{{.State.Status}}')" == running ]]
[[ "$(docker inspect al_lio_postgres --format '{{.State.Health.Status}}')" == healthy ]]
[[ "$(docker inspect al_lio_radar --format '{{.State.Status}}')" == running ]]

export AL_LIO_PREVIOUS_WEB_ID="$(docker inspect al_lio_web --format '{{.Id}}')"
export AL_LIO_POSTGRES_ID="$(docker inspect al_lio_postgres --format '{{.Id}}')"
export AL_LIO_RADAR_ID="$(docker inspect al_lio_radar --format '{{.Id}}')"
export AL_LIO_RELEASE_STARTED_AT="$(date -u +%Y%m%dT%H%M%SZ)"
```

The optional current `AL_LIO_RELEASE_SHA` check permits the historical
`dc6607e` release, which predates release identity. Corrected releases have the
value and must match.

## 3. Fetch and review the exceptional transition

Fetching updates refs and objects only; it does not change the canonical
checkout.

```bash
git -C "$AL_LIO_REPOSITORY_DIR" fetch --tags origin main
git -C "$AL_LIO_REPOSITORY_DIR" cat-file -e "${AL_LIO_RELEASE_SHA}^{commit}"
git -C "$AL_LIO_REPOSITORY_DIR" merge-base --is-ancestor "$AL_LIO_RELEASE_SHA" origin/main
git -C "$AL_LIO_REPOSITORY_DIR" merge-base --is-ancestor "$AL_LIO_CURRENT_SHA" "$AL_LIO_RELEASE_SHA"
git -C "$AL_LIO_REPOSITORY_DIR" diff --name-status "$AL_LIO_CURRENT_SHA" "$AL_LIO_RELEASE_SHA"
git -C "$AL_LIO_REPOSITORY_DIR" diff "$AL_LIO_CURRENT_SHA" "$AL_LIO_RELEASE_SHA" -- \
  infra/docker-compose.prod.yml infra/Dockerfile infra/postgres/migrations
```

### 3.1 Fail-closed checklist for the historical production release

The transition from `dc6607ec88810d90e43d415e6781bc90e1c6612f` is the only
historical exception covered by this block. It permits exactly six retired web
environment mappings, introduces the immutable release identity, adds
`/api/version`, and adds migration `0017_job_radar_sync_state.sql`. It does not
create a reusable removal approval. A reviewer must calculate and provide the
expected runtime/control-plane digest from the exact candidate; a mismatch
means the reviewed diff changed and this procedure stops.

```bash
export AL_LIO_HISTORICAL_SOURCE_SHA="dc6607ec88810d90e43d415e6781bc90e1c6612f"
export AL_LIO_REVIEWED_RUNTIME_CONTROL_PLANE_DIFF_SHA256="REPLACE_WITH_REVIEWED_64_CHARACTER_LOWERCASE_SHA256"

if [[ "$AL_LIO_CURRENT_SHA" != "$AL_LIO_HISTORICAL_SOURCE_SHA" ]]; then
  printf 'ERROR: this checklist applies only to the reviewed historical release.\n' >&2
  exit 1
fi
if [[ "$AL_LIO_REVIEWED_RUNTIME_CONTROL_PLANE_DIFF_SHA256" == REPLACE_WITH_* ]] ||
  [[ ! "$AL_LIO_REVIEWED_RUNTIME_CONTROL_PLANE_DIFF_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  printf 'ERROR: provide the independently reviewed runtime/control-plane diff SHA-256.\n' >&2
  exit 1
fi

AL_LIO_EXPECTED_HISTORICAL_COMPOSE_REMOVALS="$(LC_ALL=C sort <<'EOF'
ADZUNA_APP_ID: ${ADZUNA_APP_ID:-}
ADZUNA_APP_KEY: ${ADZUNA_APP_KEY:-}
AL_LIO_DEMO_ACCESS_ENABLED: ${AL_LIO_DEMO_ACCESS_ENABLED:-false}
INFOJOBS_CLIENT_ID: ${INFOJOBS_CLIENT_ID:-}
INFOJOBS_CLIENT_SECRET: ${INFOJOBS_CLIENT_SECRET:-}
JOOBLE_API_KEY: ${JOOBLE_API_KEY:-}
EOF
)"
AL_LIO_EXPECTED_HISTORICAL_COMPOSE_ADDITIONS='AL_LIO_RELEASE_SHA: ${AL_LIO_RELEASE_SHA:?AL_LIO_RELEASE_SHA is injected by the release mechanism}'
AL_LIO_HISTORICAL_COMPOSE_NUMSTAT="$(
  git -C "$AL_LIO_REPOSITORY_DIR" diff --numstat \
    "$AL_LIO_HISTORICAL_SOURCE_SHA" "$AL_LIO_RELEASE_SHA" -- \
    infra/docker-compose.prod.yml
)"
[[ "$AL_LIO_HISTORICAL_COMPOSE_NUMSTAT" == $'1\t6\tinfra/docker-compose.prod.yml' ]] || {
  printf 'ERROR: unexpected historical Compose line counts; stop for manual review.\n' >&2
  exit 1
}
AL_LIO_ACTUAL_HISTORICAL_COMPOSE_REMOVALS="$(
  git -C "$AL_LIO_REPOSITORY_DIR" diff --unified=0 --no-color \
    "$AL_LIO_HISTORICAL_SOURCE_SHA" "$AL_LIO_RELEASE_SHA" -- \
    infra/docker-compose.prod.yml |
    sed -n '/^--- /d; /^-/ { s/^-[[:space:]]*//; p; }' |
    LC_ALL=C sort
)"
AL_LIO_ACTUAL_HISTORICAL_COMPOSE_ADDITIONS="$(
  git -C "$AL_LIO_REPOSITORY_DIR" diff --unified=0 --no-color \
    "$AL_LIO_HISTORICAL_SOURCE_SHA" "$AL_LIO_RELEASE_SHA" -- \
    infra/docker-compose.prod.yml |
    sed -n '/^+++ /d; /^+/ { s/^+[[:space:]]*//; p; }'
)"
[[ "$AL_LIO_ACTUAL_HISTORICAL_COMPOSE_REMOVALS" == \
  "$AL_LIO_EXPECTED_HISTORICAL_COMPOSE_REMOVALS" ]] || {
  printf 'ERROR: historical Compose removals differ from the six reviewed mappings.\n' >&2
  exit 1
}
[[ "$AL_LIO_ACTUAL_HISTORICAL_COMPOSE_ADDITIONS" == \
  "$AL_LIO_EXPECTED_HISTORICAL_COMPOSE_ADDITIONS" ]] || {
  printf 'ERROR: historical Compose additions differ from AL_LIO_RELEASE_SHA.\n' >&2
  exit 1
}

validate_historical_regular_blob() {
  local path="$1" label="$2" output_variable="$3"
  local tree_entry="" mode="" type="" object="" listed_path=""

  tree_entry="$(git -C "$AL_LIO_REPOSITORY_DIR" ls-tree \
    "$AL_LIO_RELEASE_SHA" -- "$path")"
  IFS=$' \t' read -r mode type object listed_path <<< "$tree_entry"
  if [[ "$mode" != 100644 || "$type" != blob || -z "$object" ||
    "$listed_path" != "$path" ]]; then
    printf 'ERROR: %s must be one exact 100644 blob; found mode=%s type=%s.\n' \
      "$label" "${mode:-missing}" "${type:-missing}" >&2
    return 1
  fi
  printf -v "$output_variable" '%s' "$object"
}

AL_LIO_VERSION_ROUTE_OBJECT=""
AL_LIO_MIGRATION_0017_OBJECT=""
validate_historical_regular_blob \
  src/app/api/version/route.ts \
  "Candidate /api/version route" \
  AL_LIO_VERSION_ROUTE_OBJECT || exit 1
validate_historical_regular_blob \
  infra/postgres/migrations/0017_job_radar_sync_state.sql \
  "Candidate migration 0017" \
  AL_LIO_MIGRATION_0017_OBJECT || exit 1

[[ "$(git -C "$AL_LIO_REPOSITORY_DIR" diff --name-status \
  "$AL_LIO_HISTORICAL_SOURCE_SHA" "$AL_LIO_RELEASE_SHA" -- \
  src/app/api/version/route.ts)" == $'A\tsrc/app/api/version/route.ts' ]] || {
  printf 'ERROR: /api/version is not the exact reviewed new route.\n' >&2
  exit 1
}
git -C "$AL_LIO_REPOSITORY_DIR" cat-file blob "$AL_LIO_VERSION_ROUTE_OBJECT" |
  grep -Fq 'process.env.AL_LIO_RELEASE_SHA' || {
    printf 'ERROR: /api/version does not expose the immutable release identity.\n' >&2
    exit 1
  }

[[ "$(git -C "$AL_LIO_REPOSITORY_DIR" diff --name-status \
  "$AL_LIO_HISTORICAL_SOURCE_SHA" "$AL_LIO_RELEASE_SHA" -- \
  infra/postgres/migrations)" == \
  $'A\tinfra/postgres/migrations/0017_job_radar_sync_state.sql' ]] || {
  printf 'ERROR: migration changes differ from the reviewed 0017 migration.\n' >&2
  exit 1
}
AL_LIO_HISTORICAL_MIGRATION_SQL="$(
  git -C "$AL_LIO_REPOSITORY_DIR" cat-file blob "$AL_LIO_MIGRATION_0017_OBJECT"
)"
if grep -Eiq '(^|[^[:alnum:]_])(drop[[:space:]]+(table|schema|column|index)|truncate[[:space:]]+table|delete[[:space:]]+from|alter[[:space:]]+table[^;]*(drop[[:space:]]+column|alter[[:space:]]+column|rename[[:space:]]))([^[:alnum:]_]|$)' \
  <<< "$AL_LIO_HISTORICAL_MIGRATION_SQL"; then
  printf 'ERROR: migration 0017 contains a destructive or structural statement.\n' >&2
  exit 1
fi

AL_LIO_ACTUAL_RUNTIME_CONTROL_PLANE_DIFF_SHA256="$(
  {
    printf 'source_sha=%s\n' "$AL_LIO_HISTORICAL_SOURCE_SHA"
    printf 'candidate_sha=%s\n' "$AL_LIO_RELEASE_SHA"
    git -C "$AL_LIO_REPOSITORY_DIR" diff --raw --no-abbrev \
      "$AL_LIO_HISTORICAL_SOURCE_SHA" "$AL_LIO_RELEASE_SHA" -- \
      .dockerignore ':(glob)**/.gitattributes' \
      .github/workflows/ci.yml .github/workflows/deploy-production.yml \
      infra/Dockerfile data/learning-competencies.json \
      scripts/import-learning-competencies.mjs scripts/deploy-production.sh \
      scripts/github-actions-deploy-entrypoint.sh \
      scripts/lib/production-transition-policy.sh scripts/lib/compose-env-guard.sh \
      scripts/lib/release-worktree-integrity.sh scripts/prepare-release-env.sh \
      scripts/validate-production-transition.sh \
      scripts/validate-production-deploy-readiness.mjs \
      scripts/config/production-compose-env-removals.allowlist scripts/postgres \
      src/app/api/version/route.ts \
      infra/postgres/migrations/0017_job_radar_sync_state.sql \
      infra/postgres/schema.sql infra/postgres/baseline.sha256
  } | sha256sum | awk '{ print $1 }'
)"
[[ "$AL_LIO_ACTUAL_RUNTIME_CONTROL_PLANE_DIFF_SHA256" == \
  "$AL_LIO_REVIEWED_RUNTIME_CONTROL_PLANE_DIFF_SHA256" ]] || {
  printf 'ERROR: runtime/control-plane diff changed; stop for manual review.\n' >&2
  exit 1
}

# The reviewed digest above binds these validators to the exact candidate. Load
# those Git blobs from a private temporary directory only after that check, then
# reuse the production raw-byte loader and canonical approval parser.
AL_LIO_COMPOSE_GUARD_OBJECT=""
AL_LIO_TRANSITION_POLICY_OBJECT=""
validate_historical_regular_blob \
  scripts/lib/compose-env-guard.sh \
  "Candidate Compose environment guard" \
  AL_LIO_COMPOSE_GUARD_OBJECT || exit 1
validate_historical_regular_blob \
  scripts/lib/production-transition-policy.sh \
  "Candidate production transition policy" \
  AL_LIO_TRANSITION_POLICY_OBJECT || exit 1

cleanup_historical_validator_dir() {
  if ! rm -rf -- "$AL_LIO_HISTORICAL_VALIDATOR_DIR"; then
    printf 'ERROR: private historical validator directory could not be removed.\n' >&2
    return 1
  fi
}

AL_LIO_HISTORICAL_VALIDATOR_DIR="$(
  mktemp -d "${TMPDIR:-/tmp}/al-lio-historical-validator.XXXXXX"
)"
if ! chmod 700 "$AL_LIO_HISTORICAL_VALIDATOR_DIR" ||
  ! git -C "$AL_LIO_REPOSITORY_DIR" cat-file blob \
    "$AL_LIO_COMPOSE_GUARD_OBJECT" > \
    "$AL_LIO_HISTORICAL_VALIDATOR_DIR/compose-env-guard.sh" ||
  ! git -C "$AL_LIO_REPOSITORY_DIR" cat-file blob \
    "$AL_LIO_TRANSITION_POLICY_OBJECT" > \
    "$AL_LIO_HISTORICAL_VALIDATOR_DIR/production-transition-policy.sh" ||
  ! chmod 600 "$AL_LIO_HISTORICAL_VALIDATOR_DIR/compose-env-guard.sh" \
    "$AL_LIO_HISTORICAL_VALIDATOR_DIR/production-transition-policy.sh"; then
  cleanup_historical_validator_dir || exit 1
  printf 'ERROR: exact candidate approval validators could not be prepared.\n' >&2
  exit 1
fi

if ! (
  if ! source "$AL_LIO_HISTORICAL_VALIDATOR_DIR/production-transition-policy.sh"; then
    printf 'ERROR: exact candidate production transition policy could not be loaded.\n' >&2
    exit 1
  fi
  if ! validate_regular_git_blob \
    "$AL_LIO_REPOSITORY_DIR" \
    "$AL_LIO_RELEASE_SHA" \
    "scripts/config/production-compose-env-removals.allowlist" \
    "Candidate Compose removal approval file"; then
    printf 'ERROR: %s\n' "$production_transition_error" >&2
    exit 1
  fi
  AL_LIO_CANDIDATE_APPROVAL_OBJECT="$production_transition_validated_blob_object"
  production_transition_validated_blob_object=""
  if ! validate_and_load_approval_blob \
    "$AL_LIO_REPOSITORY_DIR" \
    "$AL_LIO_CANDIDATE_APPROVAL_OBJECT" \
    "Candidate Compose removal approval file"; then
    printf 'ERROR: %s\n' "$production_transition_error" >&2
    exit 1
  fi
  AL_LIO_CANDIDATE_COMPOSE_REMOVAL_APPROVALS="$production_transition_validated_approval_data"
  production_transition_validated_approval_data=""
  if ! AL_LIO_CANDIDATE_WEB_ENVIRONMENT="$(extract_service_environment \
    "$AL_LIO_REPOSITORY_DIR" "$AL_LIO_RELEASE_SHA" \
    infra/docker-compose.prod.yml al_lio_web)"; then
    printf 'ERROR: candidate al_lio_web environment could not be inspected.\n' >&2
    exit 1
  fi
  if ! AL_LIO_CANDIDATE_RADAR_ENVIRONMENT="$(extract_service_environment \
    "$AL_LIO_REPOSITORY_DIR" "$AL_LIO_RELEASE_SHA" \
    infra/docker-compose.prod.yml al_lio_radar)"; then
    printf 'ERROR: candidate al_lio_radar environment could not be inspected.\n' >&2
    exit 1
  fi
  if ! validate_removal_approval_data \
    "$AL_LIO_CANDIDATE_COMPOSE_REMOVAL_APPROVALS" \
    "$AL_LIO_CANDIDATE_WEB_ENVIRONMENT" \
    "$AL_LIO_CANDIDATE_RADAR_ENVIRONMENT" \
    "Candidate"; then
    printf 'ERROR: %s\n' "$compose_env_guard_error" >&2
    exit 1
  fi

  while IFS= read -r AL_LIO_APPROVAL_RECORD || [[ -n "$AL_LIO_APPROVAL_RECORD" ]]; do
    [[ -z "$AL_LIO_APPROVAL_RECORD" || "$AL_LIO_APPROVAL_RECORD" == \#* ]] && continue
    printf 'ERROR: historical candidate must contain zero active Compose removal approvals.\n' >&2
    exit 1
  done <<< "$AL_LIO_CANDIDATE_COMPOSE_REMOVAL_APPROVALS"
); then
  cleanup_historical_validator_dir || exit 1
  exit 1
fi
cleanup_historical_validator_dir || exit 1
unset AL_LIO_HISTORICAL_VALIDATOR_DIR AL_LIO_COMPOSE_GUARD_OBJECT \
  AL_LIO_TRANSITION_POLICY_OBJECT AL_LIO_VERSION_ROUTE_OBJECT \
  AL_LIO_MIGRATION_0017_OBJECT
unset -f validate_historical_regular_blob cleanup_historical_validator_dir
```

Do not add the six retired variables to
`scripts/config/production-compose-env-removals.allowlist`. Continue only when
the exact Compose, route, migration and reviewed runtime/control-plane checks
above all pass. Any other relevant difference is a hard stop for manual review.

## 4. Create the immutable candidate

Create a detached release worktree while leaving the canonical checkout in
place. Restore the private umask after Git creates the readable application
tree.

```bash
[[ ! -e "$AL_LIO_RELEASE_DIR" ]]
AL_LIO_PRIVATE_UMASK="$(umask)"
umask 022
git -C "$AL_LIO_REPOSITORY_DIR" worktree add --detach \
  "$AL_LIO_RELEASE_DIR" \
  "$AL_LIO_RELEASE_SHA"
umask "$AL_LIO_PRIVATE_UMASK"

[[ "$(git -C "$AL_LIO_RELEASE_DIR" rev-parse HEAD)" == "$AL_LIO_RELEASE_SHA" ]]
source "$AL_LIO_RELEASE_DIR/scripts/lib/release-worktree-integrity.sh"
validate_release_worktree_integrity "$AL_LIO_RELEASE_DIR" "$AL_LIO_RELEASE_SHA" || {
  printf 'ERROR: %s\n' "$release_worktree_integrity_error" >&2
  exit 1
}
bash "$AL_LIO_RELEASE_DIR/scripts/prepare-release-env.sh" \
  "$AL_LIO_PREVIOUS_RELEASE_DIR/.env" \
  "$AL_LIO_RELEASE_DIR/.env" \
  "$AL_LIO_RELEASE_SHA"
[[ "$(stat -c '%a' "$AL_LIO_RELEASE_DIR/.env")" == 600 ]]
```

Record the shared policy's exact rejection. Candidate code executes the policy,
but approval data is read from the exact current and candidate Git objects;
candidate data cannot authorize its own removal.

```bash
export AL_LIO_POLICY_LOG="$AL_LIO_BACKUP_DIR/transition-${AL_LIO_CURRENT_SHA:0:12}-to-${AL_LIO_RELEASE_SHA:0:12}.log"
if AL_LIO_REPOSITORY_DIR="$AL_LIO_REPOSITORY_DIR" \
  bash "$AL_LIO_RELEASE_DIR/scripts/validate-production-transition.sh" \
    "$AL_LIO_CURRENT_SHA" "$AL_LIO_RELEASE_SHA" origin/main 2>&1 |
    tee "$AL_LIO_POLICY_LOG"; then
  echo "Routine policy accepted this transition; stop the exceptional procedure." >&2
  exit 1
fi
chmod 600 "$AL_LIO_POLICY_LOG"
grep -q '^ERROR:' "$AL_LIO_POLICY_LOG"

cd "$AL_LIO_RELEASE_DIR"
docker compose -f infra/docker-compose.prod.yml --env-file .env config --quiet
```

Continue only after the logged rejection and every exceptional diff line match
the reviewed reason in `AL_LIO_EXCEPTION_REASON`.

## 5. Build without cutting over

```bash
docker compose -f infra/docker-compose.prod.yml --env-file .env \
  build --pull al_lio_web
docker image inspect "al-lio-web:$AL_LIO_RELEASE_SHA" >/dev/null
[[ "$(docker inspect al_lio_web --format '{{.Id}}')" == "$AL_LIO_PREVIOUS_WEB_ID" ]]
```

A build failure leaves the active container untouched.

## 6. Audit, back up and restore-test PostgreSQL

```bash
docker compose -f infra/docker-compose.prod.yml --env-file .env \
  --profile ops run --rm -T al_lio_migrator \
  node scripts/postgres/audit-baseline.mjs

AL_LIO_MIGRATION_STATUS="$(
  docker compose -f infra/docker-compose.prod.yml --env-file .env \
    --profile ops run --rm -T al_lio_migrator \
    node scripts/postgres/migrate.mjs --status
)"
printf '%s\n' "$AL_LIO_MIGRATION_STATUS"

AL_LIO_MIGRATION_REQUIRED=0
AL_LIO_POSTGRES_BACKUP=not-required
AL_LIO_POSTGRES_BACKUP_CHECKSUM=not-required
AL_LIO_RESTORE_VERIFICATION=not-required
AL_LIO_REHEARSAL_RESULT=not-required
AL_LIO_RADAR_BACKUP=not-required
AL_LIO_RADAR_BACKUP_STATUS=not-required
AL_LIO_PENDING_MIGRATION_IDS=none
AL_LIO_APPLIED_MIGRATION_IDS=none
AL_LIO_LEARNING_IMPORT_REQUIRED=0
AL_LIO_LEARNING_IMPORT_RESULT=not-started
AL_LIO_DB_MUTATION_REQUIRED=0
if grep -q 'PENDIENTE' <<< "$AL_LIO_MIGRATION_STATUS"; then
  AL_LIO_MIGRATION_REQUIRED=1
  AL_LIO_PENDING_MIGRATION_IDS="$(
    awk '$1 == "PENDIENTE" { value = value (value ? "," : "") $2 } END { print value }' \
      <<< "$AL_LIO_MIGRATION_STATUS"
  )"
  [[ -n "$AL_LIO_PENDING_MIGRATION_IDS" ]]
fi

if git -C "$AL_LIO_REPOSITORY_DIR" diff --quiet \
  "$AL_LIO_CURRENT_SHA" "$AL_LIO_RELEASE_SHA" -- \
  data/learning-competencies.json; then
  AL_LIO_LEARNING_IMPORT_REQUIRED=0
  AL_LIO_LEARNING_IMPORT_RESULT=skipped
else
  AL_LIO_LEARNING_DIFF_STATUS=$?
  [[ "$AL_LIO_LEARNING_DIFF_STATUS" -eq 1 ]] || {
    printf 'ERROR: unable to determine whether the learning catalogue changed.\n' >&2
    exit 1
  }
  AL_LIO_LEARNING_IMPORT_REQUIRED=1
fi
unset AL_LIO_LEARNING_DIFF_STATUS

if [[ "$AL_LIO_MIGRATION_REQUIRED" -eq 1 ||
  "$AL_LIO_LEARNING_IMPORT_REQUIRED" -eq 1 ]]; then
  AL_LIO_DB_MUTATION_REQUIRED=1
fi
```

Before any migration or catalogue import can mutate PostgreSQL, create a
custom-format dump and run the full restore test. Migration rehearsal remains
conditional only on pending migrations.

```bash
if [[ "$AL_LIO_DB_MUTATION_REQUIRED" -eq 1 ]]; then
  AL_LIO_BACKUP_OUTPUT="$(
    AL_LIO_BACKUP_DIR="$AL_LIO_BACKUP_DIR" \
      bash scripts/postgres/backup-production.sh
  )"
  printf '%s\n' "$AL_LIO_BACKUP_OUTPUT"
  mapfile -t AL_LIO_BACKUP_PATHS < <(
    sed -n 's/^Backup creado y validado: //p' <<< "$AL_LIO_BACKUP_OUTPUT"
  )
  [[ "${#AL_LIO_BACKUP_PATHS[@]}" -eq 1 ]]
  AL_LIO_POSTGRES_BACKUP="${AL_LIO_BACKUP_PATHS[0]}"
  unset AL_LIO_BACKUP_PATHS
  [[ "$AL_LIO_POSTGRES_BACKUP" == "$AL_LIO_BACKUP_DIR"/*.dump ]]
  [[ -f "$AL_LIO_POSTGRES_BACKUP" && ! -L "$AL_LIO_POSTGRES_BACKUP" &&
    -s "$AL_LIO_POSTGRES_BACKUP" ]]
  [[ "$(readlink -f -- "$AL_LIO_POSTGRES_BACKUP")" == "$AL_LIO_POSTGRES_BACKUP" ]]
  [[ -f "$AL_LIO_POSTGRES_BACKUP.sha256" && ! -L "$AL_LIO_POSTGRES_BACKUP.sha256" ]]
  AL_LIO_POSTGRES_BACKUP_CHECKSUM="$(sha256sum "$AL_LIO_POSTGRES_BACKUP" | awk '{ print $1 }')"
  [[ "$AL_LIO_POSTGRES_BACKUP_CHECKSUM" =~ ^[0-9a-f]{64}$ ]]
  [[ "$(cat -- "$AL_LIO_POSTGRES_BACKUP.sha256")" == \
    "$AL_LIO_POSTGRES_BACKUP_CHECKSUM  $AL_LIO_POSTGRES_BACKUP" ]]
  sha256sum --check "$AL_LIO_POSTGRES_BACKUP.sha256"
  bash scripts/postgres/verify-backup-production.sh "$AL_LIO_POSTGRES_BACKUP"
  AL_LIO_RESTORE_VERIFICATION=passed
fi
```

## 7. Rehearse migrations in an isolated database

Restore the verified dump to a uniquely named database. Point only the
ephemeral migrator container at it and verify its migration ledger.

```bash
if [[ "$AL_LIO_MIGRATION_REQUIRED" -eq 1 ]]; then
  AL_LIO_REHEARSAL_DB="al_lio_rehearsal_${AL_LIO_RELEASE_SHA:0:12}_$$"
  docker exec al_lio_postgres createdb -U al_lio "$AL_LIO_REHEARSAL_DB"
  docker exec -i al_lio_postgres pg_restore \
    -U al_lio -d "$AL_LIO_REHEARSAL_DB" \
    --exit-on-error --no-owner --no-acl < "$AL_LIO_POSTGRES_BACKUP"

  AL_LIO_PRODUCTION_MIGRATION_URL="$(read_env_value DATABASE_MIGRATION_URL .env)"
  AL_LIO_MIGRATION_URL_WITHOUT_QUERY="${AL_LIO_PRODUCTION_MIGRATION_URL%%\?*}"
  AL_LIO_MIGRATION_URL_QUERY=""
  if [[ "$AL_LIO_PRODUCTION_MIGRATION_URL" == *\?* ]]; then
    AL_LIO_MIGRATION_URL_QUERY="?${AL_LIO_PRODUCTION_MIGRATION_URL#*\?}"
  fi
  [[ "$AL_LIO_MIGRATION_URL_WITHOUT_QUERY" == */* ]]
  export DATABASE_MIGRATION_URL="${AL_LIO_MIGRATION_URL_WITHOUT_QUERY%/*}/${AL_LIO_REHEARSAL_DB}${AL_LIO_MIGRATION_URL_QUERY}"
  docker compose -f infra/docker-compose.prod.yml --env-file .env \
    --profile ops run --rm -T -e DATABASE_MIGRATION_URL al_lio_migrator
  unset DATABASE_MIGRATION_URL

  AL_LIO_MIGRATION_FILE_COUNT="$(
    find infra/postgres/migrations -maxdepth 1 -type f -name '*.sql' |
      wc -l | tr -d '[:space:]'
  )"
  AL_LIO_EXPECTED_MIGRATION_COUNT="$((AL_LIO_MIGRATION_FILE_COUNT + 1))"
  AL_LIO_REHEARSAL_MIGRATION_COUNT="$(
    docker exec al_lio_postgres psql -U al_lio -d "$AL_LIO_REHEARSAL_DB" -Atc \
      'select count(*) from public.schema_migrations;'
  )"
  [[ "$AL_LIO_REHEARSAL_MIGRATION_COUNT" == "$AL_LIO_EXPECTED_MIGRATION_COUNT" ]]
  AL_LIO_REHEARSAL_RESULT=passed
  docker exec al_lio_postgres dropdb -U al_lio "$AL_LIO_REHEARSAL_DB"
  AL_LIO_REHEARSAL_DB=""
fi
```

The additional one in the expected count is the audited `0001` baseline in
`infra/postgres/schema.sql`; versioned files start at `0002`.

Create the private attempt record before the first possible production data or
runtime mutation. Every update replaces the record atomically and keeps the
same strict `key=value` format consumed by delayed recovery.

```bash
export AL_LIO_ATTEMPT_RECORD="$AL_LIO_BACKUP_DIR/release-$AL_LIO_RELEASE_STARTED_AT-${AL_LIO_RELEASE_SHA:0:12}-attempt.txt"
export AL_LIO_RELEASE_RECORD="$AL_LIO_ATTEMPT_RECORD"
AL_LIO_ATTEMPT_OUTCOME=prepared

write_attempt_recovery_record() {
  local temporary_record
  temporary_record="$(mktemp "$AL_LIO_BACKUP_DIR/.attempt-record.XXXXXX")" || return 1
  if ! chmod 600 "$temporary_record"; then
    rm -f -- "$temporary_record" || true
    return 1
  fi
  if ! printf '%s\n' \
    "outcome=$AL_LIO_ATTEMPT_OUTCOME" \
    "timestamp_utc=$AL_LIO_RELEASE_STARTED_AT" \
    "current_sha=$AL_LIO_CURRENT_SHA" \
    "candidate_sha=$AL_LIO_RELEASE_SHA" \
    "previous_release_path=$AL_LIO_PREVIOUS_RELEASE_DIR" \
    "candidate_release_path=$AL_LIO_RELEASE_DIR" \
    "base_url=$AL_LIO_BASE_URL" \
    "previous_image=$AL_LIO_CURRENT_IMAGE" \
    "candidate_image=al-lio-web:$AL_LIO_RELEASE_SHA" \
    "postgres_container_id=$AL_LIO_POSTGRES_ID" \
    "radar_container_id=$AL_LIO_RADAR_ID" \
    "db_backup_path=$AL_LIO_POSTGRES_BACKUP" \
    "db_backup_checksum=$AL_LIO_POSTGRES_BACKUP_CHECKSUM" \
    "learning_import_result=$AL_LIO_LEARNING_IMPORT_RESULT" > "$temporary_record"; then
    rm -f -- "$temporary_record" || true
    return 1
  fi
  if ! mv -f -- "$temporary_record" "$AL_LIO_ATTEMPT_RECORD"; then
    rm -f -- "$temporary_record" || true
    return 1
  fi
  [[ -f "$AL_LIO_ATTEMPT_RECORD" && ! -L "$AL_LIO_ATTEMPT_RECORD" &&
    "$(stat -c '%a' "$AL_LIO_ATTEMPT_RECORD")" == 600 ]]
}

write_attempt_recovery_record || {
  printf 'CRITICAL: private attempt recovery record could not be created.\n' >&2
  exit 1
}
```

## 8. Back up Radar and apply rehearsed migrations

When migrations are required, stop the existing Radar writer, archive its
volume privately, then apply the same candidate migrator to production. Keep
the same Radar container stopped until the candidate web is healthy.

```bash
if [[ "$AL_LIO_MIGRATION_REQUIRED" -eq 1 ]]; then
  docker stop --time 30 al_lio_radar >/dev/null
  AL_LIO_RADAR_STOPPED=1
  AL_LIO_RADAR_BACKUP="$AL_LIO_BACKUP_DIR/radar-data-$AL_LIO_RELEASE_STARTED_AT.tgz"

  docker run --rm \
    -e BACKUP_FILE="$(basename "$AL_LIO_RADAR_BACKUP")" \
    -e BACKUP_UID="$(id -u)" \
    -e BACKUP_GID="$(id -g)" \
    -v al_lio_radar_data:/source:ro \
    -v "$AL_LIO_BACKUP_DIR":/backup \
    alpine:3.20 sh -c \
      'cd /source && tar -czf "/backup/$BACKUP_FILE" . && chown "$BACKUP_UID:$BACKUP_GID" "/backup/$BACKUP_FILE" && chmod 600 "/backup/$BACKUP_FILE"'
  [[ -s "$AL_LIO_RADAR_BACKUP" ]]
  chmod 600 "$AL_LIO_RADAR_BACKUP"
  sha256sum "$AL_LIO_RADAR_BACKUP" > "$AL_LIO_RADAR_BACKUP.sha256"
  sha256sum --check "$AL_LIO_RADAR_BACKUP.sha256"
  AL_LIO_RADAR_BACKUP_STATUS=verified

  docker compose -f infra/docker-compose.prod.yml --env-file .env \
    --profile ops run --rm -T al_lio_migrator \
    node scripts/postgres/audit-baseline.mjs
  docker compose -f infra/docker-compose.prod.yml --env-file .env \
    --profile ops run --rm -T al_lio_migrator

  AL_LIO_PRODUCTION_MIGRATION_COUNT="$(
    docker exec al_lio_postgres psql -U al_lio -d al_lio -Atc \
      'select count(*) from public.schema_migrations;'
  )"
  [[ "$AL_LIO_PRODUCTION_MIGRATION_COUNT" == "$AL_LIO_EXPECTED_MIGRATION_COUNT" ]]
  AL_LIO_APPLIED_MIGRATION_IDS="$AL_LIO_PENDING_MIGRATION_IDS"
  AL_LIO_ATTEMPT_OUTCOME=migrations-applied
  write_attempt_recovery_record
fi
```

If the reviewed release changes `data/learning-competencies.json`, the earlier
diff gate requires a verified PostgreSQL recovery point before running its
operator-managed import exactly once. Otherwise emit an explicit skip result.

```bash
if [[ "$AL_LIO_LEARNING_IMPORT_REQUIRED" -eq 0 ]]; then
  AL_LIO_LEARNING_IMPORT_RESULT=skipped
  printf 'SKIP: learning catalogue data is unchanged.\n'
else
  docker compose -f infra/docker-compose.prod.yml --env-file .env \
    --profile ops run --rm -T al_lio_migrator \
    node scripts/import-learning-competencies.mjs
  AL_LIO_LEARNING_IMPORT_RESULT=completed
  AL_LIO_ATTEMPT_OUTCOME=learning-import-completed
  write_attempt_recovery_record
  printf 'Learning catalogue import completed exactly once.\n'
fi
```

## 9. Cut over only web and prove the release

```bash
[[ "$(read_env_value AL_LIO_IMAGE_TAG .env)" == "$AL_LIO_RELEASE_SHA" ]]
[[ "$(read_env_value AL_LIO_RELEASE_SHA .env)" == "$AL_LIO_RELEASE_SHA" ]]
validate_release_worktree_integrity "$AL_LIO_RELEASE_DIR" "$AL_LIO_RELEASE_SHA" || {
  printf 'ERROR: %s\n' "$release_worktree_integrity_error" >&2
  exit 1
}
AL_LIO_ATTEMPT_OUTCOME=cutover-starting
write_attempt_recovery_record
AL_LIO_CUTOVER_STARTED=1
docker compose -f infra/docker-compose.prod.yml --env-file .env \
  up -d --no-deps al_lio_web
wait_for_web_health

[[ "$(docker inspect al_lio_web --format '{{.Config.Image}}')" == "al-lio-web:$AL_LIO_RELEASE_SHA" ]]
timeout 20s docker exec al_lio_web wget -T 5 -qO- \
  http://127.0.0.1:3000/api/health >/dev/null
timeout 20s docker exec al_lio_web wget -T 5 -qO- \
  http://127.0.0.1:3000/api/ready >/dev/null
[[ "$(timeout 20s docker exec al_lio_web wget -T 5 -qO- \
  http://127.0.0.1:3000/api/version)" == \
  "{\"releaseSha\":\"$AL_LIO_RELEASE_SHA\"}" ]]

[[ "$(docker inspect al_lio_postgres --format '{{.Id}}')" == "$AL_LIO_POSTGRES_ID" ]]
[[ "$(docker inspect al_lio_radar --format '{{.Id}}')" == "$AL_LIO_RADAR_ID" ]]
if [[ "$AL_LIO_RADAR_STOPPED" -eq 1 ]]; then
  docker start al_lio_radar >/dev/null
  AL_LIO_RADAR_STOPPED=0
fi
[[ "$(docker inspect al_lio_radar --format '{{.State.Status}}')" == running ]]
```

Verify public health, readiness, release identity and an unauthenticated
authorization boundary. A missing or mismatched `/api/version` fails release
validation even when health is green.

```bash
curl -fsS https://al-lio.app/api/health --connect-timeout 5 --max-time 20 >/dev/null
curl -fsS --connect-timeout 5 --max-time 20 "$AL_LIO_BASE_URL/api/ready" >/dev/null
[[ "$(curl -fsS --connect-timeout 5 --max-time 20 "$AL_LIO_BASE_URL/api/version")" == \
  "{\"releaseSha\":\"$AL_LIO_RELEASE_SHA\"}" ]]
[[ "$(curl -sS --connect-timeout 5 --max-time 20 -o /dev/null -w '%{http_code}' \
  "$AL_LIO_BASE_URL/api/job-radar")" == 401 ]]
```

## 10. Run the owner functional smoke

Use a dedicated, authorized test account with synthetic data. Do not enter
personal data, production credentials or tokens in the terminal or release
record. Keep this session open and enter the literal result requested by each
check; any other input stops the release review.

```bash
confirm_smoke() {
  local variable="$1" prompt="$2" result
  read -r -p "$prompt [type PASS]: " result
  [[ "$result" == PASS ]]
  printf -v "$variable" '%s' passed
}

confirm_smoke AL_LIO_SMOKE_LOGIN \
  "In a private browser session, verify login with the authorized non-personal test account"
confirm_smoke AL_LIO_SMOKE_GOOGLE_OAUTH \
  "Verify Google OAuth returns to AL-LIO without an auth error"
confirm_smoke AL_LIO_SMOKE_CALENDAR \
  "Verify Calendar connect/disconnect and restore the intended test-account state"
confirm_smoke AL_LIO_SMOKE_DASHBOARD \
  "Verify the dashboard loads its authenticated data"
confirm_smoke AL_LIO_SMOKE_TASK \
  "Create/complete/delete task using synthetic test content"
confirm_smoke AL_LIO_SMOKE_NOTE \
  "Create note + reload, verify persistence, then delete the note"
confirm_smoke AL_LIO_SMOKE_PROFILE \
  "Change profile/cycle, reload, verify profile/cycle persistence, then restore it"
confirm_smoke AL_LIO_SMOKE_RADAR_VISIBILITY \
  "Verify Radar visibility for the test account"

read -r -p "Controlled Radar approval/delivery was reviewed [type PASS or NOT_APPLICABLE]: " \
  AL_LIO_RADAR_DELIVERY_INPUT
case "$AL_LIO_RADAR_DELIVERY_INPUT" in
  PASS) AL_LIO_SMOKE_RADAR_DELIVERY=passed ;;
  NOT_APPLICABLE) AL_LIO_SMOKE_RADAR_DELIVERY=not-applicable ;;
  *) exit 1 ;;
esac
if [[ "$AL_LIO_SMOKE_RADAR_DELIVERY" == passed ]]; then
  confirm_smoke AL_LIO_SMOKE_RADAR_IDEMPOTENCY \
    "Replay the same controlled delivery and verify idempotent delivery"
else
  AL_LIO_SMOKE_RADAR_IDEMPOTENCY=not-applicable
fi

confirm_smoke AL_LIO_SMOKE_WORK "Verify Work loads for the test account"
confirm_smoke AL_LIO_SMOKE_COURSES "Verify Courses loads for the test account"
confirm_smoke AL_LIO_SMOKE_EVENTS \
  "Verify Events/Challenges loads for the test account"
```

Restart only `al_lio_web`, then prove persistence, release identity and
container preservation again. PostgreSQL and Radar must retain their original
container IDs.

```bash
docker restart al_lio_web >/dev/null
wait_for_web_health
[[ "$(docker inspect al_lio_web --format '{{.Config.Image}}')" == "al-lio-web:$AL_LIO_RELEASE_SHA" ]]
[[ "$(docker inspect al_lio_postgres --format '{{.Id}}')" == "$AL_LIO_POSTGRES_ID" ]]
[[ "$(docker inspect al_lio_radar --format '{{.Id}}')" == "$AL_LIO_RADAR_ID" ]]
[[ "$(timeout 20s docker exec al_lio_web wget -T 5 -qO- \
  http://127.0.0.1:3000/api/version)" == \
  "{\"releaseSha\":\"$AL_LIO_RELEASE_SHA\"}" ]]
[[ "$(curl -fsS --connect-timeout 5 --max-time 20 "$AL_LIO_BASE_URL/api/version")" == \
  "{\"releaseSha\":\"$AL_LIO_RELEASE_SHA\"}" ]]
confirm_smoke AL_LIO_SMOKE_RESTART_PERSISTENCE \
  "Reload the test account and verify task/note/profile state persisted after restarting only al_lio_web"
AL_LIO_FUNCTIONAL_SMOKE=passed
```

## 11. Write the private release record

The record contains identifiers and outcomes only. Do not record environment
values, credentials, tokens or connection strings.

```bash
[[ "$AL_LIO_RELEASE_RECORD" == "$AL_LIO_ATTEMPT_RECORD" ]]
AL_LIO_FINAL_RECORD_TEMP="$(mktemp "$AL_LIO_BACKUP_DIR/.final-record.XXXXXX")"
chmod 600 "$AL_LIO_FINAL_RECORD_TEMP"
{
  printf 'outcome=approved-exception\n'
  printf 'timestamp_utc=%s\n' "$AL_LIO_RELEASE_STARTED_AT"
  printf 'operator=%s\n' "$(id -un)"
  printf 'current_sha=%s\n' "$AL_LIO_CURRENT_SHA"
  printf 'candidate_sha=%s\n' "$AL_LIO_RELEASE_SHA"
  printf 'previous_release_path=%s\n' "$AL_LIO_PREVIOUS_RELEASE_DIR"
  printf 'candidate_release_path=%s\n' "$AL_LIO_RELEASE_DIR"
  printf 'base_url=%s\n' "$AL_LIO_BASE_URL"
  printf 'previous_image=%s\n' "$AL_LIO_CURRENT_IMAGE"
  printf 'candidate_image=al-lio-web:%s\n' "$AL_LIO_RELEASE_SHA"
  printf 'postgres_container_id=%s\n' "$AL_LIO_POSTGRES_ID"
  printf 'radar_container_id=%s\n' "$AL_LIO_RADAR_ID"
  printf 'policy_result=rejected-reviewed-exception\n'
  printf 'historical_exception=%s\n' "$AL_LIO_EXCEPTION_REASON"
  printf 'policy_log=%s\n' "$AL_LIO_POLICY_LOG"
  printf 'staged_approvals=none\nconsumed_approvals=none\nrevoked_approvals=none\n'
  printf 'pending_migration_ids=%s\n' "$AL_LIO_PENDING_MIGRATION_IDS"
  printf 'applied_migration_ids=%s\n' "$AL_LIO_APPLIED_MIGRATION_IDS"
  printf 'learning_import_result=%s\n' "$AL_LIO_LEARNING_IMPORT_RESULT"
  printf 'db_backup_path=%s\n' "$AL_LIO_POSTGRES_BACKUP"
  printf 'db_backup_checksum=%s\n' "$AL_LIO_POSTGRES_BACKUP_CHECKSUM"
  printf 'restore_verification=%s\n' "$AL_LIO_RESTORE_VERIFICATION"
  printf 'rehearsal=%s\n' "$AL_LIO_REHEARSAL_RESULT"
  printf 'radar_backup=%s\n' "$AL_LIO_RADAR_BACKUP"
  printf 'radar_backup_status=%s\n' "$AL_LIO_RADAR_BACKUP_STATUS"
  printf 'internal_health=passed\ninternal_ready=passed\ninternal_version=%s\n' "$AL_LIO_RELEASE_SHA"
  printf 'public_health=passed\npublic_ready=passed\npublic_version=%s\n' "$AL_LIO_RELEASE_SHA"
  printf 'smoke_result=%s\n' "$AL_LIO_FUNCTIONAL_SMOKE"
  printf 'smoke_login=%s\n' "$AL_LIO_SMOKE_LOGIN"
  printf 'smoke_google_oauth=%s\n' "$AL_LIO_SMOKE_GOOGLE_OAUTH"
  printf 'smoke_calendar=%s\n' "$AL_LIO_SMOKE_CALENDAR"
  printf 'smoke_dashboard=%s\n' "$AL_LIO_SMOKE_DASHBOARD"
  printf 'smoke_task=%s\n' "$AL_LIO_SMOKE_TASK"
  printf 'smoke_note=%s\n' "$AL_LIO_SMOKE_NOTE"
  printf 'smoke_profile=%s\n' "$AL_LIO_SMOKE_PROFILE"
  printf 'smoke_radar_visibility=%s\n' "$AL_LIO_SMOKE_RADAR_VISIBILITY"
  printf 'smoke_radar_delivery=%s\n' "$AL_LIO_SMOKE_RADAR_DELIVERY"
  printf 'smoke_radar_idempotency=%s\n' "$AL_LIO_SMOKE_RADAR_IDEMPOTENCY"
  printf 'smoke_work=%s\n' "$AL_LIO_SMOKE_WORK"
  printf 'smoke_courses=%s\n' "$AL_LIO_SMOKE_COURSES"
  printf 'smoke_events=%s\n' "$AL_LIO_SMOKE_EVENTS"
  printf 'smoke_restart_persistence=%s\n' "$AL_LIO_SMOKE_RESTART_PERSISTENCE"
  printf 'rollback_release_path=%s\n' "$AL_LIO_PREVIOUS_RELEASE_DIR"
  printf 'rollback_image=%s\n' "$AL_LIO_CURRENT_IMAGE"
  printf 'rollback_result=not-invoked\n'
} > "$AL_LIO_FINAL_RECORD_TEMP"
mv -f -- "$AL_LIO_FINAL_RECORD_TEMP" "$AL_LIO_RELEASE_RECORD"
unset AL_LIO_FINAL_RECORD_TEMP
[[ "$(stat -c '%a' "$AL_LIO_RELEASE_RECORD")" == 600 ]]

AL_LIO_CUTOVER_STARTED=0
trap - EXIT INT TERM
printf 'Release record: %s\n' "$AL_LIO_RELEASE_RECORD"
```

Keep the previous release worktree, private `.env`, image and verified backups
through the observation window.

## Delayed rollback and recovery initialization

Start a new SSH session with this block before either incident path below. It
parses one exact private release record as data; it never uses `source` or
`eval`. Unknown, duplicate and malformed keys stop recovery. Only the exact
historical release `dc6607ec88810d90e43d415e6781bc90e1c6612f` may omit
`AL_LIO_RELEASE_SHA` or leave it empty; every later release requires its exact
non-empty SHA.

```bash
set -Eeuo pipefail
umask 077
export LC_ALL=C
AL_LIO_RELEASES_DIR=/srv/danicode/releases
AL_LIO_BACKUP_DIR=/srv/danicode/backups/al-lio
export AL_LIO_SELECTED_RELEASE_RECORD="REPLACE_WITH_EXACT_PRIVATE_RELEASE_RECORD_PATH"

command -v flock >/dev/null || {
  printf 'CRITICAL: flock is required to serialize production recovery.\n' >&2
  exit 1
}
exec 9>"$AL_LIO_BACKUP_DIR/deploy-production.lock" || {
  printf 'CRITICAL: cannot open the shared production deployment lock.\n' >&2
  exit 1
}
if ! flock -n 9; then
  printf 'CRITICAL: another production deploy or recovery session holds the shared lock.\n' >&2
  exit 1
fi

if [[ "$AL_LIO_SELECTED_RELEASE_RECORD" == REPLACE_WITH_* ]]; then
  printf 'ERROR: select the exact release record before recovery.\n' >&2
  exit 1
fi
[[ "$AL_LIO_SELECTED_RELEASE_RECORD" == /* ]] || {
  printf 'ERROR: release record path must be absolute.\n' >&2
  exit 1
}
[[ -f "$AL_LIO_SELECTED_RELEASE_RECORD" && ! -L "$AL_LIO_SELECTED_RELEASE_RECORD" ]] || {
  printf 'ERROR: release record must be a regular file, not a symlink.\n' >&2
  exit 1
}
[[ "$(readlink -f -- "$AL_LIO_SELECTED_RELEASE_RECORD")" == \
  "$AL_LIO_SELECTED_RELEASE_RECORD" ]] || {
  printf 'ERROR: release record path is not canonical.\n' >&2
  exit 1
}
[[ "$AL_LIO_SELECTED_RELEASE_RECORD" == "$AL_LIO_BACKUP_DIR"/*.txt ]] || {
  printf 'ERROR: release record is outside the fixed production backup root.\n' >&2
  exit 1
}
[[ "$(stat -c '%a' "$AL_LIO_SELECTED_RELEASE_RECORD")" == 600 &&
  "$(stat -c '%u' "$AL_LIO_SELECTED_RELEASE_RECORD")" == "$(id -u)" ]] || {
  printf 'ERROR: release record must be private mode 600 and owned by this operator.\n' >&2
  exit 1
}
[[ "$(wc -c < "$AL_LIO_SELECTED_RELEASE_RECORD")" -le 65536 ]] || {
  printf 'ERROR: release record exceeds the 65536-byte limit.\n' >&2
  exit 1
}
command -v od >/dev/null || {
  printf 'ERROR: od is required for release-record byte validation.\n' >&2
  exit 1
}
if ! LC_ALL=C od -An -v -tu1 -- "$AL_LIO_SELECTED_RELEASE_RECORD" | awk '
  BEGIN { valid = 1; previous_cr = 0 }
  {
    for (field = 1; field <= NF; field++) {
      byte = $field + 0
      if (previous_cr && byte != 10) valid = 0
      if (byte == 13) {
        previous_cr = 1
        continue
      }
      previous_cr = 0
      if (byte == 10) continue
      if (byte < 32 || byte > 126) valid = 0
    }
  }
  END { if (!valid || previous_cr) exit 1 }
'; then
  printf 'ERROR: release record contains invalid raw bytes or an unpaired CR.\n' >&2
  exit 1
fi

declare -A AL_LIO_RECORD_VALUES=()
declare -A AL_LIO_RECORD_KEYS_SEEN=()
while IFS= read -r AL_LIO_RECORD_LINE || [[ -n "$AL_LIO_RECORD_LINE" ]]; do
  [[ "$AL_LIO_RECORD_LINE" != *$'\r'* && "$AL_LIO_RECORD_LINE" =~ ^([a-z][a-z0-9_]*)=(.*)$ ]] || {
    printf 'ERROR: malformed release-record line.\n' >&2
    exit 1
  }
  AL_LIO_RECORD_KEY="${BASH_REMATCH[1]}"
  AL_LIO_RECORD_VALUE="${BASH_REMATCH[2]}"
  [[ "$AL_LIO_RECORD_VALUE" =~ ^[[:print:]]*$ ]] || {
    printf 'ERROR: release-record value contains non-printable data.\n' >&2
    exit 1
  }
  case "$AL_LIO_RECORD_KEY" in
    outcome|timestamp_utc|operator|current_sha|candidate_sha|previous_release_path|candidate_release_path|base_url|previous_image|candidate_image|postgres_container_id|radar_container_id|policy_result|historical_exception|policy_log|staged_approvals|consumed_approvals|revoked_approvals|pending_migration_ids|applied_migration_ids|learning_import_result|db_backup_path|db_backup_checksum|restore_verification|rehearsal|radar_backup|radar_backup_status|internal_health|internal_ready|internal_version|public_health|public_ready|public_version|smoke_result|smoke_login|smoke_google_oauth|smoke_calendar|smoke_dashboard|smoke_task|smoke_note|smoke_profile|smoke_radar_visibility|smoke_radar_delivery|smoke_radar_idempotency|smoke_work|smoke_courses|smoke_events|smoke_restart_persistence|rollback_release_path|rollback_image|rollback_result) ;;
    *)
      printf 'ERROR: unknown release-record key: %s\n' "$AL_LIO_RECORD_KEY" >&2
      exit 1
      ;;
  esac
  [[ -z "${AL_LIO_RECORD_KEYS_SEEN[$AL_LIO_RECORD_KEY]:-}" ]] || {
    printf 'ERROR: duplicate release-record key: %s\n' "$AL_LIO_RECORD_KEY" >&2
    exit 1
  }
  AL_LIO_RECORD_KEYS_SEEN["$AL_LIO_RECORD_KEY"]=1
  AL_LIO_RECORD_VALUES["$AL_LIO_RECORD_KEY"]="$AL_LIO_RECORD_VALUE"
done < "$AL_LIO_SELECTED_RELEASE_RECORD"

for AL_LIO_REQUIRED_RECORD_KEY in outcome current_sha candidate_sha previous_release_path \
  candidate_release_path base_url previous_image candidate_image \
  postgres_container_id radar_container_id db_backup_path db_backup_checksum \
  learning_import_result; do
  [[ -v "AL_LIO_RECORD_VALUES[$AL_LIO_REQUIRED_RECORD_KEY]" ]] || {
    printf 'ERROR: release record is missing required key: %s\n' \
      "$AL_LIO_REQUIRED_RECORD_KEY" >&2
    exit 1
  }
done

export AL_LIO_CURRENT_SHA="${AL_LIO_RECORD_VALUES[current_sha]}"
export AL_LIO_RELEASE_SHA="${AL_LIO_RECORD_VALUES[candidate_sha]}"
export AL_LIO_PREVIOUS_RELEASE_DIR="${AL_LIO_RECORD_VALUES[previous_release_path]}"
export AL_LIO_RELEASE_DIR="${AL_LIO_RECORD_VALUES[candidate_release_path]}"
export AL_LIO_BASE_URL="${AL_LIO_RECORD_VALUES[base_url]}"
export AL_LIO_CURRENT_IMAGE="${AL_LIO_RECORD_VALUES[previous_image]}"
export AL_LIO_CANDIDATE_IMAGE="${AL_LIO_RECORD_VALUES[candidate_image]}"
export AL_LIO_POSTGRES_ID="${AL_LIO_RECORD_VALUES[postgres_container_id]}"
export AL_LIO_RADAR_ID="${AL_LIO_RECORD_VALUES[radar_container_id]}"
export AL_LIO_RECOVERY_BACKUP="${AL_LIO_RECORD_VALUES[db_backup_path]}"
export AL_LIO_RECOVERY_BACKUP_CHECKSUM="${AL_LIO_RECORD_VALUES[db_backup_checksum]}"
export AL_LIO_RECOVERY_ATTEMPT_OUTCOME="${AL_LIO_RECORD_VALUES[outcome]}"
export AL_LIO_RECOVERY_LEARNING_IMPORT_RESULT="${AL_LIO_RECORD_VALUES[learning_import_result]}"

[[ "$AL_LIO_CURRENT_SHA" =~ ^[0-9a-f]{40}$ &&
  "$AL_LIO_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'ERROR: release record contains an invalid release SHA.\n' >&2
  exit 1
}
AL_LIO_EXPECTED_PREVIOUS_RELEASE_DIR="$AL_LIO_RELEASES_DIR/al-lio-${AL_LIO_CURRENT_SHA:0:12}"
AL_LIO_EXPECTED_CANDIDATE_RELEASE_DIR="$AL_LIO_RELEASES_DIR/al-lio-${AL_LIO_RELEASE_SHA:0:12}"
[[ "$AL_LIO_PREVIOUS_RELEASE_DIR" == "$AL_LIO_EXPECTED_PREVIOUS_RELEASE_DIR" &&
  "$AL_LIO_RELEASE_DIR" == "$AL_LIO_EXPECTED_CANDIDATE_RELEASE_DIR" ]] || {
  printf 'ERROR: recorded release path is outside the exact SHA-derived release root.\n' >&2
  exit 1
}
for AL_LIO_RECORDED_RELEASE_DIR in \
  "$AL_LIO_EXPECTED_PREVIOUS_RELEASE_DIR" "$AL_LIO_EXPECTED_CANDIDATE_RELEASE_DIR"; do
  [[ "$AL_LIO_RECORDED_RELEASE_DIR" == /*/al-lio-* &&
    -d "$AL_LIO_RECORDED_RELEASE_DIR" && ! -L "$AL_LIO_RECORDED_RELEASE_DIR" &&
    "$(readlink -f -- "$AL_LIO_RECORDED_RELEASE_DIR")" == "$AL_LIO_RECORDED_RELEASE_DIR" ]] || {
    printf 'ERROR: release record contains an invalid immutable release path.\n' >&2
    exit 1
  }
done
[[ "$AL_LIO_CURRENT_IMAGE" == "al-lio-web:$AL_LIO_CURRENT_SHA" &&
  "$AL_LIO_CANDIDATE_IMAGE" == "al-lio-web:$AL_LIO_RELEASE_SHA" &&
  "$AL_LIO_BASE_URL" == https://* ]] || {
  printf 'ERROR: release record contains inconsistent runtime identity.\n' >&2
  exit 1
}

read_env_value() {
  local key="$1" env_file="$2" line value
  line="$(grep -E "^${key}=" "$env_file" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 1
  value="${line#*=}"
  value="${value%$'\r'}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

validate_recovery_integrity_helper_blob() {
  local metadata entry_path mode type object
  IFS=$'\t' read -r metadata entry_path < <(
    git -C "$AL_LIO_RELEASE_DIR" ls-tree "$AL_LIO_RELEASE_SHA" -- \
      scripts/lib/release-worktree-integrity.sh
  )
  read -r mode type object <<< "$metadata"
  [[ "$entry_path" == scripts/lib/release-worktree-integrity.sh &&
    "$mode" == 100644 && "$type" == blob &&
    "$object" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || {
    printf 'ERROR: candidate release-worktree integrity helper is not an exact 100644 blob.\n' >&2
    return 1
  }
  printf '%s' "$object"
}

AL_LIO_RECOVERY_INTEGRITY_OBJECT="$(validate_recovery_integrity_helper_blob)" || exit 1
AL_LIO_RECOVERY_VALIDATOR_DIR="$(
  mktemp -d "$AL_LIO_BACKUP_DIR/.recovery-integrity.XXXXXX"
)" || {
  printf 'ERROR: cannot create the private recovery integrity directory.\n' >&2
  exit 1
}
AL_LIO_RECOVERY_INTEGRITY_HELPER="$AL_LIO_RECOVERY_VALIDATOR_DIR/release-worktree-integrity.sh"
cleanup_recovery_integrity_helper() {
  local cleanup_failed=0
  if [[ -e "${AL_LIO_RECOVERY_INTEGRITY_HELPER:-}" ||
    -L "${AL_LIO_RECOVERY_INTEGRITY_HELPER:-}" ]]; then
    rm -f -- "$AL_LIO_RECOVERY_INTEGRITY_HELPER" || cleanup_failed=1
  fi
  if [[ -d "${AL_LIO_RECOVERY_VALIDATOR_DIR:-}" ]]; then
    rmdir -- "$AL_LIO_RECOVERY_VALIDATOR_DIR" || cleanup_failed=1
  fi
  [[ "$cleanup_failed" -eq 0 ]] || {
    printf 'ERROR: private recovery integrity directory cleanup failed.\n' >&2
    return 1
  }
}
if ! chmod 700 "$AL_LIO_RECOVERY_VALIDATOR_DIR"; then
  printf 'ERROR: cannot protect the private recovery integrity directory.\n' >&2
  if ! cleanup_recovery_integrity_helper; then
    exit 1
  fi
  exit 1
fi
if ! git -C "$AL_LIO_RELEASE_DIR" cat-file blob \
  "$AL_LIO_RECOVERY_INTEGRITY_OBJECT" > "$AL_LIO_RECOVERY_INTEGRITY_HELPER" ||
  ! chmod 600 "$AL_LIO_RECOVERY_INTEGRITY_HELPER"; then
  printf 'ERROR: cannot extract the reviewed recovery integrity helper.\n' >&2
  if ! cleanup_recovery_integrity_helper; then
    exit 1
  fi
  exit 1
fi
if ! source "$AL_LIO_RECOVERY_INTEGRITY_HELPER"; then
  printf 'ERROR: reviewed recovery integrity helper could not be loaded.\n' >&2
  if ! cleanup_recovery_integrity_helper; then
    exit 1
  fi
  exit 1
fi
if ! cleanup_recovery_integrity_helper; then
  exit 1
fi
unset AL_LIO_RECOVERY_INTEGRITY_OBJECT AL_LIO_RECOVERY_INTEGRITY_HELPER \
  AL_LIO_RECOVERY_VALIDATOR_DIR
unset -f cleanup_recovery_integrity_helper validate_recovery_integrity_helper_blob

AL_LIO_HISTORICAL_LEGACY_RELEASE_SHA=dc6607ec88810d90e43d415e6781bc90e1c6612f
resolve_previous_identity_requirement() {
  if [[ "$1" == "$AL_LIO_HISTORICAL_LEGACY_RELEASE_SHA" ]]; then
    printf 'optional'
  else
    printf 'required'
  fi
}
AL_LIO_PREVIOUS_IDENTITY_REQUIREMENT="$(
  resolve_previous_identity_requirement "$AL_LIO_CURRENT_SHA"
)"

validate_recovery_worktree() {
  local label="$1" release_dir="$2" expected_sha="$3" identity_requirement="$4"
  local env_file="$release_dir/.env" image_tag release_identity
  if ! validate_release_worktree_integrity "$release_dir" "$expected_sha"; then
    printf 'ERROR: %s worktree integrity failed: %s\n' \
      "$label" "$release_worktree_integrity_error" >&2
    return 1
  fi
  [[ -f "$env_file" && ! -L "$env_file" &&
    "$(readlink -f -- "$env_file")" == "$env_file" ]] || {
    printf 'ERROR: %s release .env must be one canonical regular file.\n' "$label" >&2
    return 1
  }
  [[ "$(stat -c %a -- "$env_file")" == 600 &&
    "$(stat -c %u -- "$env_file")" == "$(id -u)" ]] || {
    printf 'ERROR: %s release .env must be mode 600 and owned by the operator.\n' \
      "$label" >&2
    return 1
  }
  image_tag="$(read_env_value AL_LIO_IMAGE_TAG "$env_file")" || {
    printf 'ERROR: %s release .env has no AL_LIO_IMAGE_TAG.\n' "$label" >&2
    return 1
  }
  [[ "$image_tag" == "$expected_sha" ]] || {
    printf 'ERROR: %s release image tag does not match its SHA.\n' "$label" >&2
    return 1
  }
  case "$identity_requirement" in
    required)
      release_identity="$(read_env_value AL_LIO_RELEASE_SHA "$env_file")" || {
        printf 'ERROR: %s release .env has no mandatory AL_LIO_RELEASE_SHA.\n' \
          "$label" >&2
        return 1
      }
      [[ -n "$release_identity" ]] || {
        printf 'ERROR: %s release .env has an empty mandatory AL_LIO_RELEASE_SHA.\n' \
          "$label" >&2
        return 1
      }
      [[ "$release_identity" == "$expected_sha" ]] || {
        printf 'ERROR: %s release identity does not match its SHA.\n' "$label" >&2
        return 1
      }
      ;;
    optional)
      release_identity="$(read_env_value AL_LIO_RELEASE_SHA "$env_file" || true)"
      [[ -z "$release_identity" || "$release_identity" == "$expected_sha" ]] || {
        printf 'ERROR: %s release identity does not match its SHA.\n' "$label" >&2
        return 1
      }
      ;;
    *)
      printf 'ERROR: invalid recovery release-identity requirement.\n' >&2
      return 1
      ;;
  esac
}

validate_recovery_worktree previous \
  "$AL_LIO_PREVIOUS_RELEASE_DIR" "$AL_LIO_CURRENT_SHA" \
  "$AL_LIO_PREVIOUS_IDENTITY_REQUIREMENT"
validate_recovery_worktree candidate \
  "$AL_LIO_RELEASE_DIR" "$AL_LIO_RELEASE_SHA" required

AL_LIO_RECOVERY_INCIDENT_LOG="${AL_LIO_SELECTED_RELEASE_RECORD%.txt}-recovery-$(date -u +%Y%m%dT%H%M%SZ).txt"
record_delayed_recovery_event() {
  local action="$1" result="$2" detail="$3"
  {
    printf 'timestamp_utc=%s action=%s result=%s detail=%s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$action" "$result" "$detail"
  } >> "$AL_LIO_RECOVERY_INCIDENT_LOG" || return 1
  chmod 600 "$AL_LIO_RECOVERY_INCIDENT_LOG"
}

wait_for_web_health() {
  local attempt state health
  for ((attempt = 1; attempt <= 30; attempt++)); do
    state="$(docker inspect al_lio_web --format '{{.State.Status}}' 2>/dev/null || true)"
    health="$(docker inspect al_lio_web --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
    [[ "$state" == running && "$health" == healthy ]] && return 0
    [[ "$state" == exited || "$health" == unhealthy ]] && return 1
    sleep 5
  done
  return 1
}

unset AL_LIO_RECORD_LINE AL_LIO_RECORD_KEY AL_LIO_RECORD_VALUE \
  AL_LIO_REQUIRED_RECORD_KEY AL_LIO_RECORDED_RELEASE_DIR \
  AL_LIO_EXPECTED_PREVIOUS_RELEASE_DIR AL_LIO_EXPECTED_CANDIDATE_RELEASE_DIR
unset AL_LIO_RECORD_KEYS_SEEN AL_LIO_RECORD_VALUES
```

## Application rollback

Application rollback uses the previous immutable release and its own `.env`.
It does not rewrite either checkout and does not reverse additive migrations.

```bash
perform_application_rollback() {
  local active_web_image active_postgres_id active_radar_id
  validate_recovery_worktree previous \
    "$AL_LIO_PREVIOUS_RELEASE_DIR" "$AL_LIO_CURRENT_SHA" \
    "$AL_LIO_PREVIOUS_IDENTITY_REQUIREMENT" || return 1

  active_web_image="$(
    docker inspect al_lio_web --format '{{.Config.Image}}'
  )" || {
    printf 'CRITICAL: cannot inspect the active web image before application rollback.\n' >&2
    return 1
  }
  if [[ "$active_web_image" != "$AL_LIO_CANDIDATE_IMAGE" &&
    "$active_web_image" != "$AL_LIO_CURRENT_IMAGE" ]]; then
    printf 'CRITICAL: active web image does not match the selected recovery record.\n' >&2
    return 1
  fi
  active_postgres_id="$(
    docker inspect al_lio_postgres --format '{{.Id}}'
  )" || {
    printf 'CRITICAL: cannot inspect PostgreSQL before application rollback.\n' >&2
    return 1
  }
  [[ "$active_postgres_id" == "$AL_LIO_POSTGRES_ID" ]] || {
    printf 'CRITICAL: PostgreSQL container identity does not match the selected recovery record.\n' >&2
    return 1
  }
  active_radar_id="$(
    docker inspect al_lio_radar --format '{{.Id}}'
  )" || {
    printf 'CRITICAL: cannot inspect Radar before application rollback.\n' >&2
    return 1
  }
  [[ "$active_radar_id" == "$AL_LIO_RADAR_ID" ]] || {
    printf 'CRITICAL: Radar container identity does not match the selected recovery record.\n' >&2
    return 1
  }

  cd "$AL_LIO_PREVIOUS_RELEASE_DIR" || return 1
  docker compose -f infra/docker-compose.prod.yml --env-file .env \
    up -d --no-deps al_lio_web || return 1
  wait_for_web_health || return 1
  [[ "$(docker inspect al_lio_web --format '{{.Config.Image}}')" == \
    "$AL_LIO_CURRENT_IMAGE" ]] || return 1
  timeout 20s docker exec al_lio_web wget -T 5 -qO- \
    http://127.0.0.1:3000/api/health >/dev/null || return 1
  timeout 20s docker exec al_lio_web wget -T 5 -qO- \
    http://127.0.0.1:3000/api/ready >/dev/null || return 1
  curl -fsS --connect-timeout 5 --max-time 20 \
    "$AL_LIO_BASE_URL/api/health" >/dev/null || return 1
  curl -fsS --connect-timeout 5 --max-time 20 \
    "$AL_LIO_BASE_URL/api/ready" >/dev/null || return 1

  AL_LIO_ROLLBACK_RELEASE_IDENTITY="$(read_env_value AL_LIO_RELEASE_SHA .env || true)"
  if [[ -n "$AL_LIO_ROLLBACK_RELEASE_IDENTITY" ]]; then
    [[ "$AL_LIO_ROLLBACK_RELEASE_IDENTITY" == "$AL_LIO_CURRENT_SHA" ]] || return 1
    [[ "$(curl -fsS --connect-timeout 5 --max-time 20 \
      "$AL_LIO_BASE_URL/api/version")" == \
      "{\"releaseSha\":\"$AL_LIO_CURRENT_SHA\"}" ]] || return 1
  fi
  [[ "$(docker inspect al_lio_postgres --format '{{.Id}}')" == \
    "$AL_LIO_POSTGRES_ID" ]] || return 1
  [[ "$(docker inspect al_lio_radar --format '{{.Id}}')" == \
    "$AL_LIO_RADAR_ID" ]] || return 1
  [[ "$(docker inspect al_lio_radar --format '{{.State.Status}}')" == running ]] || return 1
}

if ! perform_application_rollback; then
  printf 'CRITICAL: application rollback failed; production requires operator recovery.\n' >&2
  record_delayed_recovery_event application-rollback failed runtime-validation || {
    printf 'CRITICAL: rollback failure evidence could not be written.\n' >&2
  }
  exit 1
fi
record_delayed_recovery_event application-rollback restored previous-release || {
  printf 'CRITICAL: rollback completed but evidence could not be written.\n' >&2
  exit 1
}
printf 'Application rollback restored the recorded previous release. Evidence: %s\n' \
  "$AL_LIO_RECOVERY_INCIDENT_LOG"
```

## Database recovery after an incompatible migration

Database restore discards writes after the selected backup. Obtain explicit
incident authorization, select the dump from the release record, preserve the
damaged state, and stop both writers. This is never routine application
rollback.

```bash
[[ "$AL_LIO_RECOVERY_BACKUP" != not-required &&
  "$AL_LIO_RECOVERY_BACKUP_CHECKSUM" =~ ^[0-9a-f]{64}$ ]] || {
  printf 'ERROR: selected release record has no exact database recovery point.\n' >&2
  exit 1
}
[[ "$AL_LIO_RECOVERY_BACKUP" == "$AL_LIO_BACKUP_DIR"/*.dump &&
  -f "$AL_LIO_RECOVERY_BACKUP" &&
  ! -L "$AL_LIO_RECOVERY_BACKUP" && -s "$AL_LIO_RECOVERY_BACKUP" ]] || {
  printf 'ERROR: recorded database backup is not one exact regular file.\n' >&2
  exit 1
}
[[ "$(readlink -f -- "$AL_LIO_RECOVERY_BACKUP")" == "$AL_LIO_RECOVERY_BACKUP" &&
  -f "$AL_LIO_RECOVERY_BACKUP.sha256" && ! -L "$AL_LIO_RECOVERY_BACKUP.sha256" ]] || {
  printf 'ERROR: recorded database backup path or checksum sidecar is invalid.\n' >&2
  exit 1
}
[[ "$(sha256sum "$AL_LIO_RECOVERY_BACKUP" | awk '{ print $1 }')" == \
  "$AL_LIO_RECOVERY_BACKUP_CHECKSUM" ]] || {
  printf 'ERROR: recorded database backup checksum does not match.\n' >&2
  exit 1
}
[[ "$(cat -- "$AL_LIO_RECOVERY_BACKUP.sha256")" == \
  "$AL_LIO_RECOVERY_BACKUP_CHECKSUM  $AL_LIO_RECOVERY_BACKUP" ]] || {
  printf 'ERROR: database backup checksum sidecar has different provenance.\n' >&2
  exit 1
}
sha256sum --check "$AL_LIO_RECOVERY_BACKUP.sha256"
validate_recovery_worktree candidate \
  "$AL_LIO_RELEASE_DIR" "$AL_LIO_RELEASE_SHA" required || {
  printf 'CRITICAL: candidate recovery worktree validation failed.\n' >&2
  exit 1
}
AL_LIO_PRE_VERIFY_POSTGRES_ID="$(
  docker inspect al_lio_postgres --format '{{.Id}}'
)" || {
  printf 'CRITICAL: cannot inspect PostgreSQL before backup verification.\n' >&2
  exit 1
}
[[ "$AL_LIO_PRE_VERIFY_POSTGRES_ID" == "$AL_LIO_POSTGRES_ID" ]] || {
  printf 'CRITICAL: PostgreSQL container identity changed before backup verification.\n' >&2
  exit 1
}
unset AL_LIO_PRE_VERIFY_POSTGRES_ID
AL_LIO_PRE_VERIFY_POSTGRES_IDENTITY=validated
bash "$AL_LIO_RELEASE_DIR/scripts/postgres/verify-backup-production.sh" \
  "$AL_LIO_RECOVERY_BACKUP"

validate_pre_destructive_container_identity() {
  local actual_postgres_id actual_radar_id actual_web_image
  actual_postgres_id="$(docker inspect al_lio_postgres --format '{{.Id}}')" || {
    printf 'CRITICAL: cannot inspect the recorded PostgreSQL container.\n' >&2
    return 1
  }
  actual_radar_id="$(docker inspect al_lio_radar --format '{{.Id}}')" || {
    printf 'CRITICAL: cannot inspect the recorded Radar container.\n' >&2
    return 1
  }
  actual_web_image="$(docker inspect al_lio_web --format '{{.Config.Image}}')" || {
    printf 'CRITICAL: cannot inspect the recorded web runtime.\n' >&2
    return 1
  }
  [[ "$actual_postgres_id" == "$AL_LIO_POSTGRES_ID" &&
    "$actual_radar_id" == "$AL_LIO_RADAR_ID" &&
    ( "$actual_web_image" == "$AL_LIO_CURRENT_IMAGE" ||
      "$actual_web_image" == "$AL_LIO_CANDIDATE_IMAGE" ) ]] || {
    printf 'CRITICAL: recorded container identity does not match the recovery target.\n' >&2
    return 1
  }
}

if ! validate_pre_destructive_container_identity; then
  exit 1
fi
AL_LIO_PRE_DESTRUCTIVE_CONTAINER_IDENTITY=validated
docker stop --time 30 al_lio_radar >/dev/null
docker stop --time 30 al_lio_web >/dev/null
[[ "$(docker inspect al_lio_radar --format '{{.State.Status}}')" == exited &&
  "$(docker inspect al_lio_web --format '{{.State.Status}}')" == exited ]] || {
  printf 'CRITICAL: both application writers must be stopped before damaged-state backup.\n' >&2
  exit 1
}

AL_LIO_DAMAGED_BACKUP_DIR="$(dirname "$AL_LIO_SELECTED_RELEASE_RECORD")/damaged-state"
validate_recovery_worktree candidate \
  "$AL_LIO_RELEASE_DIR" "$AL_LIO_RELEASE_SHA" required || {
  printf 'CRITICAL: candidate recovery worktree changed before damaged-state backup.\n' >&2
  exit 1
}
AL_LIO_DAMAGED_BACKUP_OUTPUT="$(
  AL_LIO_BACKUP_DIR="$AL_LIO_DAMAGED_BACKUP_DIR" \
    bash "$AL_LIO_RELEASE_DIR/scripts/postgres/backup-production.sh"
)"
mapfile -t AL_LIO_DAMAGED_BACKUP_PATHS < <(
  sed -n 's/^Backup creado y validado: //p' <<< "$AL_LIO_DAMAGED_BACKUP_OUTPUT"
)
[[ "${#AL_LIO_DAMAGED_BACKUP_PATHS[@]}" -eq 1 ]]
AL_LIO_DAMAGED_STATE_BACKUP="${AL_LIO_DAMAGED_BACKUP_PATHS[0]}"
unset AL_LIO_DAMAGED_BACKUP_PATHS
[[ "$AL_LIO_DAMAGED_STATE_BACKUP" == "$AL_LIO_DAMAGED_BACKUP_DIR"/*.dump &&
  -f "$AL_LIO_DAMAGED_STATE_BACKUP" && ! -L "$AL_LIO_DAMAGED_STATE_BACKUP" &&
  -s "$AL_LIO_DAMAGED_STATE_BACKUP" &&
  "$(readlink -f -- "$AL_LIO_DAMAGED_STATE_BACKUP")" == \
    "$AL_LIO_DAMAGED_STATE_BACKUP" &&
  -f "$AL_LIO_DAMAGED_STATE_BACKUP.sha256" &&
  ! -L "$AL_LIO_DAMAGED_STATE_BACKUP.sha256" ]] || {
  printf 'CRITICAL: damaged-state backup path is not exact and regular.\n' >&2
  exit 1
}
AL_LIO_DAMAGED_STATE_BACKUP_CHECKSUM="$(
  sha256sum "$AL_LIO_DAMAGED_STATE_BACKUP" | awk '{ print $1 }'
)"
[[ "$AL_LIO_DAMAGED_STATE_BACKUP_CHECKSUM" =~ ^[0-9a-f]{64}$ ]]
[[ "$(cat -- "$AL_LIO_DAMAGED_STATE_BACKUP.sha256")" == \
  "$AL_LIO_DAMAGED_STATE_BACKUP_CHECKSUM  $AL_LIO_DAMAGED_STATE_BACKUP" ]]
sha256sum --check "$AL_LIO_DAMAGED_STATE_BACKUP.sha256"
record_delayed_recovery_event database-recovery damaged-state-preserved \
  "$AL_LIO_DAMAGED_STATE_BACKUP:$AL_LIO_DAMAGED_STATE_BACKUP_CHECKSUM" || {
  printf 'CRITICAL: damaged-state backup evidence could not be written.\n' >&2
  exit 1
}

if ! validate_pre_destructive_container_identity; then
  exit 1
fi
docker exec al_lio_postgres psql -U al_lio -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'al_lio' AND pid <> pg_backend_pid();"
docker exec al_lio_postgres dropdb -U al_lio al_lio
docker exec al_lio_postgres createdb -U al_lio al_lio
docker exec -i al_lio_postgres pg_restore \
  -U al_lio -d al_lio --exit-on-error --no-owner --no-acl \
  < "$AL_LIO_RECOVERY_BACKUP"

perform_database_recovery_runtime_validation() {
  local release_identity
  validate_recovery_worktree previous \
    "$AL_LIO_PREVIOUS_RELEASE_DIR" "$AL_LIO_CURRENT_SHA" \
    "$AL_LIO_PREVIOUS_IDENTITY_REQUIREMENT" || return 1
  cd "$AL_LIO_PREVIOUS_RELEASE_DIR" || return 1
  docker compose -f infra/docker-compose.prod.yml --env-file .env \
    up -d --no-deps al_lio_web || return 1
  wait_for_web_health || return 1
  docker start al_lio_radar >/dev/null || return 1
  [[ "$(docker inspect al_lio_web --format '{{.Config.Image}}')" == \
    "$AL_LIO_CURRENT_IMAGE" ]] || return 1
  [[ "$(docker inspect al_lio_postgres --format '{{.Id}}')" == \
    "$AL_LIO_POSTGRES_ID" ]] || return 1
  [[ "$(docker inspect al_lio_radar --format '{{.Id}}')" == \
    "$AL_LIO_RADAR_ID" ]] || return 1
  [[ "$(docker inspect al_lio_radar --format '{{.State.Status}}')" == running ]] || return 1
  timeout 20s docker exec al_lio_web wget -T 5 -qO- \
    http://127.0.0.1:3000/api/health >/dev/null || return 1
  timeout 20s docker exec al_lio_web wget -T 5 -qO- \
    http://127.0.0.1:3000/api/ready >/dev/null || return 1
  curl -fsS --connect-timeout 5 --max-time 20 \
    "$AL_LIO_BASE_URL/api/health" >/dev/null || return 1
  curl -fsS --connect-timeout 5 --max-time 20 \
    "$AL_LIO_BASE_URL/api/ready" >/dev/null || return 1
  release_identity="$(read_env_value AL_LIO_RELEASE_SHA .env || true)"
  if [[ -n "$release_identity" ]]; then
    [[ "$release_identity" == "$AL_LIO_CURRENT_SHA" ]] || return 1
    [[ "$(timeout 20s docker exec al_lio_web wget -T 5 -qO- \
      http://127.0.0.1:3000/api/version)" == \
      "{\"releaseSha\":\"$AL_LIO_CURRENT_SHA\"}" ]] || return 1
    [[ "$(curl -fsS --connect-timeout 5 --max-time 20 \
      "$AL_LIO_BASE_URL/api/version")" == \
      "{\"releaseSha\":\"$AL_LIO_CURRENT_SHA\"}" ]] || return 1
  fi
}

if ! perform_database_recovery_runtime_validation; then
  printf 'CRITICAL: database recovery runtime identity validation failed.\n' >&2
  record_delayed_recovery_event database-recovery failed runtime-identity || {
    printf 'CRITICAL: database recovery failure evidence could not be written.\n' >&2
  }
  exit 1
fi
record_delayed_recovery_event database-recovery restored \
  "$AL_LIO_RECOVERY_BACKUP:$AL_LIO_RECOVERY_BACKUP_CHECKSUM"
```

Record the recovery point, damaged-state backup, authorization and validation
results in the incident log. Never delete Docker volumes as cleanup.
