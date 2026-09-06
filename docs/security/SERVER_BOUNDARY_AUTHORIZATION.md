# Server-boundary authorization proof

Issue: #427

This document records the authorization model for AL-LÍO server entry points. The machine-readable source of truth is `config/security/server-boundaries.json`; `scripts/check-server-boundary-authorization.mjs` verifies that every current Route Handler and every source file containing a `"use server"` directive is present in that inventory.

## Security invariant

Middleware is routing convenience, not the final authorization boundary. A private operation must derive identity from a database-validated session at the operation boundary, or use a stronger explicit non-user trust model.

`getValidatedSession()` verifies the signed/expiring session and then loads the current user row to compare the persisted `security_stamp`. `getCurrentUserId()` and `tryGetCurrentUserId()` delegate to that validated session. `requireAdminUser()` additionally reloads the user and derives the administrator role from the database.

User-owned operations derive ownership from `session.uid`; client-supplied resource identifiers are selectors, not authority. The authorization checker rejects sensitive inventoried files that call signature-only `getSession()` and rejects common client-controlled `userId` input patterns.

## Boundary classes

| Class | Required trust model |
| --- | --- |
| `public` | No private state or a narrow public capability such as credential login, one-time confirmation/reset, static health, or a retired fail-closed endpoint. |
| `authenticated` | Database-validated AL-LÍO session before protected access. |
| `user-owned` | Database-validated session; ownership/cycle is derived server-side from the caller. |
| `admin-only` | Database-validated session plus a fresh server-side user-role check. |
| `internal-signed` | Explicit machine trust using the Radar HMAC signature, timestamp window, delivery identity, and supported schema. |
| `provider-callback` | Provider/capability callback with explicit state/token verification; Calendar additionally requires an already validated AL-LÍO session. |

## Reviewed high-risk paths

- Private dashboard reads enter through `getAuthenticatedStudentContext()` and therefore the database-backed session revocation check.
- Profile reads use `getValidatedSession()` and query the profile/user by `session.uid`.
- Settings performs `requireAdminUser()` server-side before rendering administrator controls.
- Tasks, Bloc, Courses, Events, Work, onboarding, product-tour, Learning progress/notes and Job Radar mutations derive the user from a validated session rather than accepting client ownership.
- Learning and verified-content operations derive the active FP cycle from the caller's persisted profile before accessing cycle-scoped content.
- Job Radar repository updates/deletes include both object id and `user_id` in SQL predicates.
- Google Calendar consent/callback/events/status require a validated AL-LÍO session; stored provider credentials are resolved for the caller's `session.uid`.
- Google identity login uses state plus PKCE and creates a session only after resolving a verified Google identity.
- Radar ingestion is machine-to-machine and verifies HMAC signature, timestamp freshness, delivery id and schema version before persistence.
- Legacy collector/news-sync endpoints are fail-closed compatibility routes returning HTTP 410.
- `/api/health` and `/api/ready` expose only minimal liveness/readiness facts and no user-owned data.

## Audit result at baseline

Baseline reviewed: `6850adeee8b81b07cb74967ead2c72d0816a039e`.

No demonstrated cross-user read/write, forged administrator role, middleware-only private authorization, or client-controlled `userId` authority was found in the reviewed server boundaries. Existing revocation tests already proved that `security_stamp` changes invalidate direct Server Action/API access; this issue extends that protection from a manually maintained subset to an exhaustive file inventory.

## Continuous enforcement

Run:

```sh
npm run check:authorization-boundaries
```

The check fails when:

- a Route Handler exists without an inventory entry;
- a source file contains `"use server"` without an inventory entry;
- an inventoried file is removed but its entry remains;
- required guard/trust evidence disappears;
- an authenticated/user-owned/admin boundary calls signature-only `getSession()`;
- a user-owned boundary matches a known client-controlled `userId` ownership pattern;
- an admin boundary stops using `requireAdminUser()`;
- an internal Radar boundary stops verifying the signed webhook.

The check is part of `verify:startup`, so it runs in the normal CI verification path before merge.

## Residual scope

This proof establishes the current server authorization baseline. It does not replace:

- trusted proxy/client-IP work in #428;
- repository/deployment governance in #426;
- privacy lifecycle work in #429;
- future `internal_tester` capability design in #195.

Any new private server boundary must be classified before CI can pass. Any new privilege/capability must use a fresh server-derived authorization decision rather than extending client authority.
