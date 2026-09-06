# Compatibility register

Authoritative classification of the retained routes, handlers, and dormant
runtime flags in the AL-LIO web application. Part of #276; created by #357.

The application intentionally keeps several compatibility and dormant runtime
surfaces. This document states, for each one, why it exists, who consumes it,
how it is observed, and the concrete evidence that would allow its removal, so
a supported compatibility boundary is never confused with dead code.

## Scope and non-goals

In scope: the five runtime paths named in #357, their middleware, tests,
documentation and environment references, plus every dormant or rollout-only
`AL_LIO_*` value.

Out of scope (see #357 non-goals): removing an applied migration or a database
compatibility column, renaming Spanish public route slugs, activating dormant
Radar ingestion or publication, replacing the canonical Radar contracts, and
any UI or product-feature change. This classification slice removes nothing;
proven removal candidates are moved to exact-path follow-up issues.

## How to read this register

- Each retained runtime surface has a stable **ID**. The source file carries a
  `// COMPAT-REGISTER: <ID>` marker comment.
- `tests/architecture/repository/compatibility-register.test.mjs` fails if a
  registered path disappears, if a marked source file is not registered, if a
  marker ID does not match its registered path, if a new `410 Gone` route is
  added without a marker, or if a listed flag is no longer read by its
  consumer.
- "Observable behavior" is what an unauthenticated or authenticated caller can
  see today. "Removal condition" is the specific evidence required before a
  follow-up issue may delete the surface.

## Classification vocabulary

| Class | Meaning |
| --- | --- |
| `active` | Load-bearing in the current product. Not a compatibility surface; listed only where #357 asked for the application-versus-passthrough split. |
| `compatibility` | Deliberately retained for persisted links or old callers. Fail-closed or read-only. Has an owner and an exit condition. |
| `dormant` | Wired but disabled by default. Enabling it is a separate, reviewed rollout. |
| `removal-candidate` | No proven caller or retention reason found. Not removed here; moved to an exact-path follow-up issue. |

## Registered runtime compatibility surfaces

| ID | Path | Class |
| --- | --- | --- |
| `news-json-sync` | `src/app/api/news/sync/route.ts` | compatibility |
| `retired-collector-trigger` | `src/app/api/collect/route.ts` | compatibility |
| `legacy-ruta-deeplink` | `src/app/(dashboard)/ruta/[slug]/page.tsx` | compatibility |
| `tech-opportunities-catalogue-api` | `src/app/api/tech-opportunities/route.ts` | removal-candidate |

### `news-json-sync`

Legacy news JSON synchronisation endpoint.

- **Path**: `src/app/api/news/sync/route.ts`
- **Class**: `compatibility` (fail-closed)
- **Owner domain**: News / AL-LIO Radar receiver (`src/lib/radar/`, `src/app/api/radar/`).
- **Supported caller**: none in the repository. Retained for any historical
  external JSON-sync client so it receives an explicit `410 Gone` instead of a
  `404` that could hide a routing regression.
- **Authentication boundary**: none required. `GET` and `POST` both return
  `410` unconditionally. `src/middleware.ts` does not match `/api/*`, so the
  handler is the only boundary and it is fail-closed by construction.
- **Production state**: active in production as a permanent `410` response with
  `Cache-Control: no-store`. It never reads or writes data and never fetches a
  source.
- **Observability**: response body `{ ok: false, error: "legacy news sync
  disabled; AL-LIO Radar owns collection" }`. `scripts/validate-radar-integration.mjs`
  asserts the handler still contains `410`. Documented in
  `docs/architecture/README.md` ("Legacy JSON news files are not a production
  source of truth").
- **Fallback behavior**: none — the response is the terminal behavior.
- **Removal condition**: one full release cycle after #357 lands, an access-log
  review shows zero `GET`/`POST /api/news/sync` requests. Then delete the route
  in an exact-path issue and drop the `validate-radar-integration.mjs` assertion.

### `retired-collector-trigger`

Retired external job-collector trigger.

- **Path**: `src/app/api/collect/route.ts`
- **Class**: `compatibility` (fail-closed)
- **Owner domain**: Work / verified-job catalogue (`src/lib/jobs/`, Radar job delivery).
- **Supported caller**: none. A 2026-08-31 repository search (recorded in the
  file header) found no in-repo runtime caller, workflow, or script, and no
  documented external operational caller. The unreachable collector
  implementation and its credential contract were already removed in #334; the
  route is kept only as an explicit compatibility response so an old caller
  cannot silently fall through to a different handler or start external work.
- **Authentication boundary**: none required. `GET` returns `410` with
  `Cache-Control: no-store` unconditionally. Not matched by `src/middleware.ts`.
- **Production state**: active in production as a permanent `410`. It holds no
  provider credentials and cannot initiate external work.
- **Observability**: response body `{ error: "gone", detail: "This endpoint has
  been retired." }`. Covered by
  `tests/integration/work/retired-collector-route.test.mjs`. Documented in
  `docs/integrations/INTEGRATIONS_AND_DEEPLINKS.md` and
  `docs/integrations/VERIFIED_JOB_CATALOGUE.md`.
- **Fallback behavior**: none — the response is terminal.
- **Removal condition**: one full release cycle after #357, an access-log
  review shows zero `GET /api/collect` requests. Then delete the route and its
  integration test, and update the two integration docs, in an exact-path issue.

### `legacy-ruta-deeplink`

Legacy `/ruta/[slug]` deep-link resolver.

- **Path**: `src/app/(dashboard)/ruta/[slug]/page.tsx`
- **Class**: `compatibility` (persisted-link)
- **Owner domain**: Learning (`src/features/learning/server/`, `src/lib/fp/event-cta.ts`).
- **Supported caller**: previously shared or bookmarked `/ruta/<slug>` URLs.
  #112 removed the internal `/ruta` path screen and every code path that
  *builds* a `/ruta/` URL; integration tests in
  `tests/integration/learning/persistence-and-resources.test.mjs` and
  `tests/integration/events/lifecycle-and-catalogue.test.mjs` assert that no
  component constructs one any more. The page remains purely as a resolver for
  links that already exist in the wild.
- **Authentication boundary**: authenticated. `src/middleware.ts` lists `/ruta`
  as a private prefix (redirects anonymous requests to `/login`) and the page
  independently calls `getValidatedSession()` and redirects to `/login` when
  absent. It then requires a completed profile (`cycle_code` + `cycle_group`)
  or returns `notFound()`.
- **Production state**: active. It renders nothing: every branch ends in a
  `redirect()` to an internal screen (`/aprende/<slug>`, `/hackathons`,
  `/roadmap`). A `paso` value is only honoured when the competency genuinely
  belongs to the resolved item. YouTube and external event URLs are never
  returned. It reads no Events aptitude-completion state.
- **Observability**: HTTP 307/308 redirect to an in-app path, or `notFound()`.
  `getActiveVideoResourcesForCompetency` in
  `src/features/learning/server/catalogue-repository.ts` is the dedicated,
  status-filtered query it uses.
- **Fallback behavior**: ambiguous or missing internal matches fall back to
  `/hackathons` (aptitude-gated types) or `/roadmap` (everything else).
- **Removal condition**: an access-log review over one full academic year shows
  zero `/ruta/*` requests. Then, in an exact-path issue, delete the page, the
  `/ruta` entries in `src/middleware.ts`, and
  `getActiveVideoResourcesForCompetency` if it has no other caller.

### `tech-opportunities-catalogue-api`

Verified/legacy tech-opportunity catalogue API.

- **Path**: `src/app/api/tech-opportunities/route.ts`
- **Class**: `removal-candidate`
- **Owner domain**: Courses / Events catalogue (`src/lib/db/repositories/tech_opportunities.ts`).
- **Supported caller**: none found. The only code that fetches
  `/api/tech-opportunities` is `getTechOpportunities()` in
  `src/lib/tech-opportunities/tech-opportunities.ts`, and that helper (with
  `sortOpportunities`) has **no importers** anywhere in `src/`. It has not been
  edited since the `src/` directory move (#52). The product consumes the
  `tech_opportunities` table server-side through `src/lib/data.ts`
  (`getAllTechOpportunities()` into the shared store), not through this HTTP
  route. No script, workflow, or document calls the route.
- **Authentication boundary**: authenticated and hardened in #282/#309.
  `GET` requires `tryGetCurrentUserId()` and returns `401` with
  `Cache-Control: no-store` otherwise. On success it returns an explicit
  field-by-field `TechOpportunity` projection (never the raw row) with
  `Cache-Control: private, no-store`.
- **Production state**: reachable in production but, as far as the repository
  shows, uncalled.
- **Observability**: no test exercises the route directly; no log or metric
  distinguishes its traffic.
- **Fallback behavior**: `401` when unauthenticated; otherwise the full
  projected catalogue.
- **Removal condition / follow-up**: #376 (exact-path). (a) Confirm via
  access logs that there is no external consumer, then (b) delete
  `src/app/api/tech-opportunities/route.ts` together with the orphaned
  `src/lib/tech-opportunities/tech-opportunities.ts` helper. The
  `TechOpportunity` type and the `getAllTechOpportunities` repository stay —
  they are used by the store path. Nothing is removed in #357.

## Application configuration flags

Values the AL-LIO web application reads directly from `process.env`. This is
the application-owned set; the Radar and deployment passthrough set is listed
separately below.

| Flag | Consumer | Class |
| --- | --- | --- |
| `AL_LIO_RADAR_WEBHOOK_SECRET` | `src/lib/radar/webhook-auth.ts` | active |
| `AL_LIO_RADAR_V4_PROJECT_DESTINATIONS` | `src/lib/radar/v4-projection.ts` | dormant |
| `AL_LIO_RADAR_LEARNING_INGEST_ENABLED` | `src/app/api/radar/v1/learning/route.ts` | dormant |
| `AL_LIO_RELEASE_SHA` | `src/app/api/version/route.ts` | active |
| `AL_LIO_VERIFIED_OPPORTUNITIES_ONLY` | `src/lib/data.ts`, `src/features/learning/server/catalogue-repository.ts` | dormant |

- **`AL_LIO_RADAR_WEBHOOK_SECRET`** — `active`. The HMAC secret every Radar
  receiver route (`ingest`, `learning`) verifies. `scripts/validate-runtime-env.mjs`
  requires it (>= 32 chars) in production; `infra/docker-compose.prod.yml`
  marks it required for both `al_lio_web` and `al_lio_radar`. Not dormant, not
  a removal candidate.
- **`AL_LIO_RADAR_V4_PROJECT_DESTINATIONS`** — `dormant` (rollout allowlist).
  Empty by default, which keeps Radar v4 canonical-only. A comma-separated
  subset of `news,course,event,job` enables one reviewed vertical at a time
  (`radarV4ProjectionDestinations()`, consumed by
  `src/lib/db/repositories/radar-v4.ts` and `src/lib/jobs/repository.ts`).
  `validate-runtime-env.mjs` validates the enum. Exit condition: not a removal
  candidate — it is the documented activation control for #200/#282 rollouts.
- **`AL_LIO_RADAR_LEARNING_INGEST_ENABLED`** — `dormant`. Default off; while off,
  `POST /api/radar/v1/learning` returns `503 learning ingest is disabled`
  before any authentication or body read. Intended to be enabled only after the
  Radar #24 / AL-LIO #202 contract fixtures are reviewed together (see
  `.env.example`). `validate-runtime-env.mjs` validates it is `true`/`false`.
- **`AL_LIO_RELEASE_SHA`** — `active`. The immutable release mechanism injects
  the exact 40-character commit SHA into the private release `.env`.
  `GET /api/version` exposes only that value, and production startup rejects a
  missing or malformed identity. It is not a developer-managed feature flag.
- **`AL_LIO_VERIFIED_OPPORTUNITIES_ONLY`** — `dormant` (product gate). Default
  off. When `true`, `src/lib/data.ts` drops `tech_opportunities` course rows
  and `src/features/learning/server/catalogue-repository.ts` restricts the
  catalogue to canonical accepted course/event rows. Kept off until canonical
  course/event parity is reviewed locally (`.env.example`).
  `validate-runtime-env.mjs` validates it is `true`/`false`.

## Radar and deployment passthrough

These `AL_LIO_*` names appear in `.env.example`, `.env.production.example`,
`infra/docker-compose.prod.yml`, and Radar documentation, but the AL-LIO web
application never reads them. Compose interpolates them into the `al_lio_radar`
or migrator service. They are Radar-owned or deployment-owned configuration and
are out of scope for application compatibility classification.

- **Radar service passthrough** (`al_lio_radar` in `infra/docker-compose.prod.yml`):
  `AL_LIO_RADAR_DELIVERY_SCHEMA_VERSION`, `AL_LIO_RADAR_AUTONOMOUS_PUBLICATION_ENABLED`,
  `AL_LIO_RADAR_AUTONOMOUS_PUBLICATION_DESTINATIONS`,
  `AL_LIO_RADAR_AUTONOMOUS_NEWS_SOURCE_CYCLE_MATRIX_JSON`,
  `AL_LIO_RADAR_DAILY_PUBLICATION_TIMEZONE`, `AL_LIO_RADAR_DAILY_PUBLICATION_TIME`,
  `AL_LIO_RADAR_WEB_DISCOVERY_ENABLED`, `AL_LIO_RADAR_LEARNING_DISCOVERY_ENABLED`,
  `AL_LIO_RADAR_YOUTUBE_WATCH_ENABLED`, `AL_LIO_RADAR_LEARNING_DELIVERY_ENABLED`,
  `AL_LIO_RADAR_YOUTUBE_API_KEY`, `AL_LIO_RADAR_JOB_RADAR_ENABLED`,
  `AL_LIO_RADAR_LOG_LEVEL`, `AL_LIO_RADAR_HTTP_TIMEOUT_MS`,
  `AL_LIO_RADAR_HTTP_MAX_RETRIES`, `AL_LIO_RADAR_RATE_LIMIT_MS`,
  `AL_LIO_RADAR_MAX_BODY_BYTES`, `AL_LIO_RADAR_DELIVERY_BATCH_SIZE`,
  `AL_LIO_RADAR_BUILD_CONTEXT`, `AL_LIO_RADAR_IMAGE_TAG`. Their fail-closed
  defaults are asserted by `scripts/validate-radar-integration.mjs` and
  `tests/operations/deployment/radar-production-config.test.mjs`.
- **Deployment / image selection**: `AL_LIO_IMAGE_TAG` (the application-owned
  `AL_LIO_RELEASE_SHA` is registered above).
- **Migrator guardrails** (`al_lio_migrator` in `infra/docker-compose.prod.yml`):
  `AL_LIO_BASELINE_CONFIRMATION`, `AL_LIO_BASELINE_RECONCILIATION`,
  `AL_LIO_DB_ROLE_CONFIRMATION`.

## Removal candidates and follow-up

| Surface | Follow-up |
| --- | --- |
| `src/app/api/tech-opportunities/route.ts` (+ orphaned `src/lib/tech-opportunities/tech-opportunities.ts`) | #376: confirm no external consumer via access logs, then remove both. Keep the `TechOpportunity` type and `getAllTechOpportunities`. |

The original #357 classification slice removed no route, flag, handler, or
compatibility behavior.

## Retired by #379

Owner confirmation on 2026-09-01 established that the non-production
`/api/seed` endpoint, the Settings sample-data action, the five permanent demo
identities, passwordless demo login, `AL_LIO_DEMO_ACCESS_ENABLED`, and the
demo-user seed command were obsolete. #379 removes those surfaces together.
Isolated sandbox and automated-test fixtures remain supported; they cannot
reach production.

## Change control

- Any change to a listed route, page, or flag consumer must update the matching
  entry in the same commit.
- Adding a new fail-closed (`410 Gone`) route, or a new compatibility surface,
  requires a new row here and a `// COMPAT-REGISTER: <ID>` marker in the source
  file. `tests/architecture/repository/compatibility-register.test.mjs`
  enforces both directions.
- Authentication, user-ownership, fail-closed responses, and production guards
  described above are invariants; the architecture test re-checks the concrete
  markers (`410`, `tryGetCurrentUserId`, `getValidatedSession`) so a silent
  weakening fails CI.
