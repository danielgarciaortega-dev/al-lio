import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const validatorPath = fileURLToPath(new URL("../../../scripts/validate-production-transition.sh", import.meta.url));
const bashPath = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";

const compose = `services:
  al_lio_web:
    image: al-lio-web:\${AL_LIO_IMAGE_TAG:-local}
    environment:
      NODE_ENV: production
      AL_LIO_EXISTING_FLAG: \${AL_LIO_EXISTING_FLAG:-false}
  al_lio_radar:
    image: al-lio-radar:\${AL_LIO_RADAR_IMAGE_TAG:-local}
    environment:
      NODE_ENV: production
      WEB_DISCOVERY_ENABLED: \${AL_LIO_RADAR_WEB_DISCOVERY_ENABLED:-false}
`;

async function git(directory, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd: directory });
  return stdout.trim();
}

async function write(root, path, contents) {
  const target = join(root, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "al-lio-production-transition-"));
  await git(root, "init", "--quiet");
  await git(root, "config", "user.email", "tests@al-lio.invalid");
  await git(root, "config", "user.name", "AL-LIO tests");
  await git(root, "config", "core.autocrlf", "false");
  await write(root, "infra/docker-compose.prod.yml", compose);
  await write(root, "infra/Dockerfile", "FROM scratch\n");
  await write(root, "data/learning-competencies.json", "[]\n");
  await write(root, "scripts/import-learning-competencies.mjs", "export {};\n");
  await write(root, "scripts/config/production-compose-env-removals.allowlist", "# no approvals\n");
  await write(root, "infra/postgres/migrations/0002_existing.sql", "CREATE TABLE existing_record (id bigint);\n");
  for (const path of [
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
    "scripts/postgres/migrate.mjs",
    "scripts/postgres/backup-production.sh",
    "infra/postgres/schema.sql",
    "infra/postgres/baseline.sha256",
  ]) {
    await write(root, path, `trusted control-plane fixture: ${path}\n`);
  }
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "current");
  const currentSha = await git(root, "rev-parse", "HEAD");
  await git(root, "branch", "main", currentSha);
  return { root, currentSha };
}

async function commitCandidate(fixture, mutate, message = "candidate") {
  await mutate(fixture.root);
  await git(fixture.root, "add", ".");
  await git(fixture.root, "commit", "--quiet", "--allow-empty", "-m", message);
  const candidateSha = await git(fixture.root, "rev-parse", "HEAD");
  await git(fixture.root, "branch", "--force", "main", candidateSha);
  return candidateSha;
}

async function commitCandidateIndex(fixture, mutateIndex, message) {
  await mutateIndex(fixture.root);
  await git(fixture.root, "commit", "--quiet", "--allow-empty", "-m", message);
  const candidateSha = await git(fixture.root, "rev-parse", "HEAD");
  await git(fixture.root, "branch", "--force", "main", candidateSha);
  return candidateSha;
}

function runPolicy(fixture, currentSha, candidateSha, mainRef = "main") {
  return execFileAsync(bashPath, [
    validatorPath.replaceAll("\\", "/"),
    currentSha,
    candidateSha,
    mainRef,
  ], {
    env: { ...process.env, AL_LIO_REPOSITORY_DIR: fixture.root.replaceAll("\\", "/") },
  });
}

