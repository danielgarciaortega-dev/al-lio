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
export AL_LIO_RELEASE_SHA=<full-40-character-reviewed-main-sha>
export AL_LIO_EXCEPTION_REASON=<reviewed-ticket-or-change-reference>

[[ "$AL_LIO_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ -n "$AL_LIO_EXCEPTION_REASON" ]]
[[ "$(id -u)" -ne 0 ]]
mkdir -p -- "$AL_LIO_RELEASES_DIR" "$AL_LIO_BACKUP_DIR"
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
  value="${value%$'\\r'}"
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

cleanup_manual_release() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$AL_LIO_REHEARSAL_DB" ]]; then
    docker exec al_lio_postgres dropdb -U al_lio --if-exists \
      "$AL_LIO_REHEARSAL_DB" >/dev/null 2>&1 || true
  fi
  if [[ "$status" -ne 0 && "$AL_LIO_CUTOVER_STARTED" -eq 1 ]]; then
    (
      cd "$AL_LIO_PREVIOUS_RELEASE_DIR"
      docker compose -f infra/docker-compose.prod.yml --env-file .env \
        up -d --no-deps al_lio_web </dev/null
    ) || true
    wait_for_web_health || true
  fi
  if [[ "$AL_LIO_RADAR_STOPPED" -eq 1 ]]; then
    docker start al_lio_radar >/dev/null || true
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

For the historical `dc6607e` transition, missing current-release approval data
and the six deliberate environment mapping removals remain an expected manual
exception. Do not add approvals after the removal has happened. Review each
exact removed service, destination key, source variable and default.

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
if grep -q 'PENDIENTE' <<< "$AL_LIO_MIGRATION_STATUS"; then
  AL_LIO_MIGRATION_REQUIRED=1
  AL_LIO_PENDING_MIGRATION_IDS="$(
    awk '$1 == "PENDIENTE" { value = value (value ? "," : "") $2 } END { print value }' \
      <<< "$AL_LIO_MIGRATION_STATUS"
  )"
  [[ -n "$AL_LIO_PENDING_MIGRATION_IDS" ]]
fi
```

When migrations are pending, create a custom-format dump and run the full
restore test before rehearsal.

```bash
if [[ "$AL_LIO_MIGRATION_REQUIRED" -eq 1 ]]; then
  AL_LIO_BACKUP_OUTPUT="$(
    AL_LIO_BACKUP_DIR="$AL_LIO_BACKUP_DIR" \
      bash scripts/postgres/backup-production.sh
  )"
  printf '%s\n' "$AL_LIO_BACKUP_OUTPUT"
  AL_LIO_POSTGRES_BACKUP="$(
    sed -n 's/^Backup creado y validado: //p' <<< "$AL_LIO_BACKUP_OUTPUT" | tail -n 1
  )"
  [[ -n "$AL_LIO_POSTGRES_BACKUP" && -s "$AL_LIO_POSTGRES_BACKUP" ]]
  [[ -s "$AL_LIO_POSTGRES_BACKUP.sha256" ]]
  sha256sum --check "$AL_LIO_POSTGRES_BACKUP.sha256"
  AL_LIO_POSTGRES_BACKUP_CHECKSUM="$(sha256sum "$AL_LIO_POSTGRES_BACKUP" | awk '{ print $1 }')"
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
fi
```

If the reviewed release changes `data/learning-competencies.json`, run its
operator-managed import only after migrations pass; otherwise skip it.

```bash
docker compose -f infra/docker-compose.prod.yml --env-file .env \
  --profile ops run --rm -T al_lio_migrator \
  node scripts/import-learning-competencies.mjs
```

## 9. Cut over only web and prove the release

```bash
[[ "$(read_env_value AL_LIO_IMAGE_TAG .env)" == "$AL_LIO_RELEASE_SHA" ]]
[[ "$(read_env_value AL_LIO_RELEASE_SHA .env)" == "$AL_LIO_RELEASE_SHA" ]]
validate_release_worktree_integrity "$AL_LIO_RELEASE_DIR" "$AL_LIO_RELEASE_SHA" || {
  printf 'ERROR: %s\n' "$release_worktree_integrity_error" >&2
  exit 1
}
AL_LIO_CUTOVER_STARTED=1
docker compose -f infra/docker-compose.prod.yml --env-file .env \
  up -d --no-deps al_lio_web
