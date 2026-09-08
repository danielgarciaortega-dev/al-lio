import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  link,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const integrityHelperUrl = new URL(
  "../../../scripts/lib/release-worktree-integrity.sh",
  import.meta.url,
);
const bashPath = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";

function toBashPath(path) {
  return path.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll("\\", "/");
}

function git(directory, args, env = {}) {
  const result = spawnSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function write(root, path, contents) {
  const target = join(root, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

async function commitAll(repository, message) {
  git(repository, ["add", "--all"]);
  git(repository, ["commit", "--quiet", "-m", message]);
  return git(repository, ["rev-parse", "HEAD"]);
}

async function createRepository(root, name, contents) {
  const repository = join(root, name);
  await mkdir(repository);
  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.email", "tests@al-lio.invalid"]);
  git(repository, ["config", "user.name", "AL-LIO tests"]);
  git(repository, ["config", "core.autocrlf", "false"]);
  await write(repository, "marker.txt", contents);
  const commitSha = await commitAll(repository, `${name} commit`);
  return { repository, commitSha };
}

async function runHelper(repository, script, env = {}) {
  const helperPath = toBashPath(fileURLToPath(integrityHelperUrl));
  const repositoryPath = toBashPath(repository);
  return spawnSync(bashPath, ["-s"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    input: `set -Eeuo pipefail
source "${helperPath}"
REPOSITORY="${repositoryPath}"
${script}
`,
  });
}

function validationScript(sha) {
  return `if validate_release_commit_identity "$REPOSITORY" "${sha}"; then
  printf 'accepted\\n'
else
  printf 'rejected=%s\\n' "$release_worktree_integrity_error" >&2
  exit 1
fi`;
}

async function createReleaseGitfileFixture(root) {
  const canonical = await createRepository(root, "canonical", "trusted\n");
  const release = join(root, "release");
  git(canonical.repository, [
    "worktree",
    "add",
    "--quiet",
    "--detach",
    release,
    canonical.commitSha,
  ]);
  const gitfile = join(release, ".git");
  const gitfileContents = await readFile(gitfile, "utf8");
  const rawGitdir = gitfileContents.slice("gitdir: ".length, -1);
  return {
    ...canonical,
    release,
    gitfile,
    linkedGitdir: rawGitdir.replaceAll("/", process.platform === "win32" ? "\\" : "/"),
  };
}

async function runGitfileValidation(fixture, setup = "", successChecks = "") {
  return runHelper(
    fixture.repository,
    `${setup}
RELEASE="${toBashPath(fixture.release)}"
if validate_release_gitfile_linkage "$REPOSITORY" "$RELEASE"; then
  ${successChecks}
  builtin printf 'accepted\\n'
else
  builtin printf 'rejected=%s\\n' "$release_worktree_integrity_error" >&2
  exit 1
fi`,
  );
}

async function expectGitfileRejection(fixture, expectedError, setup = "") {
  const result = await runGitfileValidation(fixture, setup);
  assert.notEqual(result.status, 0, "hostile gitfile linkage unexpectedly passed");
  assert.match(result.stderr, expectedError);
}

async function writeGitfileTarget(fixture, target) {
  await rm(fixture.gitfile);
  await writeFile(fixture.gitfile, `gitdir: ${target}\n`, "utf8");
}

async function replaceGitfile(fixture, contents) {
  await rm(fixture.gitfile);
  await writeFile(fixture.gitfile, contents);
}

async function createFileSymlink(target, path) {
  try {
    await symlink(target, path, "file");
  } catch (error) {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    const result = spawnSync(
      bashPath,
      ["-lc", `ln -s -- ${quoteBashPath(target)} ${quoteBashPath(path)}`],
      {
        encoding: "utf8",
        env: { ...process.env, MSYS: "winsymlinks:sys" },
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }
}

function quoteBashPath(value) {
  return `'${toBashPath(value).replaceAll("'", "'\\''")}'`;
}

test("canonical commit identity accepts only an exact lowercase commit SHA", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "al-lio-trusted-git-identity-"));
  try {
    const fixture = await createRepository(root, "canonical", "trusted\n");
    const blobSha = git(fixture.repository, ["rev-parse", `${fixture.commitSha}:marker.txt`]);
    const treeSha = git(fixture.repository, ["rev-parse", `${fixture.commitSha}^{tree}`]);
    git(fixture.repository, ["tag", "--annotate", "--message", "tag object", "release-tag"]);
    const tagSha = git(fixture.repository, ["rev-parse", "release-tag^{tag}"]);

    await t.test("valid lowercase 40-character commit", async () => {
      const accepted = await runHelper(
        fixture.repository,
        validationScript(fixture.commitSha),
      );
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.equal(accepted.stdout, "accepted\n");
    });

    for (const [name, sha, expectedError] of [
      ["abbreviated", fixture.commitSha.slice(0, 12), /exactly 40 lowercase/],
      ["uppercase", fixture.commitSha.toUpperCase(), /exactly 40 lowercase/],
      ["malformed", "not-a-sha", /exactly 40 lowercase/],
      ["nonexistent", "0".repeat(40), /does not resolve in the canonical repository/],
      ["blob", blobSha, /Release object is not a commit/],
      ["tree", treeSha, /Release object is not a commit/],
      ["annotated tag", tagSha, /Release object is not a commit/],
    ]) {
      await t.test(`${name} object identity`, async () => {
        const rejected = await runHelper(fixture.repository, validationScript(sha));
        assert.notEqual(rejected.status, 0, `${name} unexpectedly passed`);
        assert.match(rejected.stderr, expectedError, name);
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hostile caller Git repository and index environment cannot redirect lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "al-lio-trusted-git-environment-"));
  try {
    const canonical = await createRepository(root, "canonical", "trusted\n");
    const hostile = await createRepository(root, "hostile", "hostile\n");
    const result = await runHelper(
      canonical.repository,
      validationScript(canonical.commitSha),
      {
        GIT_DIR: toBashPath(join(hostile.repository, ".git")),
        GIT_WORK_TREE: toBashPath(hostile.repository),
        GIT_COMMON_DIR: toBashPath(join(hostile.repository, ".git")),
        GIT_INDEX_FILE: toBashPath(join(hostile.repository, ".git", "index")),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "accepted\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical commit identity rejects non-canonical repository paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "al-lio-trusted-git-path-"));
  try {
    const canonical = await createRepository(root, "canonical", "trusted\n");
    const relative = await runHelper(
      canonical.repository,
      `if validate_release_commit_identity "." "${canonical.commitSha}"; then exit 41; fi
printf 'relative=%s\\n' "$release_worktree_integrity_error"`,
    );
    assert.equal(relative.status, 0, relative.stderr);
    assert.match(relative.stdout, /Canonical repository Git directory is unavailable/);

    const alias = join(root, "canonical-alias");
    await symlink(
      canonical.repository,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const linked = await runHelper(alias, validationScript(canonical.commitSha));
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr, /Canonical repository Git directory is unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hostile object, alternate-object and namespace environment cannot redirect lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "al-lio-trusted-git-objects-"));
  try {
    const canonical = await createRepository(root, "canonical", "trusted\n");
    const hostile = await createRepository(root, "hostile", "hostile\n");
    const result = await runHelper(
      canonical.repository,
      validationScript(canonical.commitSha),
      {
        GIT_OBJECT_DIRECTORY: toBashPath(join(hostile.repository, ".git", "objects")),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: toBashPath(join(hostile.repository, ".git", "objects")),
        GIT_NAMESPACE: "hostile-namespace",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "accepted\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hostile system and global Git config cannot influence trusted lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "al-lio-trusted-git-config-"));
  try {
    const canonical = await createRepository(root, "canonical", "trusted\n");
    const hostile = await createRepository(root, "hostile", "hostile\n");
    const systemConfig = join(root, "system.gitconfig");
    const globalConfig = join(root, "global.gitconfig");
    await writeFile(
      systemConfig,
      `[al-lio]\n\tsystem-sentinel = hostile\n[core]\n\tworktree = ${toBashPath(hostile.repository)}\n`,
      "utf8",
    );
    await writeFile(
      globalConfig,
      `[al-lio]\n\tglobal-sentinel = hostile\n[core]\n\tworktree = ${toBashPath(hostile.repository)}\n`,
      "utf8",
    );

    const result = await runHelper(
      canonical.repository,
      `if trusted_git "$REPOSITORY" config --get al-lio.system-sentinel; then exit 41; fi
if trusted_git "$REPOSITORY" config --get al-lio.global-sentinel; then exit 42; fi
${validationScript(canonical.commitSha)}`,
      {
        GIT_CONFIG_SYSTEM: toBashPath(systemConfig),
        GIT_CONFIG_GLOBAL: toBashPath(globalConfig),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "accepted\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted lookup ignores a malicious git replace visible to unhardened Git", async () => {
  const root = await mkdtemp(join(tmpdir(), "al-lio-trusted-git-replace-"));
  try {
    const fixture = await createRepository(root, "canonical", "trusted\n");
    await write(fixture.repository, "marker.txt", "hostile\n");
    const hostileSha = await commitAll(fixture.repository, "hostile replacement");
    git(fixture.repository, ["replace", fixture.commitSha, hostileSha]);

    assert.equal(
      git(fixture.repository, ["show", `${fixture.commitSha}:marker.txt`]),
      "hostile",
    );

    const result = await runHelper(
      fixture.repository,
      `printf 'trusted-content=%s\\n' "$(trusted_git "$REPOSITORY" show "${fixture.commitSha}:marker.txt")"
${validationScript(fixture.commitSha)}`,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "trusted-content=trusted\naccepted\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted lookup ignores a hostile GIT_REPLACE_REF_BASE", async () => {
  const root = await mkdtemp(join(tmpdir(), "al-lio-trusted-git-replace-base-"));
  try {
    const fixture = await createRepository(root, "canonical", "trusted\n");
    await write(fixture.repository, "marker.txt", "hostile\n");
    const hostileSha = await commitAll(fixture.repository, "hostile replacement base");
    const replacementBase = "refs/hostile-replacements/";
    git(fixture.repository, [
      "update-ref",
      `${replacementBase}${fixture.commitSha}`,
      hostileSha,
    ]);

    assert.equal(
      git(
        fixture.repository,
        ["show", `${fixture.commitSha}:marker.txt`],
        { GIT_REPLACE_REF_BASE: replacementBase },
      ),
      "hostile",
    );

    const result = await runHelper(
      fixture.repository,
      `printf 'trusted-content=%s\\n' "$(trusted_git "$REPOSITORY" show "${fixture.commitSha}:marker.txt")"
${validationScript(fixture.commitSha)}`,
      { GIT_REPLACE_REF_BASE: replacementBase },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "trusted-content=trusted\naccepted\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release gitfile linkage accepts a valid detached worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "al-lio-release-gitfile-valid-"));
  try {
    const fixture = await createReleaseGitfileFixture(root);
    const result = await runGitfileValidation(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "accepted\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release gitfile linkage ignores hostile shell utility functions and PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "al-lio-release-gitfile-hostile-shell-"));
  try {
    const fixture = await createReleaseGitfileFixture(root);
    const sentinelPrefix = toBashPath(join(root, "hostile-utility-called"));
    const utilities = ["stat", "id", "readlink", "od", "awk", "cygpath", "env", "printf", "read"];
    const setup = `SENTINEL_PREFIX="${sentinelPrefix}"
stat() { : > "\${SENTINEL_PREFIX}-stat"; builtin printf '000\\n'; }
id() { : > "\${SENTINEL_PREFIX}-id"; builtin printf '999999\\n'; }
readlink() { : > "\${SENTINEL_PREFIX}-readlink"; builtin printf '/hostile\\n'; }
od() { : > "\${SENTINEL_PREFIX}-od"; builtin printf '0\\n'; }
awk() { : > "\${SENTINEL_PREFIX}-awk"; return 97; }
cygpath() { : > "\${SENTINEL_PREFIX}-cygpath"; builtin printf '/hostile\\n'; }
env() { : > "\${SENTINEL_PREFIX}-env"; return 97; }
printf() { : > "\${SENTINEL_PREFIX}-printf"; return 97; }
read() { : > "\${SENTINEL_PREFIX}-read"; return 97; }
PATH=/hostile`;
    const successChecks = `for utility in ${utilities.join(" ")}; do
  [[ ! -e "\${SENTINEL_PREFIX}-\${utility}" ]] || {
    builtin printf 'hostile utility executed: %s\\n' "$utility" >&2
    exit 91
  }
done`;
    const result = await runGitfileValidation(fixture, setup, successChecks);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "accepted\n");
    for (const utility of utilities) {
      await assert.rejects(readFile(`${join(root, "hostile-utility-called")}-${utility}`), {
        code: "ENOENT",
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release .git must be a single regular file with strict metadata", async (t) => {
  for (const [name, mutate, expectedError] of [
    [
      "directory",
      async (fixture) => {
        await rm(fixture.gitfile);
        await mkdir(fixture.gitfile);
      },
      /regular non-symlink file/,
    ],
    [
      "symlink",
      async (fixture) => {
        const target = join(dirname(fixture.release), "linked-gitfile");
        await writeFile(target, await readFile(fixture.gitfile));
        await rm(fixture.gitfile);
        await createFileSymlink(target, fixture.gitfile);
      },
      /regular non-symlink file/,
    ],
    [
      "hard link",
      async (fixture) => {
        await link(fixture.gitfile, join(dirname(fixture.release), "gitfile-hardlink"));
      },
      /one hard link/,
    ],
  ]) {
    await t.test(name, async () => {
      const root = await mkdtemp(join(tmpdir(), `al-lio-release-gitfile-${name}-`));
      try {
        const fixture = await createReleaseGitfileFixture(root);
        await mutate(fixture);
        await expectGitfileRejection(fixture, expectedError);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  await t.test("mode changed on the physical file", async (modeTest) => {
    const root = await mkdtemp(join(tmpdir(), "al-lio-release-gitfile-mode-"));
    try {
      const fixture = await createReleaseGitfileFixture(root);
      await chmod(fixture.gitfile, 0o600);
      const mode = spawnSync(
        bashPath,
        ["-lc", `/usr/bin/stat -c '%a' -- ${quoteBashPath(fixture.gitfile)}`],
        { encoding: "utf8" },
      );
      assert.ifError(mode.error);
      assert.equal(mode.status, 0, mode.stderr);
      if (mode.stdout.trim() === "644") {
        modeTest.skip("Git Bash on this Windows filesystem does not expose chmod mode changes");
        return;
      }
      await expectGitfileRejection(fixture, /mode 0644/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("release .git rejects malformed raw bytes before parsing", async (t) => {
  const malformedCases = [
    ["empty file", Buffer.alloc(0), /between 1 and 4096 bytes/],
    ["empty target", Buffer.from("gitdir: \n"), /empty gitdir target/],
    ["multiple lines", Buffer.from("gitdir: /tmp/one\n/tmp/two\n"), /exactly one control-free line/],
    ["missing final LF", Buffer.from("gitdir: /tmp/one"), /exactly one control-free line/],
    ["carriage return", Buffer.from("gitdir: /tmp/one\r\n"), /exactly one control-free line/],
    ["NUL", Buffer.from("gitdir: /tmp/\0one\n"), /exactly one control-free line/],
    ["C0 control", Buffer.from("gitdir: /tmp/\u0001one\n"), /exactly one control-free line/],
    ["DEL control", Buffer.from("gitdir: /tmp/\u007fone\n"), /exactly one control-free line/],
    ["wrong prefix", Buffer.from("git-dir: /tmp/one\n"), /literal prefix/],
    ["relative target", Buffer.from("gitdir: ../canonical/.git/worktrees/release\n"), /must be absolute/],
    ["oversized", Buffer.from(`gitdir: /${"a".repeat(4096)}\n`), /between 1 and 4096 bytes/],
  ];

  for (const [name, contents, expectedError] of malformedCases) {
    await t.test(name, async () => {
      const root = await mkdtemp(join(tmpdir(), `al-lio-release-gitfile-raw-${name}-`));
      try {
        const fixture = await createReleaseGitfileFixture(root);
        await replaceGitfile(fixture, contents);
        await expectGitfileRejection(fixture, expectedError);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("release gitdir target must be the exact canonical immediate worktree child", async (t) => {
  await t.test("outside canonical worktrees", async () => {
    const root = await mkdtemp(join(tmpdir(), "al-lio-release-gitfile-outside-"));
    try {
      const fixture = await createReleaseGitfileFixture(root);
      const outside = join(root, "outside-gitdir");
      await mkdir(outside);
      await writeGitfileTarget(fixture, toBashPath(outside));
      await expectGitfileRejection(fixture, /outside the canonical worktrees directory/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("nested descendant", async () => {
    const root = await mkdtemp(join(tmpdir(), "al-lio-release-gitfile-nested-"));
    try {
      const fixture = await createReleaseGitfileFixture(root);
      const nested = join(fixture.linkedGitdir, "nested");
      await mkdir(nested);
      await writeGitfileTarget(fixture, toBashPath(nested));
      await expectGitfileRejection(fixture, /one immediate child/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("symlinked intermediate component", async () => {
    const root = await mkdtemp(join(tmpdir(), "al-lio-release-gitfile-symlink-component-"));
    try {
      const fixture = await createReleaseGitfileFixture(root);
      const worktrees = join(fixture.repository, ".git", "worktrees");
      const realWorktrees = join(fixture.repository, ".git", "worktrees-real");
      await rename(worktrees, realWorktrees);
      await symlink(realWorktrees, worktrees, process.platform === "win32" ? "junction" : "dir");
      await expectGitfileRejection(fixture, /traverses a symlink/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("release gitdir metadata must link only the canonical repository and release", async (t) => {
  await t.test("bad commondir", async () => {
    const root = await mkdtemp(join(tmpdir(), "al-lio-release-gitfile-commondir-"));
    try {
      const fixture = await createReleaseGitfileFixture(root);
      await writeFile(join(fixture.linkedGitdir, "commondir"), "../../../outside\n", "utf8");
      await expectGitfileRejection(fixture, /commondir/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("bad gitdir backpointer", async () => {
    const root = await mkdtemp(join(tmpdir(), "al-lio-release-gitfile-backpointer-"));
    try {
      const fixture = await createReleaseGitfileFixture(root);
      const wrongGitfile = join(root, "wrong-gitfile");
      await writeFile(wrongGitfile, "wrong\n", "utf8");
      await writeFile(
        join(fixture.linkedGitdir, "gitdir"),
        `${toBashPath(wrongGitfile)}\n`,
        "utf8",
      );
      await expectGitfileRejection(fixture, /backpointer does not identify/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("metadata belonging to another release", async () => {
    const root = await mkdtemp(join(tmpdir(), "al-lio-release-gitfile-other-release-"));
    try {
      const fixture = await createReleaseGitfileFixture(root);
      const otherRelease = join(root, "other-release");
      git(fixture.repository, [
        "worktree",
        "add",
        "--quiet",
        "--detach",
        otherRelease,
        fixture.commitSha,
      ]);
      const otherGitfile = await readFile(join(otherRelease, ".git"), "utf8");
      await replaceGitfile(fixture, otherGitfile);
      await expectGitfileRejection(fixture, /backpointer does not identify/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// Source-level assertion rationale: executing the real boundary proves allowed behavior, but cannot prove a forbidden `git -C` call is absent from every trusted-boundary path; this narrow source assertion enforces that negative invariant.
test("the trusted commit boundary never executes Git against release-local state", async () => {
  const source = await readFile(integrityHelperUrl, "utf8");
  const boundaryStart = source.indexOf("trusted_git() {");
  const legacyStart = source.indexOf("validate_release_worktree_integrity() {");
  const boundary = source.slice(boundaryStart, legacyStart);

  assert.ok(boundaryStart >= 0 && legacyStart > boundaryStart);
  assert.doesNotMatch(boundary, /git -C/);
  assert.match(boundary, /--git-dir="\$repository_dir\/\.git"/);
  assert.match(boundary, /\/usr\/bin\/env -i/);
  assert.match(boundary, /GIT_CONFIG_NOSYSTEM=1/);
  assert.match(boundary, /GIT_CONFIG_GLOBAL=\/dev\/null/);
  assert.match(boundary, /GIT_NO_REPLACE_OBJECTS=1/);
  assert.match(boundary, /--no-replace-objects/);
  assert.match(boundary, /LC_ALL=C/);
  assert.match(boundary, /GIT_TERMINAL_PROMPT=0/);
});