async function withFixture(work) {
  const fixture = await createFixture();
  try {
    await work(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

test("the shared policy accepts a forward main transition with an additive migration", async () => {
  await withFixture(async (fixture) => {
    const candidateSha = await commitCandidate(fixture, async (root) => {
      await write(root, "infra/postgres/migrations/0003_additive.sql", "CREATE TABLE additive_record (id bigint);\n");
    });
    const { stdout } = await runPolicy(fixture, fixture.currentSha, candidateSha);
    assert.match(stdout, /Current release:/);
    assert.match(stdout, /0003_additive\.sql/);
  });
});

for (const protectedPath of [
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
  "scripts/postgres/migrate.mjs",
  "scripts/postgres/backup-production.sh",
  "infra/postgres/schema.sql",
  "infra/postgres/baseline.sha256",
]) {
  test(`the shared policy rejects protected control-plane change: ${protectedPath}`, async () => {
    await withFixture(async (fixture) => {
      const candidateSha = await commitCandidate(fixture, async (root) => {
        await write(root, protectedPath, `candidate changed ${protectedPath}\n`);
      });
      await assert.rejects(
        runPolicy(fixture, fixture.currentSha, candidateSha),
        /protected production control-plane/,
      );
    });
  });
}

test("the protected control-plane rule permits an ordinary application change", async () => {
  await withFixture(async (fixture) => {
    const candidateSha = await commitCandidate(fixture, async (root) => {
      await write(root, "src/app/ordinary-change.ts", "export const ordinary = true;\n");
    });
    const { stdout } = await runPolicy(fixture, fixture.currentSha, candidateSha);
    assert.match(stdout, /New migrations: none/);
  });
});

test("the shared policy rejects an executable new migration", async () => {
  await withFixture(async (fixture) => {
    const path = "infra/postgres/migrations/0003_executable.sql";
    const candidateSha = await commitCandidateIndex(fixture, async (root) => {
      await write(root, path, "CREATE TABLE executable_record (id bigint);\n");
      await git(root, "add", path);
      await git(root, "update-index", "--chmod=+x", path);
    }, "executable migration");
    await assert.rejects(runPolicy(fixture, fixture.currentSha, candidateSha), /regular non-executable 100644 blob/);
  });
});

test("the shared policy rejects a symlink new migration", async () => {
  await withFixture(async (fixture) => {
    const path = "infra/postgres/migrations/0003_symlink.sql";
    const candidateSha = await commitCandidateIndex(fixture, async (root) => {
      await write(root, path, "harmless-target.sql\n");
      await git(root, "add", path);
      const blob = await git(root, "rev-parse", `:${path}`);
      await git(root, "update-index", "--cacheinfo", `120000,${blob},${path}`);
    }, "symlink migration");
    await assert.rejects(runPolicy(fixture, fixture.currentSha, candidateSha), /regular non-executable 100644 blob/);
  });
});

test("the shared policy rejects a gitlink new migration", async () => {
  await withFixture(async (fixture) => {
    const path = "infra/postgres/migrations/0003_gitlink.sql";
    const candidateSha = await commitCandidateIndex(fixture, async (root) => {
      await git(root, "update-index", "--add", "--cacheinfo", `160000,${fixture.currentSha},${path}`);
    }, "gitlink migration");
    await assert.rejects(runPolicy(fixture, fixture.currentSha, candidateSha), /regular non-executable 100644 blob/);
  });
});

test("the shared policy rejects a new migration outside the runtime filename contract", async () => {
  await withFixture(async (fixture) => {
    const candidateSha = await commitCandidate(fixture, async (root) => {
      await write(root, "infra/postgres/migrations/0003-invalid.sql", "CREATE TABLE invalid_name (id bigint);\n");
    });
    await assert.rejects(runPolicy(fixture, fixture.currentSha, candidateSha), /Unexpected migration file/);
  });
});

test("the shared policy accepts the approval file only as a regular 100644 blob", async () => {
  await withFixture(async (fixture) => {
    const candidateSha = await commitCandidate(fixture, async () => {});
    const { stdout } = await runPolicy(fixture, fixture.currentSha, candidateSha);
    assert.match(stdout, /New migrations: none/);
    assert.match(
      await git(fixture.root, "ls-tree", candidateSha, "--", "scripts/config/production-compose-env-removals.allowlist"),
      /^100644 blob /,
    );
  });
});

test("the shared policy reports every staged approval without environment values", async () => {
  await withFixture(async (fixture) => {
    const candidateSha = await commitCandidate(fixture, async (root) => {
      await write(
        root,
        "scripts/config/production-compose-env-removals.allowlist",
        "al_lio_web|AL_LIO_EXISTING_FLAG|AL_LIO_EXISTING_FLAG|false\n",
      );
    });
    const { stdout } = await runPolicy(fixture, fixture.currentSha, candidateSha);
    assert.match(stdout, /STAGED PRODUCTION COMPOSE REMOVAL APPROVALS:/);
    assert.match(stdout, /service=al_lio_web destination=AL_LIO_EXISTING_FLAG source=AL_LIO_EXISTING_FLAG default=false/);
    assert.doesNotMatch(stdout, /SECRET|DATABASE_URL|SESSION_SECRET/);
  });
});

test("the shared policy rejects an executable approval file", async () => {
  await withFixture(async (fixture) => {
    const candidateSha = await commitCandidateIndex(fixture, async (root) => {
      await git(root, "update-index", "--chmod=+x", "scripts/config/production-compose-env-removals.allowlist");
    }, "executable approval data");
    await assert.rejects(runPolicy(fixture, fixture.currentSha, candidateSha), /regular non-executable 100644 blob/);
  });
});

test("the shared policy rejects an approval-file symlink", async () => {
  await withFixture(async (fixture) => {
    const candidateSha = await commitCandidateIndex(fixture, async (root) => {
      const blob = await git(root, "rev-parse", ":scripts/config/production-compose-env-removals.allowlist");
      await git(root, "update-index", "--cacheinfo", `120000,${blob},scripts/config/production-compose-env-removals.allowlist`);
    }, "symlink approval data");
    await assert.rejects(runPolicy(fixture, fixture.currentSha, candidateSha), /regular non-executable 100644 blob/);
  });
});

test("the shared policy rejects an unexpected approval-file Git tree type", async () => {
  await withFixture(async (fixture) => {
    const candidateSha = await commitCandidateIndex(fixture, async (root) => {
      await git(root, "update-index", "--cacheinfo", `160000,${fixture.currentSha},scripts/config/production-compose-env-removals.allowlist`);
    }, "gitlink approval data");
    await assert.rejects(runPolicy(fixture, fixture.currentSha, candidateSha), /regular non-executable 100644 blob/);
  });
});

test("the shared policy rejects a candidate outside main", async () => {
  await withFixture(async (fixture) => {
    const candidateSha = await commitCandidate(fixture, async (root) => {
      await write(root, "README.md", "candidate\n");
    });
    await git(fixture.root, "branch", "--force", "main", fixture.currentSha);
    await assert.rejects(runPolicy(fixture, fixture.currentSha, candidateSha));
  });
});

test("the shared policy rejects a downgrade or divergent transition", async () => {
  await withFixture(async (fixture) => {
    const currentSha = await commitCandidate(fixture, async (root) => {
      await write(root, "README.md", "new current\n");
    }, "new current");
    await git(fixture.root, "branch", "--force", "main", fixture.currentSha);
    await assert.rejects(runPolicy(fixture, currentSha, fixture.currentSha));
  });
});

test("the shared policy rejects blocked infrastructure changes", async () => {
  await withFixture(async (fixture) => {
    const candidateSha = await commitCandidate(fixture, async (root) => {
      await write(root, "infra/Dockerfile", "FROM busybox\n");
    });
    await assert.rejects(runPolicy(fixture, fixture.currentSha, candidateSha));
  });
});

test("the shared policy rejects modifications to existing migration history", async () => {
  await withFixture(async (fixture) => {
    const candidateSha = await commitCandidate(fixture, async (root) => {
      await write(root, "infra/postgres/migrations/0002_existing.sql", "CREATE TABLE changed_record (id bigint);\n");
    });
    await assert.rejects(runPolicy(fixture, fixture.currentSha, candidateSha));
  });
});

test("the shared policy rejects a destructive new migration", async () => {
  await withFixture(async (fixture) => {
    const candidateSha = await commitCandidate(fixture, async (root) => {
      await write(root, "infra/postgres/migrations/0003_drop.sql", "DROP TABLE existing_record;\n");
    });
    await assert.rejects(runPolicy(fixture, fixture.currentSha, candidateSha));
  });
});

test("the shared policy delegates structural Compose rejection to the same guard", async () => {
  await withFixture(async (fixture) => {
    const candidateSha = await commitCandidate(fixture, async (root) => {
      await write(root, "infra/docker-compose.prod.yml", compose.replace(
        "    environment:\n      NODE_ENV: production",
        "    ports:\n      - \"3000:3000\"\n    environment:\n      NODE_ENV: production",
      ));
    });
    await assert.rejects(runPolicy(fixture, fixture.currentSha, candidateSha));
  });
});
