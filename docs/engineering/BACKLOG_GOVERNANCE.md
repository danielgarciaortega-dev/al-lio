# Engineering backlog governance

This document defines how AL-LÍO engineering work is classified, sequenced, reviewed and closed. The goal is to keep the repository auditable as the product grows without turning coordinators into implementation tickets or mixing unrelated risk domains.

The current repository-native execution board is issue #434. The current production-readiness audit coordinator is issue #433.

## 1. Language

Maintained engineering artefacts are written in English: issues, pull requests, commit messages, engineering documentation, audit records and code comments intended for maintainers.

Student-facing product copy may remain Spanish. Literal routes, source names and product strings are not translated merely to satisfy the engineering-language rule.

## 2. One primary owner per issue

Every implementation issue must own one coherent result. A neighbouring issue may be a dependency or consumer, but two open issues must not both claim implementation ownership for the same control.

When responsibilities touch, document the boundary explicitly. Examples:

- a security control issue may emit a degradation signal while the monitoring issue owns alert delivery and escalation;
- a feature-refactor issue may preserve an authorization contract while the authorization audit issue owns the cross-application proof;
- a rollout coordinator may sequence canaries while each canary has its own focused implementation issue.

If ownership cannot be explained in one or two sentences, split or rewrite the issues before implementation.

## 3. Standard implementation issue contract

Active implementation issues should contain these sections, in this order:

1. `Context` — verified current state and why the issue exists.
2. `Outcome` — the single result owned by the issue.
3. `Scope` — the smallest coherent in-scope work.
4. `Dependencies and coordination` — hard blockers, sequencing and neighbouring ownership boundaries.
5. `Acceptance criteria` — observable completion conditions.
6. `Evidence required` — proof required before closure.
7. `Non-goals` — explicit exclusions.
8. `Board` — current lane/priority/status reference where useful.

Coordinator/epic issues may replace `Scope` with `Workstreams`, `Board` or `Execution order`, but they must not hide implementation work that lacks a focused child issue.

## 4. Priority model

The execution board uses four priorities:

- **P0 — audit/release gate:** unresolved risk can invalidate the next production-readiness audit, block a risky production change or materially weaken production safety.
- **P1 — production hardening:** important operational/security/privacy maturity work that follows or supports the P0 gate.
- **P2 — product assurance / external readiness:** product-quality, provider or rollout work that is important but is not a P0 security gate.
- **P3 — maintenance / deferred:** cleanup, major dependency migration or optional capability work that should not destabilise higher-priority assurance work.

Priority represents risk/sequence, not permission to combine unrelated work in one branch.

## 5. Status model

Use the repository board status consistently:

- **NOW:** safe and useful to execute immediately.
- **READY:** unblocked but intentionally sequenced behind current work.
- **BLOCKED:** a concrete dependency must be satisfied first.
- **EXTERNAL:** progress depends materially on an external provider or private owner action.
- **COORDINATOR:** tracks child work and owns no implementation directly.
- **DEFERRED:** intentionally postponed to avoid churn or risk.

A status change should update #434 and, when material, the affected issue body/comment.

## 6. Dependency rules

Distinguish hard blockers from preferred sequencing.

A **hard dependency** means implementation or closure would be unsafe, misleading or invalid before another condition is satisfied. Examples include performing a production data reconciliation before a verified recovery point exists or refactoring permission-sensitive workflows before the authorization baseline is known.

**Preferred sequencing** means work could technically begin but should wait to reduce merge conflicts, duplicated evidence or audit churn.

Do not use vague phrases such as "depends on security". Name the exact issue/control and explain why it blocks the work.

## 7. Work-in-progress limits

For one primary engineer, the default WIP limit is:

- one P0 code/security implementation;
- one operations/infrastructure task that does not touch the same files/control plane;
- one external/provider action;
- one review-only/coordinator activity.

Avoid concurrent broad refactors that share authentication, Profile, Work, migrations or production configuration.

The objective is attributable evidence and small reviewable diffs, not maximum branch count.

## 8. Evidence standard

An issue is not complete because code was written or configuration appears plausible. Closure evidence must match the risk.

Possible evidence includes:

- focused unit/integration/architecture/E2E tests;
- green CI at an immutable commit SHA;
- authorization/data-flow matrices;
- production-safe status/header/crawl checks;
- redacted owner/admin configuration evidence;
- synthetic alert tests;
- isolated backup/restore rehearsals;
- provider approval/status evidence;
- explicit residual-risk/owner decisions.

For audit findings, distinguish:

1. **Implemented** — the control/change exists.
2. **Verified** — tests or review prove the intended behaviour.
3. **Production-observed** — when relevant, deployed behaviour has been checked safely.

Do not mark a finding complete if the required evidence level has not been reached.

## 9. Security and privacy hygiene

Public repository evidence must never contain:

- passwords or reusable credentials;
- session cookies/tokens;
- OAuth authorization codes, access tokens or refresh tokens;
- password-reset/confirmation tokens or complete private reset links;
- webhook secrets/signatures where disclosure enables forgery/replay;
- real personal-data rows;
- backup artefacts or encryption keys;
- unnecessary private IP addresses/hostnames;
- raw provider payloads containing private data.

Use redacted settings evidence, non-sensitive identifiers, stable reason codes and synthetic fixtures.

Confidential vulnerability details belong in the private security-reporting path rather than a public issue.

## 10. Coordinator versus implementation issues

A coordinator may:

- define sequence;
- track child status;
- define cross-cutting evidence standards;
- record final owner decisions.

A coordinator must not:

- become a mega-PR;
- silently absorb a missing implementation child;
- repeat completed historical plans as active work;
- own the same implementation responsibility as a child issue.

Close or rewrite stale coordinators when most of their original work is complete.

## 11. Production change gates

A production canary or data mutation should name the exact gates it requires. Typical examples:

- authorization proof for affected private paths;
- external monitoring sufficient to observe failure;
- verified backup/recovery appropriate to the data change;
- source/provider approval for externally sourced content;
- rollback/disable procedure.

The gate should be proportional to risk. Do not invent a dependency merely to make the board look rigorous.

## 12. Pull request discipline

Implementation pull requests should:

- link the focused issue;
- contain one reviewable concern;
- state relevant tests/evidence;
- preserve unrelated work;
- avoid opportunistic cleanup outside scope;
- not self-merge solely because the author created the issue;
- use the repository's required CI/review/deployment controls.

Major dependency migrations, architecture refactors and production rollouts should remain isolated from one another unless a specific technical requirement proves they must move together.

## 13. Audit cycle

Before the next production-readiness audit:

1. update #434 to reflect the real open backlog;
2. review #433 and every audit child for evidence status;
3. confirm P0 findings are closed, mitigated or explicitly accepted;
4. run a language/structure check over open engineering issues;
5. record the exact audit baseline SHA/date;
6. distinguish repository evidence from live-production evidence;
7. create focused follow-ups for any new finding rather than enlarging old unrelated issues.

This document should change only when the engineering operating model itself changes, not for routine issue status updates.
