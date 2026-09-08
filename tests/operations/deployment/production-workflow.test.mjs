// Source-level assertion rationale: GitHub Actions cannot be executed safely inside the unit runner,
// so trigger, serialization, and immutable-release guarantees remain structural contracts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflowUrl = new URL("../../../.github/workflows/deploy-production.yml", import.meta.url);
const ciWorkflowUrl = new URL("../../../.github/workflows/ci.yml", import.meta.url);
const entrypointUrl = new URL("../../../scripts/github-actions-deploy-entrypoint.sh", import.meta.url);
const bashPath = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";

function toBashPath(path) {
  return path.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll("\\", "/");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function extractShellFunction(source, name) {
  const start = source.indexOf(`${name}() {`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `unterminated ${name}`);
  return source.slice(start, end + 2);
}

test("production deployment waits for successful post-merge CI", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows: \[CI\]/);
  assert.match(workflow, /types: \[completed\]/);
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /workflow_run\.event == 'push'/);
  assert.match(workflow, /workflow_run\.head_branch == 'main'/);
  assert.match(workflow, /workflow_run\.head_repository\.full_name == github\.repository/);
});

test("production deployment uses an immutable guarded SHA", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /workflow_run\.head_sha/);
  assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(workflow, /"deploy \$RELEASE_SHA"/);
  assert.doesNotMatch(workflow, /:\s*latest\b/);
  assert.doesNotMatch(workflow, /git pull/);
});

test("production deployment is serialized and keeps SSH host verification", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /group: al-lio-production/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /environment:\s+name: Production/);
  assert.match(workflow, /vars\.PRODUCTION_AUTO_DEPLOY_ENABLED == 'true'/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /PRODUCTION_SSH_KNOWN_HOSTS/);
  assert.doesNotMatch(workflow, /StrictHostKeyChecking=no/);
  assert.doesNotMatch(workflow, /ssh-keyscan/);
});

test("production deployment keeps a deliberate manual fallback", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /release_sha:/);
  assert.match(workflow, /required: true/);
  assert.match(workflow, /inputs\.release_sha/);
});

test("the forced SSH command exposes only the guarded deployment operation", async () => {
  const entrypoint = await readFile(entrypointUrl, "utf8");

  assert.match(entrypoint, /SSH_ORIGINAL_COMMAND/);
  assert.match(entrypoint, /\^deploy\[\[:space:\]\]\(\[0-9a-f\]\{40\}\)\$/);
  assert.match(entrypoint, /AL_LIO_DEPLOY_CONFIRMATION="\$release_sha"/);
  assert.match(entrypoint, /\.\/scripts\/deploy-production\.sh "\$release_sha"/);
  assert.match(entrypoint, /"\$releases_dir"\/al-lio-\*/);
  assert.doesNotMatch(entrypoint, /\beval\b/);
});

test("the forced SSH command bootstraps the deploy controller from immutable main-reachable Git blobs", async () => {
  const entrypoint = await readFile(entrypointUrl, "utf8");
  const expectedControllerFiles = [
    "scripts/deploy-production.sh:100755",
    "scripts/lib/production-transition-policy.sh:100644",
    "scripts/lib/compose-env-guard.sh:100644",
    "scripts/lib/release-worktree-integrity.sh:100644",
    "scripts/prepare-release-env.sh:100644",
  ];

  for (const entry of expectedControllerFiles) assert.ok(entrypoint.includes(`"${entry}"`), entry);
  assert.match(entrypoint, /git -C "\$repository_dir" fetch --tags origin main/);
  assert.match(entrypoint, /cat-file -e "\$\{release_sha\}\^\{commit\}"/);
  assert.match(entrypoint, /merge-base --is-ancestor "\$release_sha" origin\/main/);
  assert.match(entrypoint, /ls-tree "\$release_sha" -- "\$path"/);
  assert.match(entrypoint, /cat-file blob "\$object" > "\$target_path"/);
  assert.match(entrypoint, /git hash-object "\$target_path"/);
  assert.match(entrypoint, /mktemp -d .*al-lio-deploy-controller/);
  assert.doesNotMatch(entrypoint, /cd "\$release_dir"/);

  const materializeIndex = entrypoint.indexOf('materialize_controller_file "$controller_path" "$controller_mode"');
  const executeIndex = entrypoint.indexOf('./scripts/deploy-production.sh "$release_sha"');
  assert.ok(materializeIndex >= 0 && executeIndex > materializeIndex);
});

