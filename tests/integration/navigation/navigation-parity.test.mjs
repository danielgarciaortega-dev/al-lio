// Source-level assertion rationale: issue #363 requires desktop and mobile
// navigation to expose the same first-level destinations, in the same order,
// with consistent labels, each appearing once, from one canonical model. The
// runtime shell needs Next.js + a session to render; reading the shared model
// and the two navigation surfaces as text is the executable boundary
// (tests/README.md taxonomy options 5 and 6).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

function navigationGroupLabels(source) {
  return [...source.matchAll(/label: "([^"]+)",\r?\n\s+tourId:/g)].map((match) => match[1]);
}

test("desktop and mobile navigation are rendered from one canonical destination model (issue #363)", async () => {
  const [navModel, sidebar, mobile, header] = await Promise.all([
    read("../../../src/components/nav-destinations.ts"),
    read("../../../src/components/app-sidebar.tsx"),
    read("../../../src/components/mobile-header-navigation.tsx"),
    read("../../../src/components/student-header-actions.tsx"),
  ]);

  // The model exports the ordered group list, the flat destination list, the
  // one active-route predicate and the action-cluster allowlist.
  for (const symbol of ["NAV_GROUPS", "NAV_DESTINATIONS", "isNavRouteActive", "NAV_ACTION_ROUTES"]) {
    assert.match(navModel, new RegExp(`export (const|function) ${symbol}\\b`), `nav-destinations must export ${symbol}`);
  }

  // Every navigation surface imports the model and none re-declares the data.
  assert.match(sidebar, /from "@\/components\/nav-destinations"/);
  assert.match(mobile, /from "@\/components\/nav-destinations"/);
  assert.match(header, /from "@\/components\/nav-destinations"/);
  for (const [name, source] of [["sidebar", sidebar], ["mobile", mobile], ["header", header]]) {
    assert.doesNotMatch(source, /\b(NAV_GROUPS|NAV_DESTINATIONS|VISIBLE_ROUTES|MAIN_ITEMS|COMMUNICATION_ITEMS|LEARNING_ITEMS)\s*=/, `${name} must not re-declare a navigation array`);
    assert.doesNotMatch(source, /pathname === href \|\| \(href !== "\/dashboard"/, `${name} must not re-implement the active-route predicate`);
  }
});

test("every supported first-level destination appears exactly once, in the agreed order and label (issue #363)", async () => {
  const navModel = await read("../../../src/components/nav-destinations.ts");

  const groupLabels = navigationGroupLabels(navModel);
  assert.deepEqual(groupLabels, ["Principal", "Comunicación", "Aprendizaje"], "navigation groups drifted from the agreed order");

  const hrefs = [...navModel.matchAll(/\{ href: "([^"]+)", label: "([^"]+)", icon: \w+ \}/g)].map((m) => m[1]);
  assert.deepEqual(
    hrefs,
    ["/dashboard", "/roadmap", "/tasks", "/bloc", "/noticias", "/work", "/courses", "/hackathons", "/calendar"],
    "the destination order or set drifted",
  );
  assert.equal(new Set(hrefs).size, hrefs.length, "a destination is listed more than once");

  const labels = [...navModel.matchAll(/\{ href: "[^"]+", label: "([^"]+)", icon: \w+ \}/g)].map((m) => m[1]);
  assert.deepEqual(
    labels,
    ["Inicio", "Competencias", "Tareas", "Bloc", "Noticias", "Trabajo", "Cursos", "Eventos y retos", "Calendario"],
    "a destination label drifted",
  );

  // The header action cluster covers exactly the nav destinations plus the
  // account area - never /settings, /sources or /links.
  assert.match(navModel, /NAV_ACTION_ROUTES[\s\S]*NAV_DESTINATIONS\.map\(\(destination\) => destination\.href\)[\s\S]*"\/profile"/);
  for (const excluded of ["/settings", "/sources", "/links"]) {
    assert.doesNotMatch(navModel, new RegExp(`"${excluded}"`), `${excluded} must not be a navigation or action route`);
  }
});

test("navigation group parsing is portable across LF and CRLF checkouts (issue #363)", () => {
  const lf = 'label: "Principal",\n  tourId: "nav-main"';
  const crlf = lf.replaceAll("\n", "\r\n");
  assert.deepEqual(navigationGroupLabels(lf), ["Principal"]);
  assert.deepEqual(navigationGroupLabels(crlf), ["Principal"]);
});

test("the shared active-route predicate distinguishes roots, child routes and sibling prefixes (issue #363)", async () => {
  const navModel = await read("../../../src/components/nav-destinations.ts");

  // The one predicate both navigation surfaces call. Its exact shape encodes:
  //  - an exact match activates any destination;
  //  - a `${href}/` prefix activates a real child route (/work -> /work/jobs/1);
  //  - the trailing slash stops a sibling prefix (/work never claims /workshops);
  //  - "/dashboard" is opted out of prefix matching, so "/" and every nested
  //    path do not light it up.
  const predicate = navModel.slice(navModel.indexOf("export function isNavRouteActive"), navModel.indexOf("NAV_ACTION_ROUTES"));
  assert.match(predicate, /pathname === href/, "an exact path must activate its destination");
  assert.match(predicate, /href !== "\/dashboard"/, "\"/dashboard\" must be exact-match only");
  assert.match(predicate, /pathname\.startsWith\(`\$\{href\}\/`\)/, "a child route must keep its parent active");
  assert.doesNotMatch(predicate, /pathname\.startsWith\(href\)(?!\s*\+|`)/, "a bare startsWith(href) would let a sibling prefix win");
});
