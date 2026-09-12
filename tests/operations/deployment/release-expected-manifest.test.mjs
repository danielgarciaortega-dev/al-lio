import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helperPaths = [
  "../../../scripts/lib/release-worktree-integrity.sh",
  "../../../scripts/lib/release-expected-manifest.sh",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));
const bashPath = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
const toBashPath = (path) => path
  .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
  .replaceAll("\\", "/");

function git(repository, args, { env = {}, input, encoding = "utf8" } = {}) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding,
    env: { ...process.env, ...env },
    input,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr?.toString() ?? "");
  return encoding === null ? result.stdout : result.stdout.trim();
}

async function withRepository(run) {
  const root = await mkdtemp(join(tmpdir(), "al-lio-expected-manifest-"));
  try {
    const repository = join(root, "canonical");
    git(root, ["init", "--quiet", repository]);
    git(repository, ["config", "user.email", "tests@al-lio.invalid"]);
    git(repository, ["config", "user.name", "AL-LIO tests"]);
    git(repository, ["config", "core.autocrlf", "false"]);
    assert.equal(git(repository, ["rev-parse", "--show-object-format"]), "sha1");
    await run(repository);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const hashBlob = (repository, contents) => git(repository, ["hash-object", "-w", "--stdin"], {
  input: Buffer.from(contents),
});

function commitEntries(repository, entries, message = "fixture tree") {
  const env = { GIT_INDEX_FILE: join(repository, ".git", `manifest-index-${Math.random()}`) };
  git(repository, ["read-tree", "--empty"], { env });
  for (const { mode, objectId, path } of entries) {
    git(repository, ["update-index", "--add", "--cacheinfo", `${mode},${objectId},${path}`], { env });
  }
  return git(repository, ["commit-tree", git(repository, ["write-tree"], { env }), "-m", message]);
}

function commitRootPaths(repository, objectId, paths) {
  const input = Buffer.concat(paths.map((path) => Buffer.from(`100644 blob ${objectId}\t${path}\0`)));
  const tree = git(repository, ["mktree", "-z"], { input });
  return git(repository, ["commit-tree", tree, "-m", "special path tree"]);
}

function runBash(repository, body, env = {}) {
  const sources = helperPaths.map((path) => `source "${toBashPath(path)}"`).join("\n");
  return spawnSync(bashPath, ["-s"], {
    cwd: repository,
    encoding: null,
    env: { ...process.env, ...env },
    input: `set -Eeuo pipefail\n${sources}\n${body}\n`,
  });
}

function runManifest(repository, commitSha) {
  return runBash(repository, `
if ! build_expected_release_manifest "${toBashPath(repository)}" "${commitSha}"; then
  printf '%s\\n' "$release_worktree_integrity_error" >&2
  exit 1
fi`);
}

function manifestRecords(buffer) {
  if (buffer.length === 0) return [];
  assert.equal(buffer.at(-1), 0, "manifest must end with a NUL delimiter");
  return buffer.subarray(0, -1).toString("utf8").split("\0");
}

const fileRecord = (mode, objectId, path) => `F\t${mode}\t${objectId}\t${path}`;
const directoryRecord = (path) => `D\t040000\t-\t${path}`;

test("expected release manifest contract", async (t) => withRepository(async (repository) => {
  const blob = hashBlob(repository, "content\n");

  await t.test("is deterministic and preserves paths and regular file modes", () => {
    const scriptBlob = hashBlob(repository, "#!/bin/sh\necho ok\n");
    const commit = commitEntries(repository, [
      { mode: "100644", objectId: blob, path: "docs/nested/read me.txt" },
      { mode: "100755", objectId: scriptBlob, path: "bin/run.sh" },
    ]);
    const first = runManifest(repository, commit);
    const second = runManifest(repository, commit);
    assert.equal(first.status, 0, first.stderr.toString());
    assert.deepEqual(first.stdout, second.stdout);
    const records = manifestRecords(first.stdout);
    assert.deepEqual(records, [...records].sort());
    assert.deepEqual(records, [
      directoryRecord("bin"),
      directoryRecord("docs"),
      directoryRecord("docs/nested"),
      fileRecord("100644", blob, "docs/nested/read me.txt"),
      fileRecord("100755", scriptBlob, "bin/run.sh"),
    ]);
  });

  await t.test("preserves every legal special path byte", () => {
    const paths = ["name\twith-tab.txt", "name\nwith-newline.txt", "$HOME;$(echo nope) [file].txt", "two words.txt"];
    const result = runManifest(repository, commitRootPaths(repository, blob, paths));
    assert.equal(result.status, 0, result.stderr.toString());
    const records = manifestRecords(result.stdout);
    for (const path of paths) assert.ok(records.includes(fileRecord("100644", blob, path)));
  });

  await t.test("rejects symlink and gitlink entries", () => {
    const base = commitEntries(repository, [{ mode: "100644", objectId: blob, path: "base.txt" }]);
    for (const [mode, objectId, path, error] of [
      ["120000", blob, "link", /unsupported mode\/type: 120000 blob link/],
      ["160000", base, "vendor/submodule", /unsupported mode\/type: 160000 commit vendor\/submodule/],
    ]) {
      const result = runManifest(repository, commitEntries(repository, [{ mode, objectId, path }]));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr.toString(), error);
    }
  });

  await t.test("rejects private env and forbidden path forms", () => {
    const envResult = runManifest(repository, commitEntries(repository, [
      { mode: "100644", objectId: blob, path: ".env" },
    ]));
    assert.notEqual(envResult.status, 0);
    assert.match(envResult.stderr.toString(), /must not track the private root \.env file/);
    for (const [path, error] of [
      ["", /empty path/], ["/absolute.txt", /must be relative/],
      ["dir/./file.txt", /forbidden dot component/], ["dir/../file.txt", /forbidden dot component/],
      [".git", /must not track release Git metadata/], [".git/config", /must not track release Git metadata/],
    ]) {
      const result = runBash(repository, `
if ! validate_expected_release_manifest_path "$PATH_VALUE"; then
  printf '%s\\n' "$release_worktree_integrity_error" >&2
  exit 1
fi`, { PATH_VALUE: path });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr.toString(), error);
    }
  });

  await t.test("emits zero bytes for an empty tree", () => {
    const result = runManifest(repository, commitEntries(repository, [], "empty tree"));
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stdout.length, 0);
  });
}));