test("a mutable checkout cannot replace the controller blob selected by the forced SSH bootstrap", async () => {
  const entrypoint = await readFile(entrypointUrl, "utf8");
  const materializeFunction = extractShellFunction(entrypoint, "materialize_controller_file");
  const root = await mkdtemp(join(tmpdir(), "al-lio-controller-bootstrap-"));
  const repository = join(root, "repository");
  const controller = join(root, "controller");
  const trustedSentinel = join(root, "trusted.txt");
  const hostileSentinel = join(root, "hostile.txt");
  const deployPath = join(repository, "scripts", "deploy-production.sh");

  try {
    run("git", ["init", "-q", repository]);
    run("git", ["-C", repository, "config", "user.email", "bootstrap-test@example.invalid"]);
    run("git", ["-C", repository, "config", "user.name", "AL-LIO bootstrap test"]);
    await mkdir(join(repository, "scripts"), { recursive: true });
    await writeFile(
      deployPath,
      '#!/usr/bin/env bash\nprintf trusted > "$TRUSTED_SENTINEL"\n',
      "utf8",
    );
    await chmod(deployPath, 0o755).catch(() => {});
    run("git", ["-C", repository, "add", "scripts/deploy-production.sh"]);
    run("git", ["-C", repository, "update-index", "--chmod=+x", "scripts/deploy-production.sh"]);
    run("git", ["-C", repository, "commit", "-q", "-m", "trusted controller"]);
    const releaseSha = run("git", ["-C", repository, "rev-parse", "HEAD"]);

    // Mutate the checkout after the commit. The bootstrap must still select the
    // exact tree blob, never these mutable working-tree bytes.
    await writeFile(
      deployPath,
      '#!/usr/bin/env bash\nprintf hostile > "$HOSTILE_SENTINEL"\n',
      "utf8",
    );

    const harness = `set -Eeuo pipefail\n${materializeFunction}\nfail() { printf 'ERROR: %s\\n' "$*" >&2; exit 1; }\nrepository_dir="${toBashPath(repository)}"\nrelease_sha="${releaseSha}"\ncontroller_dir="${toBashPath(controller)}"\nmkdir -p "$controller_dir"\nmaterialize_controller_file scripts/deploy-production.sh 100755\nTRUSTED_SENTINEL="${toBashPath(trustedSentinel)}" HOSTILE_SENTINEL="${toBashPath(hostileSentinel)}" "$controller_dir/scripts/deploy-production.sh"\n`;
    const result = spawnSync(bashPath, ["-s"], { encoding: "utf8", input: harness });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(await readFile(trustedSentinel, "utf8"), "trusted");
    await assert.rejects(readFile(hostileSentinel, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CI pins ShellCheck 0.10.0 and checks every tracked shell script at default severity", async () => {
  const workflow = await readFile(ciWorkflowUrl, "utf8");

  assert.match(workflow, /SHELLCHECK_VERSION: "0\.10\.0"/);
  assert.match(workflow, /SHELLCHECK_ARCHIVE_SHA256: "6c881ab0698e4e6ea235245f22832860544f17ba386442fe7e9d629f8cbedf87"/);
  assert.match(workflow, /sha256sum --check/);
  assert.match(workflow, /git ls-files '\*\.sh'/);
  assert.match(workflow, /"\$shellcheck_bin" -x "\$\{production_shell_scripts\[@\]\}"/);
  assert.doesNotMatch(workflow, /shellcheck_bin.*--severity/);
  assert.doesNotMatch(workflow, /curl[^\n]*\|\s*(?:ba)?sh/);
});
