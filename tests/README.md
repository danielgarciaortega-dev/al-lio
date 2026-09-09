# Testing strategy

AL-LÍO uses Node's built-in test runner (`node:test`) and groups tests by executable
boundary first, then by the product domain that owns the risk.

Repository-wide file placement, retention and the hygiene review live in
[`docs/PROJECT_STRUCTURE.md`](../docs/PROJECT_STRUCTURE.md); this document covers
the test tree and its fixtures specifically.

## Taxonomy

```text
tests/
├── architecture/        # dependency, design-system and project-shape rules
├── contracts/           # versioned payload and cross-system contracts
├── integration/         # route, server, persistence and UI wiring boundaries
├── operations/          # deployment, Compose, migrations, runtime and importers
├── support/             # genuinely cross-domain test infrastructure
├── unit/                # directly executable pure functions and domain rules
└── migration-inventory.json
```

Every test file must live at `tests/<layer>/<domain>/<name>.test.mjs`. The domain
folder is the owner: `auth`, `news`, `courses`, `events`, `learning`, `work`, and
so on. A file must not become the owner of unrelated domains merely because they
share an assertion style.

Feature component tests may move next to a future `src/features/<feature>/`
implementation when the selected component runner supports co-location cleanly.
Versioned cross-system fixtures stay beside their contract; reusable test factories
belong to the domain that defines them. `tests/support/` is reserved for genuinely
cross-domain test infrastructure and must not become another catch-all.

The product-source reader lives in `tests/support/` because integration, architecture,
and unit suites across several owner domains consume it. Design-system contrast helpers
stay under `tests/architecture/design-system/support/`, beside their sole owner domain.

## Commands

```bash
npm run test:unit
npm run test:contracts
npm run test:integration
npm run test:architecture
npm run test:operations
npm run test:taxonomy
npm run test:all
npm test
npm run ci
```

- `test:<layer>` runs only that layer and makes CI/local failures discoverable.
- `test:taxonomy` validates placement, the issue #274 migration inventory, file-size
  limits, and the absence of an unexplained source-level assertion.
- `test:all` runs the taxonomy guard and every `*.test.mjs` file recursively.
- `npm test` preserves the aggregate project contract: project/content validation,
  every automated test, and TypeScript checking.
- `npm run ci` remains the complete release gate.

To run one domain or file, pass it directly to Node:

```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/integration/auth/*.test.mjs
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/unit/events/lifecycle.test.mjs
```

## Choosing the strongest practical boundary

Prefer the first applicable boundary below:

1. Import and execute a pure business rule.
2. Invoke the public service, repository, route, or server-action boundary with
   controlled session and dependency adapters.
3. Exercise SQL ownership, constraints, transactions, and atomicity against an
   isolated PostgreSQL test database when SQL semantics are the risk.
4. Render or interact with a route/component and assert observable output.
5. Use an AST or dependency rule for architecture constraints.
6. Inspect source/configuration text only when executing the real boundary is unsafe
   or unavailable in the current runner.

Source-string assertions are intentionally strict and are not the default. They are
acceptable for deployment scripts, workflows, immutable configuration contracts,
Next.js/browser-only wiring without a compatible harness, and server/database modules
that the plain Node runner cannot load. Every file that uses them must start with a
`Source-level assertion rationale:` comment (or the equivalent migration rationale)
that states why the real boundary is not executed. When a compatible harness is added,
replace the source assertion rather than preserving both indefinitely.

## Security expectations

Security tests must keep authentication separate from authorization and continue to
cover, where applicable:

- unauthenticated, unauthorized, cross-user and identifier-tampering cases;
- caller-owned query and mutation scoping;
- generic unauthorized/not-found responses when object existence is sensitive;
- server-only secrets and validated external input;
- session revocation, rate limiting and enumeration-safe authentication flows;
- atomic security-sensitive database writes;
- deployment and migration guarantees that protect production state.

Moving a test never authorizes weakening or deleting one of these guarantees. Prefer
an executable boundary over a regex when practical; retain the structural guard with
an explicit rationale when execution would require mutating production-like state.

## Naming and contribution rules

- Name the observable guarantee, not the implementation function alone.
- Include the originating issue in the test title when one exists.
- Keep one layer and one owner domain per file.
- Put new fixtures beside the owning contract/domain; do not add global fixture bags.
- Do not introduce a new root-level or multi-domain test suite.
- Split a file before it exceeds 60 tests or 1,200 lines; the taxonomy guard enforces
  both ceilings as a lightweight early-warning system.
- Update the relevant focused command and documentation when adding a new layer.

## Issue #274 migration inventory

`migration-inventory.json` records all 263 tests that previously lived in
`security-boundaries.test.mjs`, including their original order/line, issue references,
protected risk, owner domain, assertion style, target file, and intended replacement.
It is the no-regression checklist for the mechanical split. `test:taxonomy` verifies
that indexes 1–263 are complete and that each target contains exactly its mapped tests
with the original names and order. The original 2026-08-31 audit counted 325 aggregate
tests at commit `53b25ab`; this branch runs 327 because the two focused public-contact
tests from #277 landed on `main` after that baseline. All 263 catch-all tests remain.

The retired `security-boundaries.test.mjs` must not be recreated. New coverage belongs
in the focused layer/domain file that owns the behaviour.
