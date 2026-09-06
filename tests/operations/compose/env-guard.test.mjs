import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const helperPath = fileURLToPath(new URL("../../../scripts/lib/compose-env-guard.sh", import.meta.url));
const bashPath = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";

const baseCompose = `services:
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

const existingApproval = "al_lio_web|AL_LIO_EXISTING_FLAG|AL_LIO_EXISTING_FLAG|false";
const secondApproval = "al_lio_web|AL_LIO_SECOND_FLAG|AL_LIO_SECOND_FLAG|false";
const composeWithTwoApprovedMappings = baseCompose.replace(
  "      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}",
  "      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}\n      AL_LIO_SECOND_FLAG: ${AL_LIO_SECOND_FLAG:-false}",
);

async function git(directory, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd: directory });
  return stdout.trim();
}

async function createFixture(currentCompose, candidateCompose, { candidateExecutable = false, candidateMode = "" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "al-lio-compose-guard-"));
  const composePath = join(root, "infra", "docker-compose.prod.yml");
  await mkdir(dirname(composePath), { recursive: true });
  await git(root, "init", "--quiet");
  await git(root, "config", "user.email", "tests@al-lio.invalid");
  await git(root, "config", "user.name", "AL-LIO tests");
  await git(root, "config", "core.autocrlf", "false");
  await writeFile(composePath, currentCompose, "utf8");
  await git(root, "add", "infra/docker-compose.prod.yml");
  await git(root, "commit", "--quiet", "-m", "current");
  const currentSha = await git(root, "rev-parse", "HEAD");

  await writeFile(composePath, candidateCompose, "utf8");
  await git(root, "add", "infra/docker-compose.prod.yml");
  if (candidateExecutable) {
    await git(root, "update-index", "--chmod=+x", "infra/docker-compose.prod.yml");
  }
  if (candidateMode) {
    const object = candidateMode === "160000"
      ? currentSha
      : await git(root, "rev-parse", ":infra/docker-compose.prod.yml");
    await git(root, "update-index", "--cacheinfo", `${candidateMode},${object},infra/docker-compose.prod.yml`);
  }
  await git(root, "commit", "--quiet", "--allow-empty", "-m", "candidate");
  const candidateSha = await git(root, "rev-parse", "HEAD");
  return { root, currentSha, candidateSha };
}

async function runGuard(
  fixture,
  currentApprovals = "# no active approvals",
  candidateApprovals = "# no active approvals",
) {
  const bash = `
set -Eeuo pipefail
source "$4"
current_approvals="$(printf '%s' "$5" | base64 -d)"
candidate_approvals="$(printf '%s' "$6" | base64 -d)"
if validate_compose_env_transition "$1" "$2" "$3" infra/docker-compose.prod.yml "$current_approvals" "$candidate_approvals"; then
  printf 'ADD:%s\\n' "\${allowed_compose_env_mappings[@]}"
  printf 'REMOVE:%s\\n' "\${allowed_compose_env_removals[@]}"
  printf 'STAGED:%s\\n' "\${staged_compose_env_removal_approvals[*]}"
  printf 'CONSUMED:%s\\n' "\${consumed_compose_env_removal_approvals[*]}"
  printf 'REVOKED:%s\\n' "\${revoked_compose_env_removal_approvals[*]}"
  exit 0
