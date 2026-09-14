// Source-level assertion rationale: the catalogue-order rules execute directly; the remaining
// responsive header wiring needs a browser-capable component harness that this Node suite does not provide.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readFeatureSource } from "../../support/feature-sources.mjs";

import { getNextCatalogItem } from "../../../src/lib/catalog/next-item.ts";

test("course navigation advances through the complete catalogue and wraps once", () => {
  const courses = ["a", "b", "c", "d", "e"].map((id) => ({ id }));

  assert.equal(getNextCatalogItem(courses, "a")?.id, "b");
  assert.equal(getNextCatalogItem(courses, "b")?.id, "c");
  assert.equal(getNextCatalogItem(courses, "c")?.id, "d");
  assert.equal(getNextCatalogItem(courses, "d")?.id, "e");
  assert.equal(getNextCatalogItem(courses, "e")?.id, "a");
});

test("course navigation has no recommendation for a missing or solitary current item", () => {
  assert.equal(getNextCatalogItem([{ id: "only" }], "only"), null);
  assert.equal(getNextCatalogItem([{ id: "known" }, { id: "next" }], "missing"), null);
});

test("course and event detail headers keep their action clusters desktop-only", async () => {
  const source = await readFeatureSource("courses", "events");
  const courseDetail = source.slice(source.indexOf("export function CourseDetailView"), source.indexOf("function Hackathons("));
  const eventDetail = source.slice(source.indexOf("export function HackathonDetailView"), source.indexOf("function LinksView"));

  for (const detail of [courseDetail, eventDetail]) {
    assert.doesNotMatch(detail, /actions=\{<StudentHeaderActions \/>\}/);
    assert.equal(
      (detail.match(/className="hidden md:flex md:items-center md:gap-2">\s*<StudentHeaderActions \/>/g) ?? []).length,
      2,
      "the regular and not-found detail headers must defer to the global mobile navigation actions",
    );
  }
});

test("CourseDetailView uses catalogue order without date or lifecycle filtering", async () => {
  const source = await readFeatureSource("courses", "events");
  const detail = source.slice(source.indexOf("export function CourseDetailView"), source.indexOf("function Hackathons("));

  assert.match(detail, /const nextCourse = getNextCatalogItem\(allCourses, item\.id\);/);
  assert.doesNotMatch(detail, /const pool = allCourses|\.filter\(\(x\) => x\.k\)|c\.status !== "terminado"/);
});
