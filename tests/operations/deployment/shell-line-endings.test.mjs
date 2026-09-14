// Source-level assertion rationale: the contract is the exact Git attribute,
// index blob bytes, and executable mode committed for production shell scripts.
// Git commands exercise those repository boundaries directly without running
// production operations or depending on the checkout's platform line endings.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = dirname(fileURLToPath(new URL("../../../package.json", import.meta.url)));

const productionShellModes = [
  ["scripts/deploy-production.sh", "100755"],
  ["scripts/github-actions-deploy-entrypoint.sh", "100755"],
  ["scripts/lib/compose-env-guard.sh", "100644"],
  ["scripts/lib/production-transition-policy.sh", "100644"],
  ["scripts/lib/release-worktree-integrity.sh", "100644"],
  ["scripts/postgres/backup-production.sh", "100644"],
  ["scripts/postgres/verify-backup-production.sh", "100644"],
  ["scripts/prepare-release-env.sh", "100644"],
  ["scripts/validate-production-transition.sh", "100644"],
];

async function git(args, options = {}) {
  return execFileAsync("git", args, {
    cwd: repositoryRoot,
    maxBuffer: 2 * 1024 * 1024,
    ...options,
  });
}

async function trackedShellScripts() {
  const { stdout } = await git(["ls-files", "*.sh"]);
  return stdout.trim().split(/\r?\n/).filter(Boolean);
}

test("the repository enforces LF for shell scripts with one narrow attribute rule", async () => {
  const attributes = await readFile(new URL("../../../.gitattributes", import.meta.url), "utf8");
  assert.equal(attributes, "*.sh text eol=lf\n");

  const shellScripts = await trackedShellScripts();
  assert.ok(shellScripts.length > 0);
  const { stdout } = await git([
    "check-attr",
    "text",
    "eol",
    "--",
    ...shellScripts,
  ]);
  for (const path of shellScripts) {
    assert.match(stdout, new RegExp(`^${path.replaceAll("/", "\\/")}: text: set$`, "m"));
    assert.match(stdout, new RegExp(`^${path.replaceAll("/", "\\/")}: eol: lf$`, "m"));
  }
});

test("every staged tracked shell blob contains no carriage returns", async () => {
  const shellScripts = await trackedShellScripts();
  assert.ok(shellScripts.length > 0);
  for (const path of shellScripts) {
    const { stdout: blob } = await git(["show", `:${path}`], { encoding: "buffer" });
    assert.equal(blob.includes(13), false, `${path} staged blob must not contain CR bytes`);
  }
});

test("production shell scripts preserve their contractual Git modes", async () => {
  for (const [path, expectedMode] of productionShellModes) {
    const { stdout: indexEntry } = await git(["ls-files", "--stage", "--", path]);
    assert.match(indexEntry.trimEnd(), new RegExp(`^${expectedMode} [0-9a-f]{40} 0\\t${path}$`));
  }
});
