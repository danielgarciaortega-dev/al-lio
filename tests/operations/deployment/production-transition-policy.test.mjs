import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const validatorPath = fileURLToPath(new URL("../../../scripts/validate-production-transition.sh", import.meta.url));
const policyPath = fileURLToPath(new URL("../../../scripts/lib/production-transition-policy.sh", import.meta.url));
const bashPath = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
const approvalPath = "scripts/config/production-compose-env-removals.allowlist";
const secretSentinel = "SUPER_SECRET_SENTINEL_9f0e7d";

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
  await writeFile(target, contents, typeof contents === "string" ? "utf8" : undefined);
}

async function createFixture({ composeContent = compose, approvalContent = "# no approvals\n" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "al-lio-production-transition-"));
  await git(root, "init", "--quiet");
  await git(root, "config", "user.email", "tests@al-lio.invalid");
  await git(root, "config", "user.name", "AL-LIO tests");
  await git(root, "config", "core.autocrlf", "false");
  await write(root, "infra/docker-compose.prod.yml", composeContent);
  await write(root, "infra/Dockerfile", "FROM scratch\n");
  await write(root, "data/learning-competencies.json", "[]\n");
  await write(root, "scripts/import-learning-competencies.mjs", "export {};\n");
  await write(root, ".gitattributes", "*.sh text eol=lf\n");
  await write(root, approvalPath, approvalContent);
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

function runPolicy(fixture, currentSha, candidateSha, mainRef = "main", extraEnv = {}) {
  return execFileAsync(bashPath, [
    validatorPath.replaceAll("\\", "/"),
    currentSha,
    candidateSha,
    mainRef,
  ], {
    env: {
      ...process.env,
      AL_LIO_REPOSITORY_DIR: fixture.root.replaceAll("\\", "/"),
      ...extraEnv,
    },
  });
}

function runPolicyWithAuditSerialization(fixture, currentSha, candidateSha, mainRef = "main") {
  const bash = `
set -Eeuo pipefail
source "$4"
if ! validate_production_transition "$1" "$2" "$3" "$5"; then
  printf 'ERROR: %s\\n' "$production_transition_error" >&2
  exit 1
fi
print_production_transition_summary "$2" "$3"
printf 'RELEASE_RECORD_STAGED=%s\\n' "$(join_approval_audit_records "\${production_transition_staged_compose_removal_approvals[@]}")"
printf 'RELEASE_RECORD_CONSUMED=%s\\n' "$(join_approval_audit_records "\${production_transition_consumed_compose_removal_approvals[@]}")"
printf 'RELEASE_RECORD_REVOKED=%s\\n' "$(join_approval_audit_records "\${production_transition_revoked_compose_removal_approvals[@]}")"
printf 'RELEASE_RECORD_COMPOSE_REMOVALS=%s\\n' "\${production_transition_allowed_compose_removals[*]:-none}"
`;
  return execFileAsync(bashPath, [
    "-c",
    bash,
    "production-policy-audit",
    fixture.root.replaceAll("\\", "/"),
    currentSha,
    candidateSha,
    policyPath.replaceAll("\\", "/"),
    mainRef,
  ]);
}

async function withFixture(work, options = {}) {
  const fixture = await createFixture(options);
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
  ".gitattributes",
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
        await write(
          root,
          protectedPath,
          protectedPath === ".gitattributes"
            ? "*.sh text eol=crlf\n"
            : `candidate changed ${protectedPath}\n`,
        );
      });
      await assert.rejects(
        runPolicy(fixture, fixture.currentSha, candidateSha),
        /protected production control-plane/,
      );
    });
  });
}

for (const nestedAttributesPath of [
  "scripts/.gitattributes",
  "scripts/lib/.gitattributes",
]) {
  test(`the shared policy rejects adding nested attributes: ${nestedAttributesPath}`, async () => {
    await withFixture(async (fixture) => {
      const candidateSha = await commitCandidate(fixture, async (root) => {
        await write(root, nestedAttributesPath, "*.sh text eol=crlf\n");
      });
      await assert.rejects(
        runPolicy(fixture, fixture.currentSha, candidateSha),
        /protected production control-plane/,
      );
    });
  });
}

test("the shared policy rejects deleting root attributes", async () => {
  await withFixture(async (fixture) => {
    const candidateSha = await commitCandidate(fixture, async (root) => {
      await rm(join(root, ".gitattributes"));
    });
    await assert.rejects(
      runPolicy(fixture, fixture.currentSha, candidateSha),
      /protected production control-plane/,
    );
  });
});

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

test("the shared policy accepts and deliberately normalizes CRLF approval text", async () => {
  await withFixture(async (fixture) => {
    const candidateSha = await commitCandidate(fixture, async (root) => {
      await write(root, approvalPath, Buffer.from(
        "# reviewed with CRLF\r\nal_lio_web|AL_LIO_EXISTING_FLAG|AL_LIO_EXISTING_FLAG|false\r\n",
        "ascii",
      ));
    });
    const { stdout, stderr } = await runPolicy(fixture, fixture.currentSha, candidateSha);
    assert.match(stdout, /state=staged/);
    assert.equal(stderr, "");
  });
});

