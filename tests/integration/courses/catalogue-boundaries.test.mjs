// Migrated mechanically from tests/security-boundaries.test.mjs for issue #274.
// Source-level assertions temporarily protect a Next.js, browser, or database boundary that the plain Node runner cannot execute; replace them when the corresponding integration harness exists.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readFeatureSource } from "../../support/feature-sources.mjs";

import { isSafeHttpUrl } from "../../../src/lib/fp/event-cta.ts";

import { fpItemToHackathon } from "../../../src/features/events/presentation/event-presentation.ts";
import { fpItemToCourse, getCoursePresentation, resolveCourseById } from "../../../src/features/courses/presentation/course-presentation.ts";

test("Course completion routes each origin through its own persistence path with rollback (issue #94)", async () => {
  const storeSource = await readFile(new URL("../../../src/features/courses/client/use-course-actions.ts", import.meta.url), "utf8");
  const completeCourseStart = storeSource.indexOf("completeCourse: async (course) =>");
  const completeCourseEnd = storeSource.indexOf("toggleCourseFavorite: (id) =>", completeCourseStart);
  assert.ok(completeCourseStart > -1 && completeCourseEnd > completeCourseStart, "could not locate the completeCourse action body");
  const completeCourseSource = storeSource.slice(completeCourseStart, completeCourseEnd);

  // fp_content_items: routed through fp_user_content_state, not copied into
  // the courses table.
  const fpStart = completeCourseSource.indexOf('"fp_content_items"');
  const fpEnd = completeCourseSource.indexOf('"tech_opportunities"');
  const fpBranch = completeCourseSource.slice(fpStart, fpEnd);
  assert.match(fpBranch, /await markLearningResourceStatusAction\(\{ idSlug: course\.id_slug, status: "completed" \}\)/);
  assert.doesNotMatch(fpBranch, /createCourseAction/);
  assert.match(fpBranch, /user_status: previous\?\.user_status, user_completed_at: previous\?\.user_completed_at/, "fp branch must roll back the optimistic completion on failure");
  assert.match(fpBranch, /throw error;|throw new Error/);

  // tech_opportunities: checks for an existing row by id_slug before ever
  // inserting (the idempotent-retry / no-duplicate requirement), and forwards
  // id_slug on insert so the DB's unique (user_id, id_slug) index is actually
  // effective.
  const techBranch = completeCourseSource.slice(fpEnd);
  assert.match(techBranch, /store\.courses\.find\(\(item\) => item\.id_slug === course\.id_slug\)/);
  assert.match(techBranch, /idSlug: course\.id_slug/);
  assert.match(techBranch, /courses: current\.courses\.filter\(\(item\) => item\.id !== id\)/, "tech branch must roll back the optimistic insert on failure");

  // Every branch normalizes optional dates before writing and re-throws on
  // failure so the caller (the card's onClick) sees the rejection. Four
  // distinct persistence paths re-throw: fp, tech-existing-row,
  // tech-new-row, and the plain already-user-owned row.
  for (const field of ['startAt: course\\.start_at', 'deadlineAt: course\\.deadline_at']) {
    assert.match(completeCourseSource, new RegExp(field));
  }
  assert.ok((completeCourseSource.match(/throw error;/g) ?? []).length >= 2, "every owned persistence path must re-throw on failure");

  // Plain, already user-owned courses roll back to the exact previous row,
  // not just an empty/unknown state.
  assert.match(completeCourseSource, /await completeOwnedCourse\(course, store\.courses, setStore\)/);
});

