# Scripts

Operational Node and shell scripts. Every one is invoked through an `npm run`
alias defined in `package.json` — run them that way, not directly, so the
project root and env loading are consistent.

Import scripts need a reachable PostgreSQL (`DATABASE_URL` / migration URL).
Validation scripts are static: they read repository files only and never
connect to a database or to production.

## Repository hygiene

| Script | npm alias | Purpose |
|---|---|---|
| `check-unused-code.mjs` | `audit:unused` | Compare Knip's exact findings with the reviewed baseline; fail on new or stale findings. |

`npm run audit:unused:raw` prints Knip's unclassified report for
investigation. The classification workflow, the live baseline
(`docs/audits/unused-code-baseline.json`) versus the frozen snapshot
(`docs/audits/unused-code-audit.md`), and the periodic hygiene review are
defined once in [`docs/PROJECT_STRUCTURE.md`](../docs/PROJECT_STRUCTURE.md).
The audit config deliberately uses explicit Next.js, script and test entry
boundaries instead of broad ignore patterns.

## Dev and app lifecycle

| Script | npm alias | Purpose |
|---|---|---|
| `stop-project-next.mjs` | `stop:app` | Stop the local Next.js process on port 3000. |
| `clean-next.mjs` | `clean:next` | Remove the `.next` build cache. |
| `run-production.mjs` | `prod:local` | Run a production build locally. |
| `smoke-local.mjs` | `smoke` | Quick local smoke check. |
| `smoke-production.mjs` | `verify:prod`, `restart:prod` | Production build smoke check. |

## Startup validation (`verify:startup`)

| Script | npm alias | Purpose |
|---|---|---|
| `validate-runtime-env.mjs` | `validate:runtime` | Required env vars are present and internally consistent. |
| `check-project.mjs` | `check:project` | Required files exist and key structures are intact. |
| `validate-engineering-language.mjs` | `validate:engineering-language` | Code comments and `docs/**` headings stay in English. |
| `audit-schema-code.mjs` | `audit:schema` | App code matches the committed database schema. |

## Content import (needs a database)

| Script | npm alias | Source |
|---|---|---|
| `import-tech-opportunities.mjs` | `import:opportunities` | `csv/oportunidades_tech_combinado.csv` |
| `import-courses.mjs` | `import:courses` | `csv/cursos_formacion_granada_online.csv` |
| `import-hackathons.mjs` | `import:hackathons` | `csv/eventos_hackathons_actualizado.csv` |
| `import-companies.mjs` | `import:companies` | `--source` dataset under `data/companies/`, or the grandfathered DEV source `public/data/empresas_tech_granada.md` |
| `import-fp-content.mjs` | `import:fp-content` | `csv/fp-content/2026-2027/raw/*.csv` |
| `import-fp-competencies.mjs` | `import:fp-competencias` | `csv/fp-content/2026-2027/competencias/*.csv` |
| `import-fp-resource-videos.mjs` | `import:fp-resource-videos` | `csv/fp-content/2026-2027/videos/recursos_video.json` |
| `import-learning-competencies.mjs` | `import:learning-competencies` | `data/learning-competencies.json` |

`lib/company-catalogue.mjs` is a shared helper imported by the company import.

## Content validation (CI and pre-import)

| Script | npm alias |
|---|---|
| `validate-fp-content-csv.mjs` | `validate:fp-content` |
| `validate-fp-competencias-csv.mjs` | `validate:fp-competencias` |
| `validate-learning-competencies.mjs` | `validate:learning-competencies` |
| `validate-learning-sources.mjs` | `validate:learning-sources` |

## Seeds (local only)

| Script | npm alias | Purpose |
|---|---|---|
| `seed-local-review-event.mjs` | `seed:local-review-event` | One local Radar review event. |

## Deploy and release

| Script | npm alias | Purpose |
|---|---|---|
| `deploy-production.sh` | — | Runs on the VPS. Pins a reviewed forward-only `main` SHA, backs up, deploys, smoke-tests, can roll back. |
| `lib/production-transition-policy.sh` | — | Single fail-closed current-SHA to candidate-SHA policy used by deployment, tests and future CI. |
| `lib/release-worktree-integrity.sh` | — | Rejects tracked, untracked and unexpected ignored files so the Docker build context stays attributable to the candidate SHA. |
| `validate-production-transition.sh` | — | Read-only CLI for the shared transition policy. |
| `lib/compose-env-guard.sh` | — | Classifies safe namespaced additions and exact, current-release-approved consumable removals; rejects all other Compose changes. |
| `config/production-compose-env-removals.allowlist` | — | Inert exact removal approvals. Normally empty; each approval expires at the next transition through consumption or revocation. |
| `prepare-release-env.sh` | — | Copies a private release `.env` and injects the exact image and public release SHA. |
| `github-actions-deploy-entrypoint.sh` | — | Entry point the deploy workflow calls over SSH. |
| `validate-production-deploy-readiness.mjs` | `validate:production-deploy`, `validate:deploy` | Static pre-deploy readiness checks against repo files and runbooks. |

Routine releases cannot change the production control-plane that judges or
executes their transition: the CI/deploy workflows, forced SSH entrypoint,
deployment and transition helpers, `.dockerignore`, PostgreSQL operational
scripts, baseline schema and baseline checksum. Those changes require the
explicit exceptional procedure in `docs/operations/DEPLOY_VPS.md`. Compose and
new migrations retain their narrower, separately tested transition policies.

## Database integrity

| Script | npm alias | Purpose |
|---|---|---|
| `validate-migrations.mjs` | `validate:migrations` | Migration numbering, immutability and runbook references. |
| `validate-postgres-app-integration.mjs` | `validate:postgres-app-integration` | App code talks to PostgreSQL through repositories, never a stray client. |
| `validate-postgres-schema-sandbox.mjs` | `postgres:schema:validate-sandbox` | Apply the schema to a throwaway sandbox database. |
| `postgres/remove-legacy-demo-users.mjs` | `postgres:legacy-demo-users:cleanup` | Audit the five exact retired demo identities by default; delete them only after backup and explicit dual confirmation. |

## Radar

| Script | npm alias | Purpose |
|---|---|---|
| `validate-radar-integration.mjs` | `validate:radar` | Radar receiver contract (HMAC, schema, host allowlist). |

## `postgres/`

| Script | npm alias | Purpose |
|---|---|---|
| `migrate.mjs` | `postgres:migrate`, `postgres:migrate:status` | Apply or report pending migrations. |
| `migration-files.mjs` | — | Shared migration-file listing helper. |
| `audit-baseline.mjs` | `postgres:baseline:audit`, `postgres:baseline:adopt` | Compare a live database to the committed baseline. |
| `reconcile-baseline.mjs` | `postgres:baseline:reconcile` | Reconcile baseline drift. |
| `bootstrap-runtime-role.mjs` | `postgres:bootstrap-runtime-role` | Create the restricted runtime role. |
| `set-user-password.mjs` | `postgres:user:set-password` | Set an application user's password hash. |
| `backup-production.sh`, `verify-backup-production.sh` | — | VPS-side backup and restore-rehearsal. |