fi
printf '%s\\n' "$compose_env_guard_error" >&2
exit 1
`;
  return execFileAsync(bashPath, [
    "-c",
    bash,
    "compose-guard",
    fixture.root.replaceAll("\\", "/"),
    fixture.currentSha,
    fixture.candidateSha,
    helperPath.replaceAll("\\", "/"),
    Buffer.from(currentApprovals, "utf8").toString("base64"),
    Buffer.from(candidateApprovals, "utf8").toString("base64"),
  ]);
}

async function expectAccepted(candidateCompose, options = {}) {
  const fixture = await createFixture(options.currentCompose ?? baseCompose, candidateCompose);
  try {
    return await runGuard(fixture, options.currentApprovals, options.candidateApprovals);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function expectRejected(candidateCompose, options = {}) {
  const fixture = await createFixture(options.currentCompose ?? baseCompose, candidateCompose);
  try {
    await assert.rejects(runGuard(fixture, options.currentApprovals, options.candidateApprovals));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

test("accepts a currently permitted namespaced environment addition", async () => {
  const candidate = baseCompose.replace(
    "      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}",
    "      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}\n      AL_LIO_FUTURE_FLAG: ${AL_LIO_FUTURE_FLAG:-false}",
  );
  const { stdout } = await expectAccepted(candidate);
  assert.match(stdout, /ADD:al_lio_web:AL_LIO_FUTURE_FLAG/);
});

test("accepts an identical Compose file with no approvals", async () => {
  const { stdout } = await expectAccepted(baseCompose);
  assert.match(stdout, /^ADD:\nREMOVE:/);
});

test("accepts one exact removal approved by the current release and consumed by the candidate", async () => {
  const candidate = baseCompose.replace("      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}\n", "");
  const { stdout } = await expectAccepted(candidate, { currentApprovals: existingApproval });
  assert.match(stdout, /REMOVE:al_lio_web:AL_LIO_EXISTING_FLAG/);
});

test("accepts revoking a staged current approval without removing its mapping", async () => {
  const { stdout } = await expectAccepted(baseCompose, { currentApprovals: existingApproval });
  assert.match(stdout, new RegExp(`REVOKED:${existingApproval}`));
});

test("accepts staging one exact approval for the immediately following transition", async () => {
  const { stdout } = await expectAccepted(baseCompose, { candidateApprovals: existingApproval });
  assert.match(stdout, new RegExp(`STAGED:${existingApproval}`));
});

test("rejects a staged approval that survives into the next release", async () => {
  await expectRejected(baseCompose, {
    currentApprovals: existingApproval,
    candidateApprovals: existingApproval,
  });
});

test("rejects replacing staged approval A with candidate approval B", async () => {
  await expectRejected(composeWithTwoApprovedMappings, {
    currentCompose: composeWithTwoApprovedMappings,
    currentApprovals: existingApproval,
    candidateApprovals: secondApproval,
  });
});

test("rejects retaining A while staging B", async () => {
  await expectRejected(composeWithTwoApprovedMappings, {
    currentCompose: composeWithTwoApprovedMappings,
    currentApprovals: existingApproval,
    candidateApprovals: `${existingApproval}\n${secondApproval}`,
  });
});

test("rejects retaining only B from staged A plus B", async () => {
  await expectRejected(composeWithTwoApprovedMappings, {
    currentCompose: composeWithTwoApprovedMappings,
    currentApprovals: `${existingApproval}\n${secondApproval}`,
    candidateApprovals: secondApproval,
  });
});

test("accepts consuming A and revoking B together with an empty candidate approval file", async () => {
  const candidate = composeWithTwoApprovedMappings.replace(
    "      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}\n",
    "",
  );
  const { stdout } = await expectAccepted(candidate, {
    currentCompose: composeWithTwoApprovedMappings,
    currentApprovals: `${existingApproval}\n${secondApproval}`,
  });
  assert.match(stdout, new RegExp(`CONSUMED:${existingApproval}`));
  assert.match(stdout, new RegExp(`REVOKED:${secondApproval}`));
});

test("rejects consuming A while introducing candidate approval B", async () => {
  const candidate = composeWithTwoApprovedMappings.replace(
    "      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}\n",
    "",
  );
  await expectRejected(candidate, {
    currentCompose: composeWithTwoApprovedMappings,
    currentApprovals: existingApproval,
    candidateApprovals: secondApproval,
  });
});

test("rejects staging an approval for a mapping added by the same candidate", async () => {
  await expectRejected(composeWithTwoApprovedMappings, {
    candidateApprovals: secondApproval,
  });
});

test("rejects the same removal without an approval", async () => {
  const candidate = baseCompose.replace("      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}\n", "");
  await expectRejected(candidate);
});

test("rejects an unknown removal even when a different exact mapping is approved", async () => {
  const candidate = baseCompose.replace("      NODE_ENV: production\n", "");
  await expectRejected(candidate, { currentApprovals: existingApproval });
});

test("rejects an approval introduced only by the candidate", async () => {
  const candidate = baseCompose.replace("      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}\n", "");
  await expectRejected(candidate, { candidateApprovals: existingApproval });
});

test("rejects an approval for the same mapping under a different service", async () => {
  const candidate = baseCompose.replace("      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}\n", "");
  await expectRejected(candidate, {
    currentApprovals: "al_lio_radar|AL_LIO_EXISTING_FLAG|AL_LIO_EXISTING_FLAG|false",
  });
});

test("rejects moving an environment mapping to another service", async () => {
  const candidate = baseCompose
    .replace("      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}\n", "")
    .replace(
      "      WEB_DISCOVERY_ENABLED: ${AL_LIO_RADAR_WEB_DISCOVERY_ENABLED:-false}",
      "      WEB_DISCOVERY_ENABLED: ${AL_LIO_RADAR_WEB_DISCOVERY_ENABLED:-false}\n      AL_LIO_EXISTING_FLAG: ${AL_LIO_RADAR_EXISTING_FLAG:-false}",
    );
  await expectRejected(candidate, { currentApprovals: existingApproval });
});

test("rejects changed source variables and defaults", async () => {
  for (const replacement of [
    "      AL_LIO_EXISTING_FLAG: ${AL_LIO_RENAMED_FLAG:-false}",
    "      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-true}",
  ]) {
    await expectRejected(baseCompose.replace(
      "      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}",
      replacement,
    ), { currentApprovals: existingApproval });
  }
});

test("rejects a modification disguised as a removal plus an addition", async () => {
  const candidate = baseCompose.replace(
    "      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}",
    "      AL_LIO_REPLACEMENT_FLAG: ${AL_LIO_REPLACEMENT_FLAG:-false}",
  );
  await expectRejected(candidate, { currentApprovals: existingApproval });
});

test("rejects a consumed removal that leaves any reusable candidate approval", async () => {
  const currentCompose = baseCompose.replace(
    "      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}",
    "      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}\n      AL_LIO_SECOND_FLAG: ${AL_LIO_SECOND_FLAG:-false}",
  );
  const candidate = currentCompose.replace("      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}\n", "");
  await expectRejected(candidate, {
    currentCompose,
    currentApprovals: existingApproval,
    candidateApprovals: "al_lio_web|AL_LIO_SECOND_FLAG|AL_LIO_SECOND_FLAG|false",
  });
});

test("rejects structural Compose changes", async () => {
  const candidate = baseCompose.replace(
    "    environment:\n      NODE_ENV: production",
    "    ports:\n      - \"3000:3000\"\n    environment:\n      NODE_ENV: production",
  );
  await expectRejected(candidate);
});

test("rejects a Compose mode-only change from 100644 to 100755", async () => {
  const fixture = await createFixture(baseCompose, baseCompose, { candidateExecutable: true });
  try {
    await assert.rejects(runGuard(fixture));
    assert.match(await git(fixture.root, "diff", "--summary", fixture.currentSha, fixture.candidateSha), /mode change 100644 => 100755/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects changing Compose from a regular blob to a symlink", async () => {
  const fixture = await createFixture(baseCompose, baseCompose, { candidateMode: "120000" });
  try {
    await assert.rejects(runGuard(fixture));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects changing Compose to an unexpected Git tree type", async () => {
  const fixture = await createFixture(baseCompose, baseCompose, { candidateMode: "160000" });
  try {
    await assert.rejects(runGuard(fixture));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects an LF-to-CRLF-only Compose rewrite", async () => {
  await expectRejected(baseCompose.replaceAll("\n", "\r\n"));
});

test("rejects duplicate environment keys", async () => {
  const candidate = baseCompose.replace(
    "      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}",
    "      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}\n      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}",
  );
  await expectRejected(candidate);
});

test("rejects an unexplained environment reordering", async () => {
  const candidate = baseCompose.replace(
    "      NODE_ENV: production\n      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}",
    "      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}\n      NODE_ENV: production",
  );
  await expectRejected(candidate);
});

test("rejects an approved removal mixed with a structural change", async () => {
  const candidate = baseCompose
    .replace("      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}\n", "")
    .replace("    image: al-lio-web:${AL_LIO_IMAGE_TAG:-local}", "    image: al-lio-web:unexpected");
  await expectRejected(candidate, { currentApprovals: existingApproval });
});

test("preserves the dc6607e to bea09a3 incident class as an exceptional rejection", async () => {
  const providerMappings = [
    "      AL_LIO_DEMO_ACCESS_ENABLED: ${AL_LIO_DEMO_ACCESS_ENABLED:-false}",
    "      INFOJOBS_CLIENT_ID: ${INFOJOBS_CLIENT_ID:-}",
    "      INFOJOBS_CLIENT_SECRET: ${INFOJOBS_CLIENT_SECRET:-}",
    "      ADZUNA_APP_ID: ${ADZUNA_APP_ID:-}",
    "      ADZUNA_APP_KEY: ${ADZUNA_APP_KEY:-}",
    "      JOOBLE_API_KEY: ${JOOBLE_API_KEY:-}",
  ];
  const currentCompose = baseCompose.replace(
    "      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}",
    ["      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}", ...providerMappings].join("\n"),
  );
  const candidate = currentCompose.replace(providerMappings.map((line) => `${line}\n`).join(""), "");
  await expectRejected(candidate, { currentCompose });
});

test("candidate approval data cannot retroactively authorize the historical six removals", async () => {
  const providerMappings = [
    ["AL_LIO_DEMO_ACCESS_ENABLED", "false"],
    ["INFOJOBS_CLIENT_ID", ""],
    ["INFOJOBS_CLIENT_SECRET", ""],
    ["ADZUNA_APP_ID", ""],
    ["ADZUNA_APP_KEY", ""],
    ["JOOBLE_API_KEY", ""],
  ];
  const currentCompose = baseCompose.replace(
    "      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}",
    [
      "      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}",
      ...providerMappings.map(([key, defaultValue]) => `      ${key}: \${${key}:-${defaultValue}}`),
    ].join("\n"),
  );
  const candidate = providerMappings.reduce(
    (compose, [key, defaultValue]) => compose.replace(`      ${key}: \${${key}:-${defaultValue}}\n`, ""),
    currentCompose,
  );
  const candidateApprovals = providerMappings
    .map(([key, defaultValue]) => `al_lio_web|${key}|${key}|${defaultValue}`)
    .join("\n");

  await expectRejected(candidate, { currentCompose, candidateApprovals });
});

test("keeps the previous Radar and multi-service namespaced additions accepted", async () => {
  const candidate = baseCompose
    .replace(
      "      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}",
      "      AL_LIO_EXISTING_FLAG: ${AL_LIO_EXISTING_FLAG:-false}\n      AL_LIO_FUTURE_FLAG: ${AL_LIO_FUTURE_FLAG:-false}",
    )
    .replace(
      "      WEB_DISCOVERY_ENABLED: ${AL_LIO_RADAR_WEB_DISCOVERY_ENABLED:-false}",
      "      WEB_DISCOVERY_ENABLED: ${AL_LIO_RADAR_WEB_DISCOVERY_ENABLED:-false}\n      DISCOVERY_CADENCE_MINUTES: ${AL_LIO_RADAR_DISCOVERY_CADENCE_MINUTES:-240}",
    );
  const { stdout } = await expectAccepted(candidate);
  assert.match(stdout, /ADD:al_lio_web:AL_LIO_FUTURE_FLAG/);
  assert.match(stdout, /ADD:al_lio_radar:DISCOVERY_CADENCE_MINUTES/);
});

test("keeps the previous learning-delivery Radar additions accepted", async () => {
  const candidate = baseCompose.replace(
    "      WEB_DISCOVERY_ENABLED: ${AL_LIO_RADAR_WEB_DISCOVERY_ENABLED:-false}",
    [
      "      WEB_DISCOVERY_ENABLED: ${AL_LIO_RADAR_WEB_DISCOVERY_ENABLED:-false}",
      "      LEARNING_DELIVERY_ENABLED: ${AL_LIO_RADAR_LEARNING_DELIVERY_ENABLED:-false}",
      "      YOUTUBE_API_KEY: ${AL_LIO_RADAR_YOUTUBE_API_KEY:-}",
    ].join("\n"),
  );
  const { stdout } = await expectAccepted(candidate);
  assert.match(stdout, /ADD:al_lio_radar:LEARNING_DELIVERY_ENABLED/);
  assert.match(stdout, /ADD:al_lio_radar:YOUTUBE_API_KEY/);
});

test("keeps rejecting unsafe Radar namespaces, source variables and defaults", async () => {
  const variants = [
    "      NODE_OPTIONS: ${AL_LIO_RADAR_NODE_OPTIONS:---inspect}",
    "      DISCOVERY_CADENCE_MINUTES: ${UNSCOPED_DISCOVERY_CADENCE_MINUTES:-240}",
    "      DISCOVERY_CADENCE_MINUTES: ${AL_LIO_RADAR_DISCOVERY_CADENCE_MINUTES:-$(id)}",
  ];
  for (const mapping of variants) {
    const candidate = baseCompose.replace(
      "      WEB_DISCOVERY_ENABLED: ${AL_LIO_RADAR_WEB_DISCOVERY_ENABLED:-false}",
      "      WEB_DISCOVERY_ENABLED: ${AL_LIO_RADAR_WEB_DISCOVERY_ENABLED:-false}\n" + mapping,
    );
    await expectRejected(candidate);
  }
});

test("keeps rejecting valid-looking mappings outside approved service blocks", async () => {
  await expectRejected(baseCompose + "  unrelated_service:\n    environment:\n      AL_LIO_FUTURE_FLAG: ${AL_LIO_FUTURE_FLAG:-false}\n");
});

test("keeps rejecting every previous material Compose structure change", async () => {
  const variants = [
    baseCompose.replace("    image: al-lio-web:${AL_LIO_IMAGE_TAG:-local}", "    image: al-lio-web:unexpected"),
    baseCompose.replace("    image: al-lio-web:${AL_LIO_IMAGE_TAG:-local}", "    build: .\n    image: al-lio-web:${AL_LIO_IMAGE_TAG:-local}"),
    baseCompose.replace("    environment:\n      NODE_ENV: production", "    ports:\n      - \"3000:3000\"\n    environment:\n      NODE_ENV: production"),
    baseCompose.replace("    environment:\n      NODE_ENV: production", "    expose:\n      - \"3000\"\n    environment:\n      NODE_ENV: production"),
    baseCompose.replace("    environment:\n      NODE_ENV: production", "    volumes:\n      - data:/app/data\n    environment:\n      NODE_ENV: production"),
    baseCompose.replace("    environment:\n      NODE_ENV: production", "    command: [\"sh\", \"-c\", \"id\"]\n    environment:\n      NODE_ENV: production"),
    baseCompose.replace("    environment:\n      NODE_ENV: production", "    networks:\n      - unexpected\n    environment:\n      NODE_ENV: production"),
    baseCompose.replace("    environment:\n      NODE_ENV: production", "    depends_on:\n      al_lio_radar:\n        condition: service_started\n    environment:\n      NODE_ENV: production"),
    baseCompose.replace("    environment:\n      NODE_ENV: production", "    healthcheck:\n      test: [\"CMD\", \"false\"]\n    environment:\n      NODE_ENV: production"),
    baseCompose.replace("    environment:\n      NODE_ENV: production", "    user: root\n    environment:\n      NODE_ENV: production"),
    baseCompose.replace("    environment:\n      NODE_ENV: production", "    security_opt:\n      - no-new-privileges:false\n    environment:\n      NODE_ENV: production"),
    baseCompose + "  inserted_service:\n    image: busybox:latest\n",
    baseCompose.split("  al_lio_radar:")[0],
    baseCompose + "networks:\n  unexpected: {}\n",
  ];
  for (const candidate of variants) await expectRejected(candidate);
});
