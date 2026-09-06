/**
 * al-lio - static VPS production deploy readiness validator.
 *
 * It does not connect to production. It checks repository files, operational
 * runbooks, and staged files so deploy preparation cannot drift silently.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const root = process.cwd();
let errors = 0;

function ok(message) {
  console.log(`  OK  ${message}`);
}

function fail(message) {
  console.error(`  FAIL  ${message}`);
  errors++;
}

function check(label, condition) {
  condition ? ok(label) : fail(label);
}

function read(path) {
  const fullPath = join(root, path);
  // Normalize CRLF -> LF so multi-line .includes() checks below don't depend
  // on the checkout's line endings (e.g. Windows with core.autocrlf=true).
  return existsSync(fullPath) ? readFileSync(fullPath, "utf-8").replace(/\r\n/g, "\n") : "";
}

console.log("\n-- scripts/deploy-production.sh --");
const deployScript = read("scripts/deploy-production.sh");
const composeEnvGuard = read("scripts/lib/compose-env-guard.sh");
const transitionPolicy = read("scripts/lib/production-transition-policy.sh");
const composeRemovalApprovals = read("scripts/config/production-compose-env-removals.allowlist");
const releaseEnvPreparer = read("scripts/prepare-release-env.sh");
const releaseWorktreeIntegrity = read("scripts/lib/release-worktree-integrity.sh");
check("guarded production deploy script exists", existsSync(join(root, "scripts/deploy-production.sh")));
check("deploy script requires an exact full SHA", deployScript.includes("^[0-9a-f]{40}$"));
check("shared production transition policy exists", existsSync(join(root, "scripts/lib/production-transition-policy.sh")));
check(
  "deploy script uses the shared current-to-candidate policy",
  deployScript.includes("lib/production-transition-policy.sh")
    && deployScript.includes('validate_production_transition "$repository_dir" "$current_sha" "$release_sha" origin/main'),
);
check("shared policy accepts only commits reachable from main", transitionPolicy.includes('merge-base --is-ancestor "$candidate_sha" "$main_ref"'));
check("shared policy rejects downgrades and divergence", transitionPolicy.includes('merge-base --is-ancestor "$current_sha" "$candidate_sha"'));
check("shared policy protects blocked infrastructure", transitionPolicy.includes("infra/Dockerfile") && transitionPolicy.includes("data/learning-competencies.json"));
check("shared policy protects migration history", transitionPolicy.includes("Existing migrations are immutable") && transitionPolicy.includes("contains a destructive or structural statement"));
check(
  "shared policy protects the production control-plane",
  [
    ".dockerignore",
    ".github/workflows/ci.yml",
    ".github/workflows/deploy-production.yml",
    "scripts/deploy-production.sh",
    "scripts/github-actions-deploy-entrypoint.sh",
    "scripts/lib/production-transition-policy.sh",
    "scripts/lib/compose-env-guard.sh",
    "scripts/lib/release-worktree-integrity.sh",
    "scripts/prepare-release-env.sh",
    "scripts/validate-production-transition.sh",
    "scripts/validate-production-deploy-readiness.mjs",
    "scripts/postgres",
    "infra/postgres/schema.sql",
    "infra/postgres/baseline.sha256",
  ].every((entry) => transitionPolicy.includes(`"${entry}"`))
    && transitionPolicy.includes("protected production control-plane"),
);
check(
  "new migrations must be regular 100644 blobs read by object id",
  transitionPolicy.includes("validate_regular_git_blob")
    && transitionPolicy.includes('git -C "$repository" cat-file blob "$migration_object"')
    && transitionPolicy.includes("^infra/postgres/migrations/[0-9]{4}_[a-z0-9_]+\\.sql$"),
);
check("deploy script serializes releases", deployScript.includes("flock -n"));
check("deploy script creates and verifies PostgreSQL backups", deployScript.includes("backup-production.sh") && deployScript.includes("verify-backup-production.sh"));
check("deploy script rehearses migrations in an isolated database", deployScript.includes("al_lio_rehearsal_"));
check("deploy script replaces only the web service", deployScript.includes("up -d --no-deps al_lio_web"));
check("deploy script has an automatic web rollback", deployScript.includes("rollback_web"));
check(
  "deploy script verifies active worktree and release identity",
  deployScript.includes('validate_release_worktree_integrity "$previous_release_dir" "$current_sha"')
    && deployScript.includes("Current release integrity check failed")
    && deployScript.includes('read_env_value AL_LIO_RELEASE_SHA "$previous_release_dir/.env"'),
);
check("deploy script never removes Compose volumes", !deployScript.includes("down -v") && !deployScript.includes("docker volume rm"));
check("Compose environment guard exists", existsSync(join(root, "scripts/lib/compose-env-guard.sh")));
check(
  "shared policy admits only classified service environment transitions",
  transitionPolicy.includes("validate_compose_env_transition")
    && composeEnvGuard.includes("validate_new_environment_mapping")
    && composeEnvGuard.includes("validate_unique_environment_keys")
    && composeEnvGuard.includes("removal_is_approved")
    && composeEnvGuard.includes("AL_LIO_RADAR_${key}")
    && composeEnvGuard.includes("DISCOVERY_*")
    && composeEnvGuard.includes("OPENAI_API_KEY"),
);
check(
  "Compose removals require exact current-release data",
  transitionPolicy.includes('git -C "$repository" show "$current_sha:$PRODUCTION_TRANSITION_APPROVALS_REPO_PATH"')
    && transitionPolicy.includes('git -C "$repository" show "$candidate_sha:$PRODUCTION_TRANSITION_APPROVALS_REPO_PATH"')
    && composeEnvGuard.includes("service|destination_key|source_variable|exact_default")
    && composeEnvGuard.includes('removal_is_approved "$current_approval_data"'),
);
check(
  "Compose removal approvals expire on the next release",
  composeEnvGuard.includes("classify_approval_transition")
    && composeEnvGuard.includes("Current release has staged removal approvals, so candidate must contain no active approval")
    && composeEnvGuard.includes("staged_compose_env_removal_approvals")
    && composeEnvGuard.includes("consumed_compose_env_removal_approvals")
    && composeEnvGuard.includes("revoked_compose_env_removal_approvals"),
);
check(
  "approval files are regular non-executable blobs from the Git tree",
  transitionPolicy.includes('git -C "$repository" ls-tree "$sha" -- "$path"')
    && transitionPolicy.includes('"$mode" == "100644"')
    && transitionPolicy.includes('"$type" == "blob"'),
);
check(
  "Compose metadata and mode changes fail closed",
  composeEnvGuard.includes('git -C "$repository" diff --summary')
    && composeEnvGuard.includes("Compose file metadata or mode changed"),
);
check(
  "normal release contains no reusable legacy removal approval",
  !/^al_lio_(web|radar)\|/m.test(composeRemovalApprovals)
    && !/(INFOJOBS|ADZUNA|JOOBLE|AL_LIO_DEMO_ACCESS_ENABLED)/.test(composeRemovalApprovals),
);
check("shared policy rejects every other Compose edit", transitionPolicy.includes("Docker Compose changed outside the approved service environment transition policy"));
check(
  "release environment is copied privately and receives the exact SHA",
  releaseEnvPreparer.includes('install -m 600 "$previous_env" "$release_env"')
    && releaseEnvPreparer.includes('write_env_value AL_LIO_IMAGE_TAG "$release_sha"')
    && releaseEnvPreparer.includes('write_env_value AL_LIO_RELEASE_SHA "$release_sha"')
    && releaseEnvPreparer.includes('validate_managed_env_value AL_LIO_IMAGE_TAG "$release_sha"')
    && releaseEnvPreparer.includes('validate_managed_env_value AL_LIO_RELEASE_SHA "$release_sha"'),
);
check(
  "release worktrees reject tracked, untracked and unexpected ignored files",
  existsSync(join(root, "scripts/lib/release-worktree-integrity.sh"))
    && releaseWorktreeIntegrity.includes("status --porcelain --untracked-files=all")
    && releaseWorktreeIntegrity.includes("status --porcelain --ignored --untracked-files=all")
    && releaseWorktreeIntegrity.includes('"!! .env"')
    && !deployScript.includes("--untracked-files=no")
    && !releaseEnvPreparer.includes("--untracked-files=no"),
);
check(
  "candidate integrity is checked before build and cutover",
  deployScript.split('validate_release_worktree_integrity "$release_dir" "$release_sha"').length >= 4
    && deployScript.includes("Candidate integrity check failed before build")
    && deployScript.includes("Candidate integrity check failed before cutover"),
);
check("deploy verifies internal and public release identity", deployScript.includes("/api/version") && deployScript.includes('public_version_result="$release_sha"'));
check(
  "deploy rechecks candidate identity immediately before cutover",
  deployScript.includes("Candidate AL_LIO_IMAGE_TAG changed before cutover")
    && deployScript.includes("Candidate AL_LIO_RELEASE_SHA changed before cutover")
    && deployScript.includes('validate_release_worktree_integrity "$release_dir" "$release_sha"')
    && deployScript.includes("Candidate integrity check failed before cutover"),
);
check(
  "deploy writes private success and failure release records",
  deployScript.includes('write_release_record "approved"')
    && deployScript.includes('write_release_record "failed"')
    && deployScript.includes('chmod 600 "$temp_record"')
    && deployScript.includes("staged_approvals=")
    && deployScript.includes("consumed_approvals=")
    && deployScript.includes("revoked_approvals=")
    && deployScript.includes("rollback_result="),
);

console.log("\n-- .github/workflows/deploy-production.yml --");
const deployWorkflow = read(".github/workflows/deploy-production.yml");
const deployEntrypoint = read("scripts/github-actions-deploy-entrypoint.sh");
check("production workflow exists", existsSync(join(root, ".github/workflows/deploy-production.yml")));
check("production workflow waits for completed CI", deployWorkflow.includes("workflow_run:") && deployWorkflow.includes("workflows: [CI]") && deployWorkflow.includes("types: [completed]"));
check("automatic deploys require successful main pushes", deployWorkflow.includes("workflow_run.conclusion == 'success'") && deployWorkflow.includes("workflow_run.event == 'push'") && deployWorkflow.includes("workflow_run.head_branch == 'main'"));
check("production workflow deploys the triggering SHA", deployWorkflow.includes("github.event.workflow_run.head_sha"));
check("production workflow has an explicit activation switch", deployWorkflow.includes("PRODUCTION_AUTO_DEPLOY_ENABLED == 'true'"));
check("production workflow serializes without cancelling a release", deployWorkflow.includes("group: al-lio-production") && deployWorkflow.includes("cancel-in-progress: false"));
check("production workflow uses the protected environment", deployWorkflow.includes("name: Production"));
check("production workflow links to al-lio.app", deployWorkflow.includes("url: https://al-lio.app"));
check("production SSH verifies a pinned host key", deployWorkflow.includes("StrictHostKeyChecking=yes") && deployWorkflow.includes("PRODUCTION_SSH_KNOWN_HOSTS") && !deployWorkflow.includes("ssh-keyscan"));
check("production SSH key invokes only the deploy operation", deployWorkflow.includes('"deploy $RELEASE_SHA"'));
check("forced deploy entrypoint validates SSH_ORIGINAL_COMMAND", deployEntrypoint.includes("SSH_ORIGINAL_COMMAND") && deployEntrypoint.includes("^deploy[[:space:]]([0-9a-f]{40})$"));
check("forced deploy entrypoint calls the guarded release script", deployEntrypoint.includes('AL_LIO_DEPLOY_CONFIRMATION="$release_sha"') && deployEntrypoint.includes('./scripts/deploy-production.sh "$release_sha"'));

console.log("\n-- infra/docker-compose.prod.yml --");
const compose = read("infra/docker-compose.prod.yml");
check("docker-compose.prod.yml exists", existsSync(join(root, "infra/docker-compose.prod.yml")));
check("uses al_lio_web container", compose.includes("al_lio_web"));
check("uses al_lio_postgres container", compose.includes("al_lio_postgres"));
check("uses al_lio_radar container", compose.includes("al_lio_radar"));
check("uses al_lio_postgres_data volume", compose.includes("al_lio_postgres_data"));
check("does not mount legacy JSON news storage", !compose.includes("al_lio_news_data:/app/data"));
check("uses persistent al_lio_radar_data volume", compose.includes("al_lio_radar_data:/app/data"));
check("radar waits for healthy web receiver", compose.includes("al_lio_web:\n        condition: service_healthy"));
check("uses al_lio_internal network", compose.includes("al_lio_internal"));
check("uses stable internal network name", compose.includes("name: al_lio_backend_internal"));
check("marks the PostgreSQL network internal", compose.includes("internal: true"));
check("uses external danicode_web network", compose.includes("danicode_web"));
check("does not use aidraft_web", !compose.includes("aidraft_web"));
check("does not use aidraft_postgres as service", !compose.includes("aidraft_postgres:"));
check("does not use aidraft_internal", !compose.includes("aidraft_internal"));

console.log("\n-- infra/Caddyfile.example --");
const caddy = read("infra/Caddyfile.example");
check("Caddyfile.example exists", existsSync(join(root, "infra/Caddyfile.example")));
check("contains primary al-lio.app host", caddy.includes("al-lio.app {"));
check("keeps the previous host for Radar compatibility", caddy.includes("al-lio.danielcode.dev {") && caddy.includes("path /api/radar/*"));
check("redirects previous-host browser traffic to al-lio.app", caddy.includes("redir https://al-lio.app{uri} 308"));
check("reverse_proxy points to al_lio_web:3000", caddy.includes("al_lio_web:3000"));
check("does not contain aidraft.danielcode.dev", !caddy.includes("aidraft.danielcode.dev"));
check("does not contain aidraft_web", !caddy.includes("aidraft_web"));

console.log("\n-- .env.production.example --");
const envExample = read(".env.production.example");
check(".env.production.example exists", existsSync(join(root, ".env.production.example")));
check("BASE_URL is al-lio.app", envExample.includes("BASE_URL=https://al-lio.app"));
check(
  "Google redirect URIs use al-lio.app",
  envExample.includes("GOOGLE_IDENTITY_REDIRECT_URI=https://al-lio.app/api/auth/google/callback")
    && envExample.includes("GOOGLE_REDIRECT_URI=https://al-lio.app/api/google/calendar/callback"),
);
check("DATABASE_URL points to al_lio_postgres", envExample.includes("@al_lio_postgres:5432/al_lio"));
check("DATABASE_URL uses restricted al_lio_app role", envExample.includes("DATABASE_URL=postgresql://al_lio_app:"));
check("DATABASE_MIGRATION_URL uses admin role", envExample.includes("DATABASE_MIGRATION_URL=postgresql://al_lio:"));
check("documents shared radar webhook secret", envExample.includes("AL_LIO_RADAR_WEBHOOK_SECRET=REPLACE_ME"));
check("documents immutable radar image tag", envExample.includes("AL_LIO_RADAR_IMAGE_TAG="));
check("release identity is not a developer-managed environment placeholder", !envExample.includes("AL_LIO_RELEASE_SHA="));
check("documents dormant Radar publication defaults", [
  "AL_LIO_RADAR_DELIVERY_SCHEMA_VERSION=3",
  "AL_LIO_RADAR_AUTONOMOUS_PUBLICATION_ENABLED=false",
  "AL_LIO_RADAR_AUTONOMOUS_PUBLICATION_DESTINATIONS=news",
  "AL_LIO_RADAR_AUTONOMOUS_NEWS_SOURCE_CYCLE_MATRIX_JSON={}",
].every((entry) => envExample.includes(entry)));
check("documents dormant learning delivery and an empty YouTube credential", [
  "AL_LIO_RADAR_LEARNING_DELIVERY_ENABLED=false",
  "AL_LIO_RADAR_YOUTUBE_API_KEY=",
].every((entry) => envExample.includes(entry)));
check("does not contain aidraft BASE_URL", !envExample.includes("BASE_URL=https://aidraft"));
check("does not contain real Supabase anon key", !(/NEXT_PUBLIC_SUPABASE_ANON_KEY=ey[A-Za-z0-9]/.test(envExample)));
check("does not contain real Supabase service role key", !(/SUPABASE_SERVICE_ROLE_KEY=ey[A-Za-z0-9]/.test(envExample)));
check("does not contain real Google client secret", !(/GOOGLE_CLIENT_SECRET=[A-Za-z0-9_-]{20,}/.test(envExample)));

console.log("\n-- No functional aidraft_* names in production files --");
const productionFiles = [
  "infra/docker-compose.prod.yml",
  "infra/Caddyfile.example",
  ".env.production.example",
];

for (const file of productionFiles) {
  const content = read(file);
  const hasAidraftService = /^\s*(aidraft_web|aidraft_postgres|aidraft_internal):/m.test(content);
  check(`${file}: no aidraft_* service/network names`, !hasAidraftService);
}

console.log("\n-- docs/operations/DEPLOY_VPS.md --");
const runbook = read("docs/operations/DEPLOY_VPS.md");
check("active VPS runbook exists", existsSync(join(root, "docs/operations/DEPLOY_VPS.md")));
check("runbook uses production compose file", runbook.includes("infra/docker-compose.prod.yml"));
check("runbook loads real .env with --env-file", runbook.includes("--env-file .env"));
check(
  "runbook uses compose order validated on VPS",
  runbook.includes("docker compose -f infra/docker-compose.prod.yml --env-file .env"),
);
check(
  "runbook does not require Node.js/npm on host",
  !runbook.includes("npm ci") && !runbook.includes("npm run postgres:"),
);
check("runbook does not use local curl healthcheck", !runbook.includes("curl http://localhost:3000"));
check("runbook uses internal al_lio_web healthcheck", runbook.includes("docker exec al_lio_web wget"));
check("runbook validates database readiness", runbook.includes("/api/ready"));
check(
  "runbook validates public JSON health response",
  runbook.includes("curl -fsS https://al-lio.app/api/health"),
);
check(
  "runbook documents immutable image rollback",
  runbook.includes("AL_LIO_IMAGE_TAG") && runbook.includes("Application rollback"),
);
check(
  "runbook preserves immutable release topology for exceptional deploys",
  runbook.includes("/srv/danicode/releases/al-lio-")
    && runbook.includes("worktree add --detach")
    && runbook.includes("prepare-release-env.sh")
    && !runbook.includes("git checkout --detach"),
);
check("runbook verifies the exact public release identity", runbook.includes("/api/version") && runbook.includes("AL_LIO_RELEASE_SHA"));
check(
  "runbook gives executable backup, restore-test and rehearsal commands",
  runbook.includes("backup-production.sh")
    && runbook.includes("verify-backup-production.sh")
    && runbook.includes("al_lio_rehearsal_")
    && runbook.includes("pg_restore")
    && runbook.includes("schema_migrations"),
);
check(
  "runbook preserves Radar around migrations",
  runbook.includes("docker stop --time 30 al_lio_radar")
    && runbook.includes("al_lio_radar_data:/source:ro")
    && runbook.includes("docker start al_lio_radar"),
);
check(
  "runbook gives executable cutover, smoke, record and rollback commands",
  runbook.includes("up -d --no-deps al_lio_web")
    && runbook.includes("/api/job-radar")
    && runbook.includes("release-$AL_LIO_RELEASE_STARTED_AT")
    && runbook.includes("rollback_image"),
);
check(
  "runbook includes the owner functional smoke and web-only persistence check",
  [
    "login", "Google OAuth", "Calendar connect/disconnect", "dashboard",
    "Create/complete/delete task", "Create note + reload", "profile/cycle persistence",
    "Radar visibility", "idempotent delivery", "Work", "Courses", "Events/Challenges",
    "docker restart al_lio_web",
  ].every((entry) => runbook.includes(entry)),
);

console.log("\n-- src/app/api/version/route.ts --");
const versionRoute = read("src/app/api/version/route.ts");
check("version endpoint exists", existsSync(join(root, "src/app/api/version/route.ts")));
check("version endpoint validates a full lowercase SHA", versionRoute.includes("^[0-9a-f]{40}$"));
check("version endpoint fails explicitly when identity is unavailable", versionRoute.includes("releaseSha: null") && versionRoute.includes("status: 503"));
check("version endpoint disables caching", versionRoute.includes('"Cache-Control": "no-store"'));

console.log("\n-- docs/operations/PRIMARY_DOMAIN_MIGRATION.md --");
const domainMigration = read("docs/operations/PRIMARY_DOMAIN_MIGRATION.md");
check("primary-domain migration runbook exists", existsSync(join(root, "docs/operations/PRIMARY_DOMAIN_MIGRATION.md")));
check("domain migration requires both new Google callbacks", [
  "https://al-lio.app/api/auth/google/callback",
  "https://al-lio.app/api/google/calendar/callback",
].every((entry) => domainMigration.includes(entry)));
check("domain migration uses a separate web candidate", domainMigration.includes("al_lio_web_domain_candidate"));
check("domain migration recreates only web without dependencies", domainMigration.includes("up -d --no-deps --force-recreate al_lio_web"));
check("domain migration preserves the Radar compatibility route", domainMigration.includes("/api/radar/*"));
check("domain migration documents graceful Caddy reload", domainMigration.includes("caddy reload"));
check("domain migration prohibits PostgreSQL and Radar replacement", [
  "Do not stop, restart, recreate, or reconfigure PostgreSQL.",
  "Do not stop, restart, recreate, or reconfigure Radar.",
].every((entry) => domainMigration.includes(entry)));

console.log("\n-- Public primary-domain metadata --");
const rootLayout = read("src/app/layout.tsx");
const packageJson = read("package.json");
const rootReadme = read("README.md");
check("Next.js metadata uses al-lio.app", rootLayout.includes('metadataBase: new URL("https://al-lio.app")'));
check("package homepage uses al-lio.app", packageJson.includes('"homepage": "https://al-lio.app"'));
check("README links to al-lio.app", rootReadme.includes("[Live application](https://al-lio.app)"));

console.log("\n-- Git staged safety --");
let staged = "";
try {
  staged = execSync("git diff --cached --name-only", { cwd: root, encoding: "utf-8" });
} catch {
  // ok if not in git
}
const stagedFiles = staged.split("\n").filter(Boolean);
check("No .env staged", !stagedFiles.includes(".env"));
check("No migration-artifacts/ staged", !stagedFiles.some((file) => file.startsWith("migration-artifacts/")));
check("No dumps staged", !stagedFiles.some((file) => file.endsWith(".dump") || file.endsWith(".backup")));
check("No _archive/ staged", !stagedFiles.some((file) => file.startsWith("_archive/")));

console.log("");
if (errors > 0) {
  console.error(`RESULT: ${errors} issue(s) found. Review before deploying.`);
  process.exit(1);
}

console.log("RESULT: VPS production deploy readiness OK.");
