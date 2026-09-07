// Source-level assertion rationale: GitHub Actions cannot be executed safely inside the unit runner,
// so trigger, serialization, and immutable-release guarantees remain structural contracts.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../../../.github/workflows/deploy-production.yml", import.meta.url);
const ciWorkflowUrl = new URL("../../../.github/workflows/ci.yml", import.meta.url);
const entrypointUrl = new URL("../../../scripts/github-actions-deploy-entrypoint.sh", import.meta.url);

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
