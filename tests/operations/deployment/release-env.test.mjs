// Source-level assertions intentionally accompany behavioral shell execution because production release files cannot be exercised on a VPS in this suite.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const helperPath = fileURLToPath(new URL("../../../scripts/prepare-release-env.sh", import.meta.url));
const bashPath = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";

async function git(directory, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd: directory });
  return stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "al-lio-release-env-"));
  const previous = join(root, "previous.env");
  const release = join(root, "release");
  await execFileAsync("git", ["init", "--quiet", release]);
  await git(release, "config", "user.email", "tests@al-lio.invalid");
  await git(release, "config", "user.name", "AL-LIO tests");
  await writeFile(join(release, ".gitignore"), ".env\n", "utf8");
  await writeFile(join(release, "tracked.txt"), "immutable\n", "utf8");
  await git(release, "add", ".gitignore", "tracked.txt");
  await git(release, "commit", "--quiet", "-m", "release");
  const sha = await git(release, "rev-parse", "HEAD");
  await writeFile(previous, [
    "SECRET_VALUE=preserved",
    "AL_LIO_IMAGE_TAG=old",
    "export AL_LIO_IMAGE_TAG=exported-duplicate",
    "AL_LIO_RELEASE_SHA=old",
    "AL_LIO_RELEASE_SHA=duplicate",
    "  export AL_LIO_RELEASE_SHA=spaced-export-duplicate",
    "",
  ].join("\n"), "utf8");
  return { root, previous, release, sha, target: join(release, ".env") };
}

test("release environment preparation copies private values and injects one exact SHA", async () => {
  const current = await fixture();
  try {
    const { stdout } = await execFileAsync(bashPath, [
      helperPath.replaceAll("\\", "/"),
      current.previous.replaceAll("\\", "/"),
      current.target.replaceAll("\\", "/"),
      current.sha,
    ]);
    const contents = await readFile(current.target, "utf8");
    assert.match(stdout, new RegExp(current.sha));
    assert.match(contents, /^SECRET_VALUE=preserved$/m);
    assert.deepEqual(contents.match(/^AL_LIO_IMAGE_TAG=.*$/gm), [`AL_LIO_IMAGE_TAG=${current.sha}`]);
    assert.deepEqual(contents.match(/^AL_LIO_RELEASE_SHA=.*$/gm), [`AL_LIO_RELEASE_SHA=${current.sha}`]);
    assert.equal((contents.match(/^\s*(?:export\s+)?AL_LIO_IMAGE_TAG=/gm) ?? []).length, 1);
    assert.equal((contents.match(/^\s*(?:export\s+)?AL_LIO_RELEASE_SHA=/gm) ?? []).length, 1);
    if (process.platform !== "win32") {
      assert.equal((await stat(current.target)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});

test("release environment preparation rejects a valid SHA that does not match worktree HEAD", async () => {
  const current = await fixture();
  try {
    const differentSha = current.sha.replace(/^./, current.sha[0] === "0" ? "1" : "0");
    await assert.rejects(execFileAsync(bashPath, [
      helperPath.replaceAll("\\", "/"),
      current.previous.replaceAll("\\", "/"),
      current.target.replaceAll("\\", "/"),
      differentSha,
    ]), /HEAD does not match/);
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});

test("release environment preparation rejects a malformed identity", async () => {
  const current = await fixture();
  try {
    await assert.rejects(execFileAsync(bashPath, [
      helperPath.replaceAll("\\", "/"),
      current.previous.replaceAll("\\", "/"),
      current.target.replaceAll("\\", "/"),
      "not-a-sha",
    ]));
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});

test("release environment preparation rejects a dirty release worktree", async () => {
  const current = await fixture();
  try {
    await writeFile(join(current.release, "tracked.txt"), "changed\n", "utf8");
    await assert.rejects(execFileAsync(bashPath, [
      helperPath.replaceAll("\\", "/"),
      current.previous.replaceAll("\\", "/"),
      current.target.replaceAll("\\", "/"),
      current.sha,
    ]));
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});

test("release environment preparation rejects an untracked build-context source file", async () => {
  const current = await fixture();
  try {
    await mkdir(join(current.release, "src"), { recursive: true });
    await writeFile(join(current.release, "src", "untracked.ts"), "export const contaminant = true;\n", "utf8");
    await assert.rejects(execFileAsync(bashPath, [
      helperPath.replaceAll("\\", "/"),
      current.previous.replaceAll("\\", "/"),
      current.target.replaceAll("\\", "/"),
      current.sha,
    ]), /unexpected tracked or untracked files/);
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});

test("release environment preparation rejects an unexpected ignored build-context file", async () => {
  const current = await fixture();
  try {
    await writeFile(join(current.release, ".gitignore"), ".env\n.next/\n", "utf8");
    await git(current.release, "add", ".gitignore");
    await git(current.release, "commit", "--quiet", "-m", "ignore build output");
    current.sha = await git(current.release, "rev-parse", "HEAD");
    await mkdir(join(current.release, ".next"), { recursive: true });
    await writeFile(join(current.release, ".next", "contaminant.js"), "unexpected build output\n", "utf8");
    await assert.rejects(execFileAsync(bashPath, [
      helperPath.replaceAll("\\", "/"),
      current.previous.replaceAll("\\", "/"),
      current.target.replaceAll("\\", "/"),
      current.sha,
    ]), /unexpected ignored file/);
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});

test("release environment preparation permits only the expected ignored private .env", async () => {
  const current = await fixture();
  try {
    await writeFile(current.target, "PRIVATE_EXISTING_VALUE=preserved\n", "utf8");
    const { stdout } = await execFileAsync(bashPath, [
      helperPath.replaceAll("\\", "/"),
      current.previous.replaceAll("\\", "/"),
      current.target.replaceAll("\\", "/"),
      current.sha,
    ]);
    assert.match(stdout, new RegExp(current.sha));
    assert.equal(await git(current.release, "status", "--porcelain", "--untracked-files=all"), "");
    assert.equal(await git(current.release, "status", "--porcelain", "--ignored", "--untracked-files=all"), "!! .env");
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});