test("fp course completion is per-user isolated and never mutates the shared courses table (issue #94)", async () => {
  const actionsSource = await readFile(new URL("../../../src/features/learning/server/actions.ts", import.meta.url), "utf8");
  const fnSource = actionsSource.slice(actionsSource.indexOf("export async function markLearningResourceStatusAction"));

  assert.match(fnSource, /const userId = await getCurrentUserId\(\);/);
  assert.match(fnSource, /getAuthorizedResource\(userId, parsed\.data\.idSlug\)/, "must resolve the item scoped to the current session's user/cycle");
  assert.match(fnSource, /upsertFpUserContentState\(userId, item\.id/, "must write scoped to the authenticated user, not a caller-supplied id");
  assert.match(fnSource, /revalidatePath\("\/courses"\)/);

  const coursePresentationSource = await readFile(new URL("../../../src/features/courses/presentation/course-presentation.ts", import.meta.url), "utf8");
  assert.match(coursePresentationSource, /fpUserStatusToCourseStatus\(item\.user_status\)/, "fpItemToCourse must read the per-user completion state, not just the catalogue's own display status");
});

test("Course cards reuse the shared catalogue anatomy, keep full labels reachable, and stay inside a grid capped at 3 columns (issue #94, issue #130, issue #160, issue #164)", async () => {
  const [guestAppSource, cardSource, globalStyles] = await Promise.all([
    readFeatureSource("work", "courses", "events"),
    readFile(new URL("../../../src/components/catalog/catalog-card.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../src/app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(cardSource, /al-catalog-card-title line-clamp-2/);
  assert.match(cardSource, /al-catalog-card-org line-clamp-1/);
  // Clamping must not hide content with no fallback - the clamped elements
  // keep the full text reachable via a native accessible title attribute,
  // sourced from the one shared presentation model (issue #130).
  assert.match(cardSource, /title=\{title\}/);
  assert.match(cardSource, /title=\{subtitle\}/);
  // issue #130: the header row wraps a min-w-0 title block and a shrink-0
  // badge cluster - the same shape Trabajo/Eventos y retos use.
  assert.match(cardSource, /al-catalog-card-title-wrap/);
  assert.match(cardSource, /al-catalog-card-badges/);
  // issue #160: the redesigned card carries only the three identifying
  // facts and a single Ver detalles action - no Abrir/Terminado, no
  // description, no location/priority chips competing for attention.
  assert.doesNotMatch(cardSource, /card-desc/, "the card must not render a description block anymore");
  assert.doesNotMatch(cardSource, />Terminado</, "Terminado moves to the detail view");
  const coursesSource = guestAppSource.slice(guestAppSource.indexOf("function Courses("), guestAppSource.indexOf("function courseStatusPillClass"));
  assert.match(coursesSource, /<CatalogCard/);
  assert.match(coursesSource, /<CatalogFeaturedCard/);

  const styleSource = globalStyles.slice(globalStyles.indexOf(".al-catalog-card {"), globalStyles.indexOf(".al-catalog-card-actions {"));
  assert.match(styleSource, /min-width:\s*0/, "the grid cell itself must be allowed to shrink below its content's intrinsic width");
  assert.match(styleSource, /overflow-wrap:\s*anywhere/, "title/org must break long unbroken strings instead of overflowing the card");

  // issue #160: at most 3 cards per row so the screen never feels saturated.
  const gridStyle = globalStyles.slice(globalStyles.indexOf(".al-catalog-grid-cards {"), globalStyles.indexOf(".al-catalog-featured {"));
  assert.doesNotMatch(gridStyle, /auto-fill/, "the grid must not auto-fill an unbounded number of columns");
  assert.match(gridStyle, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/, "the widest breakpoint caps the grid at 3 columns");
});

test("The course source URL is only linked from the detail view, and gated by isSafeHttpUrl (issue #130, issue #160)", async () => {
  const guestAppSource = await readFeatureSource("courses", "events");
  // issue #160: the grid card no longer links out - Abrir moved to the detail panel.
  const cardStart = guestAppSource.indexOf('key={item.id} className="al-course-card"');
  const cardEnd = guestAppSource.indexOf("al-course-card-actions", cardStart);
  assert.doesNotMatch(guestAppSource.slice(cardStart, cardEnd), /href=\{presentation\.sourceUrl\}|sourceUrl/, "the card must not open the external URL directly");

  const viewFnStart = guestAppSource.indexOf("export function CourseDetailView");
  const viewFnEnd = guestAppSource.indexOf("function Hackathons(");
  const viewFnSource = guestAppSource.slice(viewFnStart, viewFnEnd);
  assert.match(viewFnSource, /isSafeHttpUrl\(presentation\.sourceUrl\)/, "Abrir curso must not link to an unvalidated URL (javascript:/data: guard)");
  assert.match(viewFnSource, /rel="noopener noreferrer"/);
});

test("Every course card offers Ver detalles, linking to the real internal /courses/[id] page - the old CourseDetailModal was retired outright, mirroring the hackathons detail route (owner-reported follow-up to #135/#120)", async () => {
  const [source, cardSource] = await Promise.all([
    readFeatureSource("work", "courses", "events"),
    readFile(new URL("../../../src/components/catalog/catalog-card.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(source, /detailHref=\{`\/courses\/\$\{encodeURIComponent\(item\.id\)\}`\}/, "the grid card must pass its real internal detail URL unconditionally");
  assert.match(source, /detailHref=\{`\/courses\/\$\{encodeURIComponent\(featuredCourse\.id\)\}`\}/, "the featured card must pass the same internal detail URL");
  assert.match(cardSource, /<Link href=\{href\} className=\{cn\("al-catalog-detail-link"/);
  assert.match(cardSource, /Ver detalles\s*<\/Link>/, "the shared action must keep one explicit Spanish expansion label");
  assert.doesNotMatch(source, /function CourseDetailModal/, "the modal must be removed entirely, not just left unreachable");
  assert.doesNotMatch(source, /setDetailItemId|detailItemId/, "no state should remain for opening a modal that no longer exists");

  assert.match(source, /export function CourseDetailView\(\{ id \}: \{ id: string \}\)/);
  const viewFnStart = source.indexOf("export function CourseDetailView");
  const viewFnEnd = source.indexOf("function Hackathons(");
  const viewFnSource = source.slice(viewFnStart, viewFnEnd);
  assert.match(viewFnSource, /const presentation = getCoursePresentation\(item\);/, "the detail view must reuse the shared presentation model, not re-derive its own field mapping");
});

test("Courses and Events share the same quiet catalogue detail action instead of duplicating the solid orange CTA (issue #164)", async () => {
  const [guestAppSource, cardSource, globalStyles] = await Promise.all([
    readFeatureSource("courses", "events"),
    readFile(new URL("../../../src/components/catalog/catalog-card.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../src/app/globals.css", import.meta.url), "utf8"),
  ]);

  const coursesSource = guestAppSource.slice(guestAppSource.indexOf("function Courses("), guestAppSource.indexOf("function courseStatusPillClass"));
  const eventsSource = guestAppSource.slice(guestAppSource.indexOf("function Hackathons("), guestAppSource.indexOf("function HackathonsEmptyState"));
  for (const moduleSource of [coursesSource, eventsSource]) {
    assert.match(moduleSource, /<CatalogFeaturedCard/);
    assert.match(moduleSource, /<CatalogCard/);
  }
  assert.match(cardSource, /className=\{cn\("al-catalog-detail-link"/);

  const quietButtonStyles = globalStyles.slice(globalStyles.indexOf(".al-catalog-detail-link {"), globalStyles.indexOf(".al-action-soft:hover"));
  assert.match(quietButtonStyles, /background:\s*var\(--al-action-soft-bg\)/);
  assert.match(quietButtonStyles, /border:\s*1px solid var\(--al-action-soft-border\)/);
  assert.match(quietButtonStyles, /color:\s*var\(--al-action-soft-text\)/);
  assert.doesNotMatch(quietButtonStyles, /linear-gradient|color:\s*white|border:\s*none/, "the internal detail action must remain visually quiet");
});

test("Routine actions share the quiet terracotta treatment while semantic states keep their own colors (issue #166)", async () => {
  const [globalStyles, button, guestApp, dailyAlerts, login, bloc, roadmap] = await Promise.all([
    readFile(new URL("../../../src/app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../../../src/components/ui/button.tsx", import.meta.url), "utf8"),
    readFeatureSource("work", "courses", "events"),
    readFile(new URL("../../../src/components/daily-alerts.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../src/components/auth/login-form.tsx", import.meta.url), "utf8"),
    readFeatureSource("bloc"),
    readFile(new URL("../../../src/features/learning/client/roadmap-view.tsx", import.meta.url), "utf8"),
  ]);

  // The login page is deliberately on its own green treatment (issue #264),
  // not the shared terracotta one - it must not restore the loud gradient.
  assert.doesNotMatch(login, /linear-gradient\(90deg, #E15D2D|#E9A23B|#e9a23b/i, "the login card must not use the amber/orange gradient");
  assert.match(login, /background:\s*#1F5B46/, "the login submit button is the standalone green fill");

  for (const token of [
    "--al-action-soft-bg: #fff8f4",
    "--al-action-soft-bg-hover: #fbe7dd",
    "--al-action-soft-border: rgba(225, 93, 45, 0.24)",
    "--al-action-soft-text: #b94720",
    "--al-action-soft-text-hover: #a63f1a",
  ]) {
    assert.ok(globalStyles.includes(token), `missing shared action token: ${token}`);
  }
  assert.match(globalStyles, /\.al-action-soft:hover:not\(:disabled\)/);
  assert.match(globalStyles, /\.al-action-soft:focus-visible/);
  assert.match(globalStyles, /\.al-action-soft:active:not\(:disabled\)/);
  assert.match(button, /variant === "default" && "al-action-soft"/);

  const catalogueAction = globalStyles.slice(globalStyles.indexOf(".al-catalog-action-solid {"), globalStyles.indexOf(".al-catalog-action-soft {"));
  assert.match(catalogueAction, /background:\s*var\(--al-action-soft-bg\)/);
  assert.doesNotMatch(catalogueAction, /linear-gradient|color:\s*white|border-color:\s*transparent/);

  const workStyles = guestApp.slice(guestApp.indexOf("const workBrandCss"), guestApp.indexOf("const WORK_DIACRITICS_PATTERN"));
  assert.doesNotMatch(workStyles, /linear-gradient|#FFCD00/i, "Work tabs, search and company actions must not restore the loud orange/yellow treatments");
  for (const selector of ["al-work-tab-active", "al-work-portal-search-btn", "al-work-company-btn-solid"]) {
    assert.match(workStyles, new RegExp(`\\.${selector}[^}]+var\\(--al-action-soft-`));
  }
  assert.match(guestApp, /"Welcome to the Jungle": "border border-\[#e9d6cb\] bg-\[#fff8f4\] text-\[#a63f1a\]"/);

  for (const source of [dailyAlerts, bloc, roadmap]) {
    assert.match(source, /al-action-soft|var\(--al-action-soft-/, "each major routine-action surface must consume the shared treatment");
  }
  assert.match(dailyAlerts, /bg-rose-500 text-white/, "urgent alerts must remain semantically red");
  assert.match(button, /bg-destructive text-destructive-foreground/, "destructive actions must remain visually distinct");
});

test("Course and event details use the same hero, information, three-column section, panel and next-item primitives (issue #164)", async () => {
  const source = await readFeatureSource("courses", "events");
  const courseDetail = source.slice(source.indexOf("export function CourseDetailView"), source.indexOf("function Hackathons("));
  const eventDetail = source.slice(source.indexOf("export function HackathonDetailView"), source.indexOf("function LinksView"));

  for (const detailSource of [courseDetail, eventDetail]) {
    assert.match(detailSource, /lg:grid-cols-\[1fr_320px\]/);
    assert.match(detailSource, /className="al-catalog-hero-media"/);
    assert.match(detailSource, /<CatalogInfoGrid items=/);
    assert.match(detailSource, /className="al-catalog-detail-cols"/);
    assert.match(detailSource, /<CatalogPanel/);
    assert.match(detailSource, /<CatalogNextLink/);
  }
  assert.match(eventDetail, /<CatalogPanel title="Recursos para prepararte">/);
  assert.match(eventDetail, /<RequirementRow key=\{competency\.id\}/, "reviewed linked courses and videos must remain reachable from each event requirement");
});

test("Course descriptions never fall back to raw import/moderation notes for any origin - the same regression class fixed for Hackathons in issue #118 (issue #130)", async () => {
  const source = await readFile(new URL("../../../src/features/courses/presentation/course-presentation.ts", import.meta.url), "utf8");
  assert.match(source, /description: canonical\?\.aboutSummary \?\? canonical\?\.summaryExpanded \?\? canonical\?\.summaryShort/);
  const presentationFnStart = source.indexOf("export function getCoursePresentation");
  const presentationFnEnd = source.indexOf("\n}", presentationFnStart);
  const presentationFnSource = source.slice(presentationFnStart, presentationFnEnd);
  assert.doesNotMatch(presentationFnSource, /\.notes|suggested_action/, "the public presentation model must never read Course.notes as a description source - fpItemToCourse elsewhere in this file legitimately builds the internal notes field, but getCoursePresentation must never touch it");

  const guestAppSource = await readFeatureSource("courses", "events");
  const courseFnStart = guestAppSource.indexOf("function Courses(");
  const courseFnEnd = guestAppSource.indexOf("function courseStatusPillClass");
  const courseFnSource = guestAppSource.slice(courseFnStart, courseFnEnd);
  assert.doesNotMatch(courseFnSource, /item\.notes|\.notes\b/, "the Courses view must never render Course.notes as student-facing copy");
});

test("The course_favorites migration is additive only, and documents the tech_opportunities exclusion consistently with the sibling hackathon migration (issue #120)", async () => {
  const source = await readFile(new URL("../../../infra/postgres/migrations/0008_course_favorites.sql", import.meta.url), "utf8");
  assert.match(source, /alter table public\.courses\s*\r?\n\s*add column if not exists is_favorite boolean not null default false/);
  assert.match(source, /create index if not exists courses_user_favorite_idx/);
  assert.doesNotMatch(source, /\bdrop\s+(table|schema)|truncate\s+table/i);
  assert.match(source, /0007_hackathon_favorites\.sql/, "must reference the sibling migration's identical tech_opportunities decision instead of re-arguing it");
});

test("toggleCourseFavorite is an atomic, user-scoped UPDATE - never touches status/lifecycle columns, and returns null for a row the caller doesn't own (issue #120)", async () => {
  const source = await readFile(new URL("../../../src/features/courses/server/repository.ts", import.meta.url), "utf8");
  const fnSource = source.slice(source.indexOf("export async function toggleCourseFavorite"));
  assert.match(fnSource, /UPDATE public\.courses[\s\S]*SET is_favorite = NOT is_favorite[\s\S]*WHERE id = \$1 AND user_id = \$2/, "must be a single atomic flip, not a read-then-write, and must filter by user_id");
  assert.doesNotMatch(fnSource, /\bstatus\b/, "toggling the heart must never touch the status/lifecycle column");
  assert.match(fnSource, /rows\[0\]\?\.is_favorite \?\? null/);
});

test("toggleCourseFavoriteAction is session-gated through the shared current-user boundary (issue #120, #275)", async () => {
  const source = await readFile(new URL("../../../src/features/courses/server/actions.ts", import.meta.url), "utf8");
  assert.match(source, /"use server"/);
  assert.match(source, /const userId = await getCurrentUserId\(\);/);
  assert.match(source, /toggleCourseFavorite\(userId, parsed\.data\)/, "must scope to the authenticated user, never a client-supplied user id");
});

test("The toggleCourseFavorite store action applies an optimistic flip with rollback and an honest error toast on failure (issue #120)", async () => {
  const source = await readFile(new URL("../../../src/features/courses/client/use-course-actions.ts", import.meta.url), "utf8");
  const start = source.indexOf("toggleCourseFavorite: (id) =>");
  const end = source.indexOf("\n  };", start);
  assert.ok(start !== -1 && end !== -1 && end > start, "toggleCourseFavorite must be its own dedicated action");
  const fn = source.slice(start, end);
  assert.match(fn, /setStore\(/, "must apply an optimistic update");
  assert.match(fn, /toggleCourseFavoriteAction\(id\)\.then\(\(result\) => \{/);
  assert.match(fn, /if \(!result\.error\) return;/);
  assert.match(fn, /toast\.error\(/, "a failed save must surface an honest error toast");
  assert.match(fn, /is_favorite: !nextValue/, "the failure branch must flip is_favorite back, not leave the optimistic value stuck");
});

test("CourseActions declares toggleCourseFavorite inside the feature boundary (issue #120, #275)", async () => {
  const source = await readFile(new URL("../../../src/features/courses/client/use-course-actions.ts", import.meta.url), "utf8");
  assert.match(source, /toggleCourseFavorite: \(id: string\) => void;/);
});

test("fpItemToCourse maps fp_user_content_state.is_favorite through to Course.is_favorite - the exact gap issue #120 identified (fpItemToHackathon already did this)", async () => {
  const source = await readFile(new URL("../../../src/features/courses/presentation/course-presentation.ts", import.meta.url), "utf8");
  const fnStart = source.indexOf("export function fpItemToCourse(item: FpCatalogItem): Course {");
  const fnEnd = source.indexOf("export function resolveCourseById");
  const fnSource = source.slice(fnStart, fnEnd);
  assert.match(fnSource, /is_favorite: item\.is_favorite \?\? false,/);
});

test("The heart control appears in the course card and the detail page, both driven by the same canToggleCourseFavorite/toggleCourseFavoriteFor helpers (issue #120, extended by the owner-reported follow-up to #135)", async () => {
  const source = await readFeatureSource("courses", "events");
  assert.match(source, /export function canToggleCourseFavorite\(item: Course\): boolean/);
  assert.match(source, /export function toggleCourseFavoriteFor\(item: Course, actions: CoursesActions\)/);
  const heartSites = source.match(/toggleCourseFavoriteFor\((featuredCourse|item), actions\)/g) ?? [];
  assert.equal(heartSites.length, 3, "the grid card, the featured card and the detail panel all call the same dispatcher - issue #160 adds the featured hero; the detail favourite renders once, in the side panel");
});

test("tech_opportunities-sourced courses are excluded from favoriting, mirroring the identical hackathon decision (issue #120)", async () => {
  const source = await readFeatureSource("courses", "events");
  const fnStart = source.indexOf("function canToggleCourseFavorite");
  const fnSource = source.slice(fnStart, source.indexOf("function toggleCourseFavoriteFor"));
  assert.match(fnSource, /sourceTable === "tech_opportunities"\) return false/);
});

test("Favoriting a course is wired through a distinct action from completion/archival - completeCourse and updateCourse's callers never flip is_favorite as a side effect (issue #120)", async () => {
  const source = await readFile(new URL("../../../src/features/courses/client/use-course-actions.ts", import.meta.url), "utf8");
  const completeFnStart = source.indexOf("completeCourse: async (course)");
  const completeFnEnd = source.indexOf("toggleCourseFavorite: (id)");
  const completeFn = source.slice(completeFnStart, completeFnEnd);
  assert.doesNotMatch(completeFn, /is_favorite/, "completing/archiving a course must never read or write is_favorite - the two concepts stay independent");
});

test("Guardados is a real heart-driven filter tab in Courses, independent of and additional to Total/Empezados/Próx. inicio (issue #120)", async () => {
  const source = await readFeatureSource("courses", "events");
  const coursesFnStart = source.indexOf("function Courses(");
  const coursesFnEnd = source.indexOf("function courseStatusPillClass");
  const fnSource = source.slice(coursesFnStart, coursesFnEnd);

  assert.match(fnSource, /useState<"total" \| "empezados" \| "proximos" \| "guardados">/);
  assert.match(fnSource, /const guardados = useMemo\(\(\) => sorted\.filter\(\(c\) => c\.is_favorite\), \[sorted\]\);/);
  assert.match(fnSource, /viewTab === "guardados" \? guardados/);
  assert.match(fnSource, /\{ id: "guardados", label: "Guardados", count: guardados\.length \}/, "the tab must be a real filter tab with a live count");
});

test("Course favorite state survives a reload - serializeCourses passes the DB row through unfiltered, it never strips is_favorite before it reaches the client store (issue #120)", async () => {
  const source = await readFile(new URL("../../../src/lib/data.ts", import.meta.url), "utf8");
  const fnStart = source.indexOf("function serializeCourses");
  const fnEnd = source.indexOf("function serializeHackathons");
  const fnSource = source.slice(fnStart, fnEnd);
  assert.match(fnSource, /\.\.\.course,/, "must spread the full DB row (which now includes is_favorite) rather than picking individual fields");
});

test("CourseDetailPage resolves the item via the already user/cycle-scoped global store and calls notFound() instead of querying by a client-supplied id", async () => {
  const source = await readFile(new URL("../../../src/app/(dashboard)/courses/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(source, /const store = \(await getGlobalStore\(\)\) as unknown as Store;/, "must reuse the session-authenticated, cache()-deduped global store - never a second, independently-authorized query");
  assert.match(source, /resolveCourseById\(id, store\.courses, store\.techOpportunities, store\.fpContent\)/);
  assert.match(source, /if \(!item\) notFound\(\);/, "an id outside this user's authorized catalogue must 404, not render an empty/broken page");
});

test("CourseDetailView shows an honest not-found state with a way back when the id doesn't resolve, and never renders item.notes directly", async () => {
  const source = await readFeatureSource("courses", "events");
  const fnStart = source.indexOf("export function CourseDetailView");
  const fnEnd = source.indexOf("function Hackathons(");
  const fnSource = source.slice(fnStart, fnEnd);

  assert.match(fnSource, /if \(!item\) \{/);
  assert.match(fnSource, /Ya no podemos mostrar este curso/);
  assert.match(fnSource, /<Link href="\/courses" className="al-course-empty-btn">Volver a Cursos<\/Link>/);
  assert.doesNotMatch(fnSource, /\{item\.notes\}/, "notes must never be interpolated directly into the page");
  assert.match(fnSource, /const presentation = getCoursePresentation\(item\);/);
});

test("The course detail page's official source link is gated by isSafeHttpUrl and the heart control reuses the exact shared dispatcher, same as the card", async () => {
  const source = await readFeatureSource("courses", "events");
  const fnStart = source.indexOf("export function CourseDetailView");
  const fnEnd = source.indexOf("function Hackathons(");
  const fnSource = source.slice(fnStart, fnEnd);
  assert.match(fnSource, /\{isSafeHttpUrl\(presentation\.sourceUrl\) && \(/);
  assert.match(fnSource, /rel="noopener noreferrer"/);
  assert.match(fnSource, /onClick=\{\(\) => toggleCourseFavoriteFor\(item, actions\)\}/);
});

test("Archivado and Guardado stay fully independent for courses: is_favorite never gates the Activos/Archivados split, and completing/archiving never touches is_favorite (confirms the existing #120 guarantee the owner asked to double check)", async () => {
  const source = await readFeatureSource("courses", "events");

  const archivedFnStart = source.indexOf('function isCourseArchived(course: Pick<Course, "status">) {');
  const archivedFnEnd = source.indexOf("\n}", archivedFnStart);
  const archivedFnSource = source.slice(archivedFnStart, archivedFnEnd);
  assert.doesNotMatch(archivedFnSource, /is_favorite/, "archived status must be derived purely from course.status, never from is_favorite");
  assert.match(archivedFnSource, /course\.status === "terminado" \|\| course\.status === "descartado"/, "a course becomes archived when the student marks it Terminado (or Descartado) - the same action, not a separate one");

  const coursesFnStart = source.indexOf("function Courses(");
  const coursesFnEnd = source.indexOf("function courseStatusPillClass");
  const coursesFnSource = source.slice(coursesFnStart, coursesFnEnd);
  assert.match(coursesFnSource, /const guardados = useMemo\(\(\) => sorted\.filter\(\(c\) => c\.is_favorite\), \[sorted\]\);/, "Guardados is driven purely by is_favorite, independent of the Terminado-driven Archivados split");

  const storeSource = await readFile(new URL("../../../src/features/courses/client/use-course-actions.ts", import.meta.url), "utf8");
  const completeFnStart = storeSource.indexOf("completeCourse: async (course)");
  const completeFnEnd = storeSource.indexOf("toggleCourseFavorite: (id)");
  const completeFn = storeSource.slice(completeFnStart, completeFnEnd);
  assert.doesNotMatch(completeFn, /is_favorite/, "marking a course Terminado (which archives it) must never read or write is_favorite");
});

test("Cursos merges its stats and status tabs into one clickable row (Total / Empezados / Próx. inicio / Guardados); finished courses stay reachable via the Estado filter, and no 'Terminado'/'Archivados' tab survives", async () => {
  const source = await readFeatureSource("courses", "events");
  const coursesFnStart = source.indexOf("function Courses(");
  const coursesFnEnd = source.indexOf("function courseStatusPillClass");
  const fnSource = source.slice(coursesFnStart, coursesFnEnd);

  assert.match(fnSource, /useState<"total" \| "empezados" \| "proximos" \| "guardados">/);
  assert.match(fnSource, /\{ id: "total", label: "Total", count: total\.length \}/);
  assert.match(fnSource, /\{ id: "empezados", label: "Empezados", count: empezados\.length \}/);
  assert.match(fnSource, /\{ id: "proximos", label: "Próx\. inicio", count: proximos\.length \}/);
  assert.match(fnSource, /\{ id: "guardados", label: "Guardados", count: guardados\.length \}/);
  assert.doesNotMatch(fnSource, /label: "Terminado"/, "Terminado is no longer a tab");
  assert.doesNotMatch(fnSource, /label: "Archivados"/);
  assert.match(fnSource, /\["terminado", "Terminado"\]/, "finished courses must stay filterable via the Estado control");
  // Empezados / Próx. inicio are subsets of Total, so their counts stay coherent with it.
  assert.match(fnSource, /const empezados = useMemo\(\(\) => total\.filter/);
  assert.match(fnSource, /return total\.filter\(\(c\) => isWithinUpcomingWindow\(/);
});

test("Phones: Cursos / Eventos y retos pull the control strip up under the header so the featured card is not fully below the fold - a specificity-matched globals rule, not a plain class (owner-reported follow-up, issue #189)", async () => {
  const [guestApp, globalStyles] = await Promise.all([
    readFeatureSource("courses", "events"),
    readFile(new URL("../../../src/app/globals.css", import.meta.url), "utf8"),
  ]);

  const courses = guestApp.slice(guestApp.indexOf("function Courses("), guestApp.indexOf("function courseStatusPillClass"));
  const hackathons = guestApp.slice(guestApp.indexOf("function Hackathons("), guestApp.indexOf("function HackathonsEmptyState"));
  assert.match(courses, /<div className="al-catalog-view space-y-4">/);
  assert.match(hackathons, /<div className="al-catalog-view space-y-4">/);

  // The override must tie Tailwind's `.space-y-6 > :not([hidden]) ~ :not([hidden])`
  // (0,0,3,0) and win on source order - a bare `.al-catalog-view` rule would lose.
  const mobileBlock = globalStyles.slice(globalStyles.indexOf("@media (max-width: 640px) {", globalStyles.indexOf(".al-page-header-subtitle")));
  assert.match(mobileBlock, /\.space-y-6 > \.al-page-header ~ \.al-catalog-view \{\s*margin-top: -\d+px;/);
});
