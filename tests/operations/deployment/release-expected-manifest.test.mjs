import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const integrityHelperUrl = new URL(
  "../../../scripts/lib/release-worktree-integrity.sh",
  import.meta.url,
);
const manifestHelperUrl = new URL(
  "../../../scripts/lib/release-expected-manifest.sh",
  import.meta.url,
);
const bashPath = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";

function toBashPath(path) {
  return path.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll("\\", "/");
}

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

async function createRepository(root) {
  const repository = join(root, "canonical");
  git(root, ["init", "--quiet", repository]);
  git(repository, ["config", "user.email", "tests@al-lio.invalid"]);
  git(repository, ["config", "user.name", "AL-LIO tests"]);
  git(repository, ["config", "core.autocrlf", "false"]);
  assert.equal(git(repository, ["rev-parse", "--show-object-format"]), "sha1");
  return repository;
}

function hashBlob(repository, contents) {
  return git(repository, ["hash-object", "-w", "--stdin"], {
    input: Buffer.isBuffer(contents) ? contents : Buffer.from(contents),
  });
}

function commitEntries(repository, entries, message = "fixture tree") {
  const indexPath = join(repository, ".git", `manifest-index-${process.pid}-${Math.random()}`);
  const env = { GIT_INDEX_FILE: indexPath };
  git(repository, ["read-tree", "--empty"], { env });
  for (const entry of entries) {
    git(
      repository,
      ["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.objectId},${entry.path}`],
      { env },
    );
  }
  const tree = git(repository, ["write-tree"], { env });
  return git(repository, ["commit-tree", tree, "-m", message]);
}

function runManifest(repository, commitSha, env = {}) {
  const integrityHelper = toBashPath(fileURLToPath(integrityHelperUrl));
  const manifestHelper = toBashPath(fileURLToPath(manifestHelperUrl));
  const repositoryPath = toBashPath(repository);
  return spawnSync(bashPath, ["-s"], {
    encoding: null,
    env: { ...process.env, ...env },
    input: `set -Eeuo pipefail\nsource "${integrityHelper}"\nsource "${manifestHelper}"\nbuild_expected_release_manifest "${repositoryPath}" "${commitSha}"\n`,
  });
}

function manifestRecords(buffer) {
  if (buffer.length === 0) return [];
  assert.equal(buffer.at(-1), 0, "manifest must end with a NUL delimiter");
  return buffer.subarray(0, -1).toString("utf8").split("\0");
}

function fileRecord(mode, objectId, path) {
  return `F\t${mode}\t${objectId}\t${path}`;
}

function directoryRecord(path) {
  return `D\t040000\t-\t${path}`;
}

function runPathValidation(repository, path) {
  const integrityHelper = toBashPath(fileURLToPath(integrityHelperUrl));
  const manifestHelper = toBashPath(fileURLToPath(manifestHelperUrl));
  return spawnSync(bashPath, ["-s"], {
    encoding: "utf8",
    env: { ...process.env, PATH_VALUE: path },
    input: `set -Eeuo pipefail\nsource "${integrityHelper}"\nsource "${manifestHelper}"\nif validate_expected_release_manifest_path "$PATH_VALUE"; then\n  printf 'accepted\\n'\nelse\n  printf '%s\\n' "$release_worktree_integrity_error" >&2\n  exit 1\nfi\n`,
    cwd: repository,
  });
}

test("expected manifest is deterministic, NUL-delimited, and preserves regular file modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "al-lio-expected-manifest-normal-"));
  try {
    const repository = await createRepository(root);
    const rootBlob = hashBlob(repository, "root\n");
    const scriptBlob = hashBlob(repository, "#!/bin/sh\necho ok\n");
    const nestedBlob = hashBlob(repository, "nested\n");
    const commitSha = commitEntries(repository, [
      { mode: "100644", objectId: nestedBlob, path: "docs/nested/read me.txt" },
      { mode: "100755", objectId: scriptBlob, path: "bin/run.sh" },
      { mode: "100644", objectId: rootBlob, path: "root.txt" },
    ]);

    const first = runManifest(repository, commitSha);
    const second = runManifest(repository, commitSha);
    assert.equal(first.status, 0, first.stderr.toString());
    assert.equal(second.status, 0, second.stderr.toString());
    assert.deepEqual(first.stdout, second.stdout);

    const records = manifestRecords(first.stdout);
    assert.deepEqual(records, [...records].sort());
    assert.deepEqual(records, [
      directoryRecord("bin"),
      directoryRecord("docs"),
      directoryRecord("docs/nested"),
      fileRecord("100755", scriptBlob, "bin/run.sh"),
      fileRecord("100644", nestedBlob, "docs/nested/read me.txt"),
      fileRecord("100644", rootBlob, "root.txt"),
    ]);
    assert.equal(records.filter((record) => record === directoryRecord("docs")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expected manifest preserves TAB, newline, spaces, and shell metacharacters in Git path bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "al-lio-expected-manifest-paths-"));
  try {
    const repository = await createRepository(root);
    const blob = hashBlob(repository, "content\n");
    const paths = [
      "tabs/name\twith-tab.txt",
      "lines/name\nwith-newline.txt",
      "meta/$HOME;$(echo nope) [file].txt",
      "spaces/two words.txt",
    ];
    const commitSha = commitEntries(
      repository,
      paths.map((path) => ({ mode: "100644", objectId: blob, path })),
      "special path tree",
    );

    const result = runManifest(repository, commitSha);
    assert.equal(result.status, 0, result.stderr.toString());
    const records = manifestRecords(result.stdout);
    for (const path of paths) {
      assert.ok(records.includes(fileRecord("100644", blob, path)), `missing exact path: ${JSON.stringify(path)}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expected manifest rejects symlink and gitlink entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "al-lio-expected-manifest-types-"));
  try {
    const repository = await createRepository(root);
    const blob = hashBlob(repository, "target\n");
    const baseCommit = commitEntries(repository, [
      { mode: "100644", objectId: blob, path: "base.txt" },
    ], "base commit");

    await t.test("120000 symlink", () => {
      const commitSha = commitEntries(repository, [
        { mode: "120000", objectId: blob, path: "link" },
      ], "symlink commit");
      const result = runManifest(repository, commitSha);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr.toString(), /unsupported mode\/type: 120000 blob link/);
    });

    await t.test("160000 gitlink", () => {
      const commitSha = commitEntries(repository, [
        { mode: "160000", objectId: baseCommit, path: "vendor/submodule" },
      ], "gitlink commit");
      const result = runManifest(repository, commitSha);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr.toString(), /unsupported mode\/type: 160000 commit vendor\/submodule/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expected manifest rejects tracked root .env", async () => {
  const root = await mkdtemp(join(tmpdir(), "al-lio-expected-manifest-env-"));
  try {
    const repository = await createRepository(root);
    const blob = hashBlob(repository, "SECRET=not-real\n");
    const commitSha = commitEntries(repository, [
      { mode: "100644", objectId: blob, path: ".env" },
    ]);

    const result = runManifest(repository, commitSha);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr.toString(), /must not track the private root \.env file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expected manifest path validator rejects empty, absolute, dot-component, and Git metadata paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "al-lio-expected-manifest-path-validation-"));
  try {
    const repository = await createRepository(root);
    for (const [name, path, expectedError] of [
      ["empty", "", /empty path/],
      ["absolute", "/absolute.txt", /must be relative/],
      ["dot", "dir/./file.txt", /forbidden dot component/],
      ["dotdot", "dir/../file.txt", /forbidden dot component/],
      ["git root", ".git", /must not track release Git metadata/],
      ["git child", ".git/config", /must not track release Git metadata/],
    ]) {
      await t.test(name, () => {
        const result = runPathValidation(repository, path);
        assert.notEqual(result.status, 0, `${name} unexpectedly passed`);
        assert.match(result.stderr, expectedError);
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expected manifest emits zero bytes for an empty candidate tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "al-lio-expected-manifest-empty-"));
  try {
    const repository = await createRepository(root);
    const commitSha = commitEntries(repository, [], "empty tree");
    const result = runManifest(repository, commitSha);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stdout.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
