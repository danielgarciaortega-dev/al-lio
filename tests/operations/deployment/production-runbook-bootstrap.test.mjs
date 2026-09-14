// Source-level assertion rationale: the exceptional runbook is executed manually against
// production, so executing the real boundary here would mutate VPS state. This test
// protects the trust-bootstrap ordering without executing production mutations.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runbookUrl = new URL("../../../docs/operations/DEPLOY_VPS.md", import.meta.url);

function bashBlockContaining(markdown, marker) {
  for (const match of markdown.matchAll(/```bash\r?\n([\s\S]*?)\r?\n```/g)) {
    if (match[1].includes(marker)) return match[1];
  }
  assert.fail(`No Bash block contains: ${marker}`);
}

test("the exceptional candidate validates with an exact Git-blob helper before using candidate worktree code", async () => {
  const runbook = await readFile(runbookUrl, "utf8");
  const block = bashBlockContaining(runbook, "worktree add --detach");

  assert.doesNotMatch(
    block,
    /source "\$AL_LIO_RELEASE_DIR\/scripts\/lib\/release-worktree-integrity\.sh"/,
  );
  assert.match(
    block,
    /git -C "\$AL_LIO_REPOSITORY_DIR" ls-tree "\$AL_LIO_RELEASE_SHA" --[\s\\\n]+scripts\/lib\/release-worktree-integrity\.sh/,
  );
  assert.match(block, /"\$AL_LIO_CANDIDATE_INTEGRITY_MODE" == 100644/);
  assert.match(block, /"\$AL_LIO_CANDIDATE_INTEGRITY_TYPE" == blob/);
  assert.match(
    block,
    /git -C "\$AL_LIO_REPOSITORY_DIR" cat-file blob[\s\\\n]+"\$AL_LIO_CANDIDATE_INTEGRITY_OBJECT" > "\$AL_LIO_CANDIDATE_INTEGRITY_HELPER"/,
  );
  assert.match(
    block,
    /git hash-object --no-filters "\$AL_LIO_CANDIDATE_INTEGRITY_HELPER"/,
  );
  assert.match(block, /source "\$AL_LIO_CANDIDATE_INTEGRITY_HELPER"/);

  const materializeIndex = block.indexOf(
    '"$AL_LIO_CANDIDATE_INTEGRITY_OBJECT" > "$AL_LIO_CANDIDATE_INTEGRITY_HELPER"',
  );
  const sourceIndex = block.indexOf('source "$AL_LIO_CANDIDATE_INTEGRITY_HELPER"');
  const validateIndex = block.indexOf(
    'validate_release_worktree_integrity "$AL_LIO_RELEASE_DIR" "$AL_LIO_RELEASE_SHA"',
  );
  const candidateCodeIndex = block.indexOf(
    'bash "$AL_LIO_RELEASE_DIR/scripts/prepare-release-env.sh"',
  );

  assert.ok(materializeIndex >= 0, "exact helper blob is materialized");
  assert.ok(sourceIndex > materializeIndex, "only the materialized helper is sourced");
  assert.ok(validateIndex > sourceIndex, "candidate worktree is validated with the trusted helper");
  assert.ok(
    candidateCodeIndex > validateIndex,
    "candidate worktree code is not executed until worktree validation passes",
  );
});

test("delayed recovery bootstraps every validator from canonical objects before release access", async () => {
  const runbook = await readFile(runbookUrl, "utf8");
  const block = bashBlockContaining(runbook, "AL_LIO_SELECTED_RELEASE_RECORD");
  const bootstrapStart = block.indexOf("trusted_recovery_git() {");
  const validationStart = block.indexOf("validate_recovery_worktree() {");
  const bootstrap = block.slice(bootstrapStart, validationStart);

  assert.ok(bootstrapStart >= 0 && validationStart > bootstrapStart);
  assert.match(bootstrap, /GIT_NO_REPLACE_OBJECTS=1/);
  assert.match(bootstrap, /--no-replace-objects/);
  assert.match(bootstrap, /--git-dir="\$repository_dir\/\.git"/);
  assert.doesNotMatch(bootstrap, /git -C "\$AL_LIO_(?:PREVIOUS_)?RELEASE_DIR"/);
  for (const helper of [
    "release-worktree-integrity.sh",
    "release-expected-manifest.sh",
    "release-physical-topology.sh",
    "release-physical-blobs.sh",
  ]) {
    assert.ok(bootstrap.includes(`scripts/lib/${helper}`), `${helper} is not canonicalized`);
  }
  assert.match(bootstrap, /"\$mode" == 100644 &&[\s\S]*"\$type" == blob/);
  assert.match(bootstrap, /hash-object --no-filters --stdin < "\$target"/);
  assert.match(bootstrap, /stat -c '%F\|%a\|%u\|%h'/);
  assert.doesNotMatch(block, /al-lio-local-recovery\.patch/);

  const physicalValidation = block.indexOf("validate_release_physical_blobs");
  const envRead = block.indexOf("read_env_value AL_LIO_IMAGE_TAG", physicalValidation);
  const previousValidation = block.indexOf("validate_recovery_worktree previous");
  const candidateValidation = block.indexOf("validate_recovery_worktree candidate");
  assert.ok(physicalValidation > validationStart && envRead > physicalValidation);
  assert.ok(previousValidation > envRead && candidateValidation > previousValidation);
});