test("the shared policy rejects a NUL byte before Bash parsing", async () => {
  await withFixture(async (fixture) => {
    const candidateSha = await commitCandidate(fixture, async (root) => {
      await write(root, approvalPath, Buffer.from("# comment\0hidden\n", "binary"));
    });
    await assert.rejects(runPolicy(fixture, fixture.currentSha, candidateSha), /forbidden NUL byte/);
  });
});

test("the shared policy rejects a NUL embedded inside exact_default before normalization", async () => {
  await withFixture(async (fixture) => {
    const candidateSha = await commitCandidate(fixture, async (root) => {
      await write(root, approvalPath, Buffer.concat([
        Buffer.from("al_lio_web|AL_LIO_EXISTING_FLAG|AL_LIO_EXISTING_FLAG|fa", "ascii"),
        Buffer.from([0]),
        Buffer.from("lse\n", "ascii"),
      ]));
    });
    await assert.rejects(runPolicy(fixture, fixture.currentSha, candidateSha), /forbidden NUL byte/);
  });
});

for (const [name, contents, expectedError] of [
  ["a forbidden control byte", Buffer.from([35, 32, 1, 10]), /forbidden control, binary, or non-ASCII byte/],
  ["a DEL byte", Buffer.from([35, 32, 127, 10]), /forbidden control, binary, or non-ASCII byte/],
  ["a non-ASCII byte", Buffer.from([35, 32, 255, 10]), /forbidden control, binary, or non-ASCII byte/],
  ["a lone carriage return", Buffer.from("# first\r# second\n", "ascii"), /not part of CRLF/],
  ["a terminal lone carriage return", Buffer.from("# terminal\r", "ascii"), /ends with a carriage return that is not part of CRLF/],
]) {
  test(`the shared policy rejects ${name}`, async () => {
    await withFixture(async (fixture) => {
      const candidateSha = await commitCandidate(fixture, async (root) => {
        await write(root, approvalPath, contents);
      });
      await assert.rejects(runPolicy(fixture, fixture.currentSha, candidateSha), expectedError);
    });
  });
}

test("the shared policy rejects approval blobs above the bounded text limit", async () => {
  await withFixture(async (fixture) => {
    const candidateSha = await commitCandidate(fixture, async (root) => {
      await write(root, approvalPath, Buffer.alloc(65537, 35));
    });
    await assert.rejects(runPolicy(fixture, fixture.currentSha, candidateSha), /65536-byte limit/);
  });
});

test("the shared policy accepts an otherwise valid approval blob at the exact byte limit", async () => {
  await withFixture(async (fixture) => {
    const candidateSha = await commitCandidate(fixture, async (root) => {
      await write(root, approvalPath, Buffer.from(`#${"a".repeat(65534)}\n`, "ascii"));
    });
    const { stderr } = await runPolicy(fixture, fixture.currentSha, candidateSha);
    assert.equal(stderr, "");
  });
});

test("approval validation removes private temporary files after controlled success and failure", async () => {
  await withFixture(async (fixture) => {
    const temporaryDirectory = join(fixture.root, "approval-temporary-files");
    await mkdir(temporaryDirectory);
    const candidateSha = await commitCandidate(fixture, async () => {});
    await runPolicy(fixture, fixture.currentSha, candidateSha, "main", {
      TMPDIR: temporaryDirectory.replaceAll("\\", "/"),
    });
    assert.deepEqual(await readdir(temporaryDirectory), []);

    const rejectedSha = await commitCandidate(fixture, async (root) => {
      await write(root, approvalPath, Buffer.from("# invalid\0approval\n", "binary"));
    });
    await assert.rejects(runPolicy(fixture, candidateSha, rejectedSha, "main", {
      TMPDIR: temporaryDirectory.replaceAll("\\", "/"),
    }));
    assert.deepEqual(await readdir(temporaryDirectory), []);
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
    assert.match(stdout, /service=al_lio_web destination=AL_LIO_EXISTING_FLAG source=AL_LIO_EXISTING_FLAG state=staged/);
    assert.doesNotMatch(stdout, /default=/);
    assert.doesNotMatch(stdout, /\bfalse\b/);
    assert.doesNotMatch(stdout, /SECRET|DATABASE_URL|SESSION_SECRET/);
  });
});

