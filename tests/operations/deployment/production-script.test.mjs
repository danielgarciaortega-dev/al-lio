// Source-level assertions intentionally protect the production shell contract because executing it would mutate remote state.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const deployScriptUrl = new URL("../../../scripts/deploy-production.sh", import.meta.url);
const transitionPolicyUrl = new URL("../../../scripts/lib/production-transition-policy.sh", import.meta.url);
const composeGuardUrl = new URL("../../../scripts/lib/compose-env-guard.sh", import.meta.url);
const approvalsUrl = new URL("../../../scripts/config/production-compose-env-removals.allowlist", import.meta.url);
const releaseEnvUrl = new URL("../../../scripts/prepare-release-env.sh", import.meta.url);
const worktreeIntegrityUrl = new URL("../../../scripts/lib/release-worktree-integrity.sh", import.meta.url);
const guideUrl = new URL("../../../docs/operations/AUTONOMOUS_PRODUCTION_DEPLOY.md", import.meta.url);
const dockerfileUrl = new URL("../../../infra/Dockerfile", import.meta.url);

test("the production command delegates every current-to-candidate decision to one shared policy", async () => {
  const source = await readFile(deployScriptUrl, "utf8");
  const policy = await readFile(transitionPolicyUrl, "utf8");

  assert.match(source, /source .*production-transition-policy\.sh/);
  assert.match(source, /validate_production_transition "\$repository_dir" "\$current_sha" "\$release_sha" origin\/main/);
  assert.match(policy, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(policy, /merge-base --is-ancestor "\$candidate_sha" "\$main_ref"/);
  assert.match(policy, /merge-base --is-ancestor "\$current_sha" "\$candidate_sha"/);
  assert.match(policy, /validate_compose_env_transition/);
  assert.match(policy, /infra\/Dockerfile/);
  assert.match(policy, /Existing migrations are immutable/);
  assert.match(policy, /drop\[\[:space:\]\]\+\(table\|schema\|column\|index\)/);
  assert.match(source, /worktree add --detach "\$release_dir" "\$release_sha"/);
  assert.match(source, /flock -n 9/);
});

test("the command protects state before applying pending migrations", async () => {
  const source = await readFile(deployScriptUrl, "utf8");
  const backupIndex = source.indexOf("backup-production.sh");
  const restoreIndex = source.indexOf("verify-backup-production.sh");
  const rehearsalIndex = source.indexOf("Rehearsing all pending migrations");
  const productionMigrationIndex = source.indexOf("Applying rehearsed migrations to production");

  assert.ok(backupIndex > -1);
  assert.ok(restoreIndex > backupIndex);
  assert.ok(rehearsalIndex > restoreIndex);
  assert.ok(productionMigrationIndex > rehearsalIndex);
  assert.match(source, /al_lio_rehearsal_/);
  assert.match(source, /schema_migrations/);
  assert.match(source, /migration_file_count="\$\(find "\$release_dir\/infra\/postgres\/migrations"/);
  assert.match(source, /expected_migration_count="\$\(\(migration_file_count \+ 1\)\)"/);
});

test("the command replaces only web and preserves automatic recovery", async () => {
  const source = await readFile(deployScriptUrl, "utf8");
  const integrity = await readFile(worktreeIntegrityUrl, "utf8");

  assert.match(source, /up -d --no-deps al_lio_web/);
  assert.match(source, /rollback_web/);
  assert.match(source, /previous_release_dir/);
  assert.match(source, /Current release integrity check failed/);
  assert.match(integrity, /Release worktree HEAD does not match the candidate SHA/);
  assert.match(source, /read_env_value AL_LIO_RELEASE_SHA "\$previous_release_dir\/\.env"/);
  assert.match(source, /postgres_container_preserved="true"/);
  assert.match(source, /radar_container_preserved="true"/);
  assert.doesNotMatch(source, /docker compose[^\n]*down/);
  assert.doesNotMatch(source, /docker volume rm/);
  assert.doesNotMatch(source, /git reset --hard/);
});

test("the Radar backup remains private and readable by the deploy user", async () => {
  const source = await readFile(deployScriptUrl, "utf8");

  assert.match(source, /-e BACKUP_UID="\$\(id -u\)"/);
  assert.match(source, /-e BACKUP_GID="\$\(id -g\)"/);
  assert.match(source, /chown "\$BACKUP_UID:\$BACKUP_GID"/);
  assert.match(source, /chmod 600 "\/backup\/\$BACKUP_FILE"/);
});

test("Compose removals require exact current-release data and cannot persist in the candidate", async () => {
  const policy = await readFile(transitionPolicyUrl, "utf8");
  const guard = await readFile(composeGuardUrl, "utf8");
  const approvals = await readFile(approvalsUrl, "utf8");

  assert.match(policy, /git -C "\$repository" show "\$current_sha:\$PRODUCTION_TRANSITION_APPROVALS_REPO_PATH"/);
  assert.match(policy, /git -C "\$repository" show "\$candidate_sha:\$PRODUCTION_TRANSITION_APPROVALS_REPO_PATH"/);
  assert.match(policy, /git -C "\$repository" ls-tree "\$sha" -- "\$path"/);
  assert.match(policy, /100644 blob/);
  assert.match(guard, /service\|destination_key\|source_variable\|exact_default/);
  assert.match(guard, /validate_removal_approval_data/);
  assert.match(guard, /classify_approval_transition/);
  assert.match(guard, /Current release has staged removal approvals, so candidate must contain no active approval/);
  assert.match(guard, /git -C "\$repository" diff --summary/);
  assert.match(guard, /Compose file metadata or mode changed/);
  assert.match(guard, /removal_is_approved "\$current_approval_data"/);
  assert.match(guard, /"Candidate release"/);
  assert.doesNotMatch(approvals, /^al_lio_(web|radar)\|/m, "normal releases must contain no reusable approval");
  for (const legacyVariable of [
    "INFOJOBS_CLIENT_ID",
    "INFOJOBS_CLIENT_SECRET",
    "ADZUNA_APP_ID",
    "ADZUNA_APP_KEY",
    "JOOBLE_API_KEY",
    "AL_LIO_DEMO_ACCESS_ENABLED",
  ]) {
    assert.doesNotMatch(approvals, new RegExp(`^.*\\|${legacyVariable}\\|`, "m"));
  }
});

test("release worktrees receive a private exact identity without changing the canonical checkout", async () => {
  const source = await readFile(deployScriptUrl, "utf8");
  const prepare = await readFile(releaseEnvUrl, "utf8");
  const integrity = await readFile(worktreeIntegrityUrl, "utf8");
  const dockerfile = await readFile(dockerfileUrl, "utf8");

  assert.match(source, /umask 022\s+git -C "\$repository_dir" worktree add/);
  assert.match(source, /prepare-release-env\.sh/);
  assert.match(prepare, /install -m 600 "\$previous_env" "\$release_env"/);
  assert.match(prepare, /write_env_value AL_LIO_IMAGE_TAG "\$release_sha"/);
  assert.match(prepare, /write_env_value AL_LIO_RELEASE_SHA "\$release_sha"/);
  assert.match(prepare, /validate_managed_env_value AL_LIO_IMAGE_TAG "\$release_sha"/);
  assert.match(prepare, /validate_managed_env_value AL_LIO_RELEASE_SHA "\$release_sha"/);
  assert.match(integrity, /rev-parse HEAD/);
  assert.match(source, /source .*release-worktree-integrity\.sh/);
  assert.match(prepare, /source .*release-worktree-integrity\.sh/);
  assert.match(integrity, /status --porcelain --untracked-files=all/);
  assert.match(integrity, /status --porcelain --ignored --untracked-files=all/);
  assert.match(integrity, /"!! \.env"/);
  assert.doesNotMatch(`${source}\n${prepare}\n${integrity}`, /--untracked-files=no/);
  assert.match(dockerfile, /COPY --from=builder --chown=nextjs:nodejs \/app\/public \.\/public/);
});

test("deployment success requires internal and public release identity", async () => {
  const source = await readFile(deployScriptUrl, "utf8");

  assert.match(source, /docker exec "\$WEB_CONTAINER" wget -qO- http:\/\/127\.0\.0\.1:3000\/api\/version/);
  assert.match(source, /curl -fsS "\$base_url\/api\/version"/);
  assert.match(source, /public_version_result="\$release_sha"/);
});

test("the release identity is rechecked immediately before cutover", async () => {
  const source = await readFile(deployScriptUrl, "utf8");
  const cutover = source.indexOf('"${compose[@]}" up -d --no-deps al_lio_web');

  assert.ok(cutover > -1);
  for (const check of [
    'read_env_value AL_LIO_IMAGE_TAG "$release_dir/.env"',
    'read_env_value AL_LIO_RELEASE_SHA "$release_dir/.env"',
    'validate_release_worktree_integrity "$release_dir" "$release_sha"',
  ]) {
    const index = source.lastIndexOf(check, cutover);
    assert.ok(index > -1 && index < cutover, `${check} must run before cutover`);
  }
});

test("candidate worktree integrity is checked before both build and cutover", async () => {
  const source = await readFile(deployScriptUrl, "utf8");
  const build = source.indexOf('"${compose[@]}" build --pull al_lio_web');
  const cutover = source.indexOf('"${compose[@]}" up -d --no-deps al_lio_web');
  const beforeBuild = source.lastIndexOf(
    'validate_release_worktree_integrity "$release_dir" "$release_sha"',
    build,
  );
  const beforeCutover = source.lastIndexOf(
    'validate_release_worktree_integrity "$release_dir" "$release_sha"',
    cutover,
  );

  assert.ok(beforeBuild > -1 && beforeBuild < build);
  assert.ok(beforeCutover > build && beforeCutover < cutover);
});

test("success and failure records retain the complete audited release outcome", async () => {
  const source = await readFile(deployScriptUrl, "utf8");

  assert.match(source, /write_release_record "approved"/);
  assert.match(source, /write_release_record "failed"/);
  assert.match(source, /chmod 600 "\$temp_record"/);
  for (const field of [
    "timestamp_utc", "operator", "current_sha", "candidate_sha",
    "previous_release_path", "previous_image", "candidate_image", "policy_result",
    "historical_exception", "staged_approvals", "consumed_approvals", "revoked_approvals",
    "pending_migration_ids", "applied_migration_ids", "db_backup_path",
    "db_backup_checksum", "restore_verification", "rehearsal", "radar_backup",
    "radar_backup_status", "internal_health", "internal_ready", "internal_version",
    "public_health", "public_ready", "public_version", "automated_smoke",
    "functional_smoke", "rollback_release_path", "rollback_image", "rollback_result",
  ]) {
    assert.match(source, new RegExp(`printf '${field}=`), `missing release record field: ${field}`);
  }
});

test("the owner guide documents the complete low-touch workflow", async () => {
  const guide = await readFile(guideUrl, "utf8");

  assert.match(guide, /git rev-parse HEAD/);
  assert.match(guide, /Merge pull request/);
  assert.match(guide, /merge commit/);
  assert.match(guide, /ssh al-lio-vps/);
  assert.match(guide, /\.\/scripts\/deploy-production\.sh <SHA>/);
  assert.match(guide, /DEPLOY 9517e115314/);
  assert.match(guide, /health/i);
  assert.match(guide, /rollback/i);
});