wait_for_web_health

[[ "$(docker inspect al_lio_web --format '{{.Config.Image}}')" == "al-lio-web:$AL_LIO_RELEASE_SHA" ]]
docker exec al_lio_web wget -qO- http://127.0.0.1:3000/api/health >/dev/null
docker exec al_lio_web wget -qO- http://127.0.0.1:3000/api/ready >/dev/null
[[ "$(docker exec al_lio_web wget -qO- http://127.0.0.1:3000/api/version)" == \
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
curl -fsS https://al-lio.app/api/health >/dev/null
curl -fsS "$AL_LIO_BASE_URL/api/ready" >/dev/null
[[ "$(curl -fsS "$AL_LIO_BASE_URL/api/version")" == \
  "{\"releaseSha\":\"$AL_LIO_RELEASE_SHA\"}" ]]
[[ "$(curl -sS -o /dev/null -w '%{http_code}' "$AL_LIO_BASE_URL/api/job-radar")" == 401 ]]
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
[[ "$(docker exec al_lio_web wget -qO- http://127.0.0.1:3000/api/version)" == \
  "{\"releaseSha\":\"$AL_LIO_RELEASE_SHA\"}" ]]
[[ "$(curl -fsS "$AL_LIO_BASE_URL/api/version")" == \
  "{\"releaseSha\":\"$AL_LIO_RELEASE_SHA\"}" ]]
confirm_smoke AL_LIO_SMOKE_RESTART_PERSISTENCE \
  "Reload the test account and verify task/note/profile state persisted after restarting only al_lio_web"
AL_LIO_FUNCTIONAL_SMOKE=passed
```

## 11. Write the private release record

The record contains identifiers and outcomes only. Do not record environment
values, credentials, tokens or connection strings.

```bash
export AL_LIO_RELEASE_RECORD="$AL_LIO_BACKUP_DIR/release-$AL_LIO_RELEASE_STARTED_AT-${AL_LIO_RELEASE_SHA:0:12}.txt"
{
  printf 'outcome=approved-exception\n'
  printf 'timestamp_utc=%s\n' "$AL_LIO_RELEASE_STARTED_AT"
  printf 'operator=%s\n' "$(id -un)"
  printf 'current_sha=%s\n' "$AL_LIO_CURRENT_SHA"
  printf 'candidate_sha=%s\n' "$AL_LIO_RELEASE_SHA"
  printf 'previous_release_path=%s\n' "$AL_LIO_PREVIOUS_RELEASE_DIR"
  printf 'candidate_release_path=%s\n' "$AL_LIO_RELEASE_DIR"
  printf 'previous_image=%s\n' "$AL_LIO_CURRENT_IMAGE"
  printf 'candidate_image=al-lio-web:%s\n' "$AL_LIO_RELEASE_SHA"
  printf 'policy_result=rejected-reviewed-exception\n'
  printf 'historical_exception=%s\n' "$AL_LIO_EXCEPTION_REASON"
  printf 'policy_log=%s\n' "$AL_LIO_POLICY_LOG"
  printf 'staged_approvals=none\nconsumed_approvals=none\nrevoked_approvals=none\n'
  printf 'pending_migration_ids=%s\n' "$AL_LIO_PENDING_MIGRATION_IDS"
  printf 'applied_migration_ids=%s\n' "$AL_LIO_APPLIED_MIGRATION_IDS"
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
} > "$AL_LIO_RELEASE_RECORD"
chmod 600 "$AL_LIO_RELEASE_RECORD"
[[ "$(stat -c '%a' "$AL_LIO_RELEASE_RECORD")" == 600 ]]

AL_LIO_CUTOVER_STARTED=0
trap - EXIT INT TERM
printf 'Release record: %s\n' "$AL_LIO_RELEASE_RECORD"
```

Keep the previous release worktree, private `.env`, image and verified backups
through the observation window.

## Application rollback

Application rollback uses the previous immutable release and its own `.env`.
It does not rewrite either checkout and does not reverse additive migrations.

```bash
cd "$AL_LIO_PREVIOUS_RELEASE_DIR"
docker compose -f infra/docker-compose.prod.yml --env-file .env \
  up -d --no-deps al_lio_web
wait_for_web_health

[[ "$(docker inspect al_lio_web --format '{{.Config.Image}}')" == "$AL_LIO_CURRENT_IMAGE" ]]
docker exec al_lio_web wget -qO- http://127.0.0.1:3000/api/health >/dev/null
docker exec al_lio_web wget -qO- http://127.0.0.1:3000/api/ready >/dev/null
curl -fsS "$AL_LIO_BASE_URL/api/health" >/dev/null
curl -fsS "$AL_LIO_BASE_URL/api/ready" >/dev/null

AL_LIO_ROLLBACK_RELEASE_IDENTITY="$(read_env_value AL_LIO_RELEASE_SHA .env || true)"
if [[ -n "$AL_LIO_ROLLBACK_RELEASE_IDENTITY" ]]; then
  [[ "$AL_LIO_ROLLBACK_RELEASE_IDENTITY" == "$AL_LIO_CURRENT_SHA" ]]
  [[ "$(curl -fsS "$AL_LIO_BASE_URL/api/version")" == \
    "{\"releaseSha\":\"$AL_LIO_CURRENT_SHA\"}" ]]
fi
[[ "$(docker inspect al_lio_postgres --format '{{.Id}}')" == "$AL_LIO_POSTGRES_ID" ]]
[[ "$(docker inspect al_lio_radar --format '{{.Id}}')" == "$AL_LIO_RADAR_ID" ]]
[[ "$(docker inspect al_lio_radar --format '{{.State.Status}}')" == running ]]
```

## Database recovery after an incompatible migration

Database restore discards writes after the selected backup. Obtain explicit
incident authorization, select the dump from the release record, preserve the
damaged state, and stop both writers. This is never routine application
rollback.

```bash
export AL_LIO_RECOVERY_BACKUP=<exact-verified-dump-from-release-record>
[[ -s "$AL_LIO_RECOVERY_BACKUP" ]]
[[ -s "$AL_LIO_RECOVERY_BACKUP.sha256" ]]
sha256sum --check "$AL_LIO_RECOVERY_BACKUP.sha256"
bash "$AL_LIO_RELEASE_DIR/scripts/postgres/verify-backup-production.sh" \
  "$AL_LIO_RECOVERY_BACKUP"

AL_LIO_BACKUP_DIR="$AL_LIO_BACKUP_DIR/damaged-state" \
  bash "$AL_LIO_RELEASE_DIR/scripts/postgres/backup-production.sh"

docker stop --time 30 al_lio_radar >/dev/null
docker stop --time 30 al_lio_web >/dev/null
docker exec al_lio_postgres psql -U al_lio -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'al_lio' AND pid <> pg_backend_pid();"
docker exec al_lio_postgres dropdb -U al_lio al_lio
docker exec al_lio_postgres createdb -U al_lio al_lio
docker exec -i al_lio_postgres pg_restore \
  -U al_lio -d al_lio --exit-on-error --no-owner --no-acl \
  < "$AL_LIO_RECOVERY_BACKUP"

cd "$AL_LIO_PREVIOUS_RELEASE_DIR"
docker compose -f infra/docker-compose.prod.yml --env-file .env \
  up -d --no-deps al_lio_web
wait_for_web_health
docker start al_lio_radar >/dev/null
docker exec al_lio_web wget -qO- http://127.0.0.1:3000/api/ready >/dev/null
curl -fsS "$AL_LIO_BASE_URL/api/health" >/dev/null
curl -fsS "$AL_LIO_BASE_URL/api/ready" >/dev/null
```

Record the recovery point, damaged-state backup, authorization and validation
results in the incident log. Never delete Docker volumes as cleanup.