test("successful staged, consumed and revoked output never exposes exact_default", async () => {
  const sentinelCompose = compose.replace(
    "      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}",
    `      AL_LIO_EXISTING_FLAG: \${AL_LIO_EXISTING_FLAG:-${secretSentinel}}`,
  );
  const sentinelApproval = `al_lio_web|AL_LIO_EXISTING_FLAG|AL_LIO_EXISTING_FLAG|${secretSentinel}`;

  await withFixture(async (fixture) => {
    const stagedSha = await commitCandidate(fixture, async (root) => {
      await write(root, approvalPath, `${sentinelApproval}\n`);
    }, "stage sentinel approval");
    const accepted = await runPolicyWithAuditSerialization(fixture, fixture.currentSha, stagedSha);
    assert.doesNotMatch(accepted.stdout, new RegExp(secretSentinel));
    assert.doesNotMatch(accepted.stderr, new RegExp(secretSentinel));
    assert.equal(accepted.stderr, "");
    assert.match(accepted.stdout, /service=al_lio_web destination=AL_LIO_EXISTING_FLAG source=AL_LIO_EXISTING_FLAG state=staged/);
    assert.match(accepted.stdout, /RELEASE_RECORD_STAGED=al_lio_web:AL_LIO_EXISTING_FLAG:AL_LIO_EXISTING_FLAG/);
    assert.match(accepted.stdout, /RELEASE_RECORD_CONSUMED=\n/);
    assert.match(accepted.stdout, /RELEASE_RECORD_REVOKED=\n/);
    assert.match(accepted.stdout, /RELEASE_RECORD_COMPOSE_REMOVALS=none/);
  }, { composeContent: sentinelCompose });

  await withFixture(async (fixture) => {
    const consumedSha = await commitCandidate(fixture, async (root) => {
      await write(
        root,
        "infra/docker-compose.prod.yml",
        sentinelCompose.replace(`      AL_LIO_EXISTING_FLAG: \${AL_LIO_EXISTING_FLAG:-${secretSentinel}}\n`, ""),
      );
      await write(root, approvalPath, "# consumed\n");
    }, "consume sentinel approval");
    const accepted = await runPolicyWithAuditSerialization(fixture, fixture.currentSha, consumedSha);
    assert.doesNotMatch(accepted.stdout, new RegExp(secretSentinel));
    assert.doesNotMatch(accepted.stderr, new RegExp(secretSentinel));
    assert.equal(accepted.stderr, "");
    assert.match(accepted.stdout, /service=al_lio_web destination=AL_LIO_EXISTING_FLAG source=AL_LIO_EXISTING_FLAG state=consumed/);
    assert.match(accepted.stdout, /Consumed service environment removal approvals:\n  - al_lio_web:AL_LIO_EXISTING_FLAG/);
    assert.match(accepted.stdout, /RELEASE_RECORD_CONSUMED=al_lio_web:AL_LIO_EXISTING_FLAG:AL_LIO_EXISTING_FLAG/);
    assert.match(accepted.stdout, /RELEASE_RECORD_COMPOSE_REMOVALS=al_lio_web:AL_LIO_EXISTING_FLAG/);
  }, { composeContent: sentinelCompose, approvalContent: `${sentinelApproval}\n` });

  await withFixture(async (fixture) => {
    const revokedSha = await commitCandidate(fixture, async (root) => {
      await write(root, approvalPath, "# revoked\n");
    }, "revoke sentinel approval");
    const accepted = await runPolicyWithAuditSerialization(fixture, fixture.currentSha, revokedSha);
    assert.doesNotMatch(accepted.stdout, new RegExp(secretSentinel));
    assert.doesNotMatch(accepted.stderr, new RegExp(secretSentinel));
    assert.equal(accepted.stderr, "");
    assert.match(accepted.stdout, /service=al_lio_web destination=AL_LIO_EXISTING_FLAG source=AL_LIO_EXISTING_FLAG state=revoked/);
    assert.match(accepted.stdout, /RELEASE_RECORD_REVOKED=al_lio_web:AL_LIO_EXISTING_FLAG:AL_LIO_EXISTING_FLAG/);
    assert.match(accepted.stdout, /RELEASE_RECORD_COMPOSE_REMOVALS=none/);
  }, { composeContent: sentinelCompose, approvalContent: `${sentinelApproval}\n` });
});

test("candidate self-approval rejects without leaking exact_default", async () => {
  const sentinelCompose = compose.replace(
    "      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}",
    `      AL_LIO_EXISTING_FLAG: \${AL_LIO_EXISTING_FLAG:-${secretSentinel}}`,
  );
  const sentinelApproval = `al_lio_web|AL_LIO_EXISTING_FLAG|AL_LIO_EXISTING_FLAG|${secretSentinel}`;

  await withFixture(async (fixture) => {
    const rejectedSha = await commitCandidate(fixture, async (root) => {
      await write(
        root,
        "infra/docker-compose.prod.yml",
        sentinelCompose.replace(`      AL_LIO_EXISTING_FLAG: \${AL_LIO_EXISTING_FLAG:-${secretSentinel}}\n`, ""),
      );
      await write(root, approvalPath, `${sentinelApproval}\n`);
    }, "attempt candidate self-approval");
    await assert.rejects(
      runPolicy(fixture, fixture.currentSha, rejectedSha),
      (error) => {
        assert.doesNotMatch(error.stdout ?? "", new RegExp(secretSentinel));
        assert.doesNotMatch(error.stderr ?? "", new RegExp(secretSentinel));
        assert.match(error.stderr ?? "", /service=al_lio_web/);
        assert.match(error.stderr ?? "", /destination=AL_LIO_EXISTING_FLAG/);
        assert.match(error.stderr ?? "", /source=AL_LIO_EXISTING_FLAG/);
        return true;
      },
    );
  }, { composeContent: sentinelCompose });
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
