// Migrated mechanically from tests/security-boundaries.test.mjs for issue #274.
// Source-level assertions temporarily protect a Next.js, browser, or database boundary that the plain Node runner cannot execute; replace them when the corresponding integration harness exists.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readFeatureSource, readProductFeatureSources } from "../../support/feature-sources.mjs";

test("The authenticated student tree owns exactly one store provider (issue #90)", async () => {
  const [guestAppSource, guestStoreSource, storedGuestAppSource, dashboardClientSource, layoutSource] = await Promise.all([
    readProductFeatureSources(),
    readFile(new URL("../../../src/shared/store/application-store.tsx", import.meta.url), "utf8"),
    Promise.resolve(""),
    readFile(new URL("../../../src/components/dashboard/dashboard-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../src/components/private-app-layout.tsx", import.meta.url), "utf8"),
  ]);

  // guest-app.tsx must not define its own context/provider/mutations anymore -
  // it consumes the canonical shared store provider.
  assert.doesNotMatch(guestAppSource, /createContext/);
  assert.doesNotMatch(guestAppSource, /export function StoreProvider/);
  assert.doesNotMatch(guestAppSource, /export function useStore/);
  assert.match(guestAppSource, /import \{ useApplicationStore \} from "@\/shared\/store\/application-store";/);

  // application-store.tsx is the sole canonical data container. Product
  // mutations are feature-owned hooks, not methods on this shared context.
  assert.match(guestStoreSource, /export function ApplicationStoreProvider/);
  assert.match(guestStoreSource, /export function useApplicationStore/);
  assert.doesNotMatch(guestStoreSource, /server\/actions|toast\./);

  // Only the layout mounts a StoreProvider; StoredGuestApp and DashboardClient
  // are pure consumers of the ambient context, not additional mount points.
  assert.match(layoutSource, /<ApplicationStoreProvider initialStore=\{store\}>/);
  assert.doesNotMatch(storedGuestAppSource, /ApplicationStoreProvider/);
  assert.doesNotMatch(dashboardClientSource, /ApplicationStoreProvider/);
});

test("The merged store fetch loads every section with fail-soft handling (issue #90)", async () => {
  const dataSource = await readFile(new URL("../../../src/lib/data.ts", import.meta.url), "utf8");

  // getShellStore/getDashboardStore no longer exist as separate, nested fetches.
  assert.doesNotMatch(dataSource, /export const getShellStore/);
  assert.doesNotMatch(dataSource, /export async function getDashboardStore/);
  assert.match(dataSource, /export const getGlobalStore = cache\(async \(\) => \{/);

  for (const section of [
    'loadStoreSection\\("tasks"',
    'loadStoreSection\\("courses"',
    'loadStoreSection\\("hackathons"',
    'loadStoreSection\\("opportunities", getAllTechOpportunities',
    'loadStoreSection\\("opportunities", getFpContentForProfile',
    'loadStoreSection\\("companies", getCompaniesByCycleGroup',
    'loadStoreSection\\("companies", getFavoriteCompanyIds',
    'loadStoreSection\\("roadmap"',
  ]) {
    assert.match(dataSource, new RegExp(section), `missing fail-soft wrapping for ${section}`);
  }
});

test("The desktop navigation provides the branded expanded sidebar and persistent collapsed rail (issue #178)", async () => {
  const [sidebarSource, navModelSource, layoutSource, userMenuSource] = await Promise.all([
    readFile(new URL("../../../src/components/app-sidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../src/components/nav-destinations.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../src/components/private-app-layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../src/components/auth/user-menu.tsx", import.meta.url), "utf8"),
  ]);

  // The sidebar renders the one shared destination model - it does not keep
  // its own copy of the groups, labels, routes or the active-route predicate.
  assert.match(sidebarSource, /import \{ NAV_GROUPS, isNavRouteActive \} from "@\/components\/nav-destinations"/);
  assert.match(sidebarSource, /NAV_GROUPS\.map\(/);
  assert.doesNotMatch(sidebarSource, /const NAV_GROUPS =/, "the desktop navigation must not re-declare the shared model");
  for (const group of ["Principal", "Comunicación", "Aprendizaje"]) {
    assert.match(navModelSource, new RegExp(`label: "${group}"`), `missing navigation group: ${group}`);
  }
  for (const route of ["/dashboard", "/roadmap", "/tasks", "/bloc", "/noticias", "/work", "/courses", "/hackathons", "/calendar"]) {
    assert.match(navModelSource, new RegExp(`href: "${route}"`), `missing navigation route: ${route}`);
  }

  assert.match(sidebarSource, /collapsed \? "w-\[76px\]" : "w-\[272px\]"/);
  // The collapsed rail keeps the branded symbol and the expanded rail the
  // full horizontal lockup. Both marks stay mounted and are cross-faded on
  // `collapsed` so the header never reflows while the rail width animates.
  assert.match(sidebarSource, /src="\/assets\/al_lio_logo_horizontal\.png"/);
  assert.match(sidebarSource, /src="\/assets\/al_lio_symbol\.png"/);
  assert.match(sidebarSource, /collapsed \? "opacity-0" : "opacity-100"/);
  assert.match(sidebarSource, /collapsed \? "opacity-100" : "opacity-0"/);
  assert.match(sidebarSource, /aria-label=\{collapsed \? "Expandir navegación" : "Contraer navegación"\}/);
  assert.match(sidebarSource, /function SidebarTooltip/);
  assert.match(sidebarSource, /group-hover:visible[\s\S]*group-focus-visible:visible/);
  assert.match(sidebarSource, /isNavRouteActive\(pathname, item\.href\)/, "the sidebar must use the shared active-route predicate");
  assert.match(navModelSource, /pathname === href \|\| \(href !== "\/dashboard" && pathname\.startsWith\(`\$\{href\}\/`\)\)/);
  // The sidebar footer delegates identity to the shared account menu, which
  // is the one place a student reaches their profile or signs out - a
  // deliberate two-step menu, never a standalone logout nav item.
  assert.match(sidebarSource, /<SidebarAccountMenu\b/);
  assert.match(sidebarSource, /className="mt-auto shrink-0 border-t/);
  assert.match(userMenuSource, /href="\/profile"[\s\S]*Ver perfil/);
  assert.match(userMenuSource, /initialsOf\(/);
  assert.match(userMenuSource, /action=\{signOut\}[\s\S]*Cerrar sesión/);
  assert.match(userMenuSource, /role="menuitem"/);

  assert.doesNotMatch(sidebarSource, /signOut|LogOut|Settings|Administración|Cerrar sesión/, "logout and administration must not remain standalone desktop navigation items");
  assert.match(layoutSource, /userName=\{store\.userName\}/);
  assert.match(layoutSource, /cookieStore\.get\("al-lio-sidebar-collapsed"\)/);
  assert.doesNotMatch(layoutSource, /isCurrentUserAdmin/, "the removed admin sidebar item must not keep an unnecessary authorization query in the shared layout");
  assert.match(layoutSource, /<MobileHeaderNavigation \/>/, "mobile navigation remains independent from the desktop sidebar");
});

test("The mobile header menu replaces the bottom navigation without changing the desktop navigation contract (issue #182)", async () => {
  const [mobileSource, navModelSource, layoutSource, headerSource, guestAppSource, tasksSource] = await Promise.all([
    readFile(new URL("../../../src/components/mobile-header-navigation.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../src/components/nav-destinations.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../src/components/private-app-layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../src/components/student-header-actions.tsx", import.meta.url), "utf8"),
    readProductFeatureSources(),
    readFile(new URL("../../../src/features/tasks/client/tasks-view.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(layoutSource, /<MobileHeaderNavigation \/>/);
  assert.doesNotMatch(layoutSource, /BottomNav|pb-20/, "the fixed mobile bottom navigation and its reserved spacing must be removed");
  assert.doesNotMatch(`${guestAppSource}\n${tasksSource}`, /pb-20/, "page-level bottom-nav clearance must not leave empty space behind");
  assert.match(mobileSource, /sticky top-0[\s\S]*md:hidden/);
  assert.match(mobileSource, /src="\/assets\/al_lio_logo_horizontal\.png"/);
  assert.match(mobileSource, /<Menu className=/, "the closed navigation trigger must be icon-only");
  assert.doesNotMatch(mobileSource, />Secciones</, "the icon-only menu trigger must not add a visible text label");
  assert.match(mobileSource, /<StudentHeaderActions size="touch" \/>/, "mobile keeps touch-sized Quick Add and notifications");
  assert.doesNotMatch(headerSource, /Abrir calendario|CalendarDays/, "Calendar belongs in navigation and must not be duplicated in any page-header action cluster");
  assert.match(mobileSource, /h-11 w-11/, "the mobile menu trigger must meet the 44px touch-target minimum");
  assert.match(headerSource, /size === "touch" \? "h-11 w-11" : "h-9 w-9"/, "mobile actions must use 44px touch targets without enlarging desktop controls");
  assert.match(mobileSource, /className="mr-2\.5"/, "navigation must be visibly separated from the action cluster");
  assert.match(mobileSource, /open && "border-\[#efb49c\] bg-\[#fdf0ea\] text-\[#d65327\]"/, "the open menu trigger must keep a clear terracotta state");

  // /profile is reached through the shared account menu at the foot of the
  // sheet (issue #256), which also carries the deliberate two-step sign-out.
  assert.match(mobileSource, /<MobileAccountMenu[\s\S]*onNavigate=\{\(\) => setOpen\(false\)\}/);

  // The sheet renders the one shared destination model, in the same order the
  // sidebar uses - it keeps no parallel copy of the routes, labels or groups.
  assert.match(mobileSource, /import \{ NAV_GROUPS, isNavRouteActive \} from "@\/components\/nav-destinations"/);
  assert.match(mobileSource, /NAV_GROUPS/);
  assert.doesNotMatch(mobileSource, /MAIN_ITEMS|COMMUNICATION_ITEMS|LEARNING_ITEMS/, "the mobile menu must not re-declare its own destination arrays");
  for (const route of ["/dashboard", "/roadmap", "/tasks", "/bloc", "/noticias", "/work", "/courses", "/hackathons", "/calendar"]) {
    assert.match(navModelSource, new RegExp(`href: "${route}"`), `missing navigation route: ${route}`);
  }
  assert.match(navModelSource, /"\/profile"/, "the account route stays reachable through NAV_ACTION_ROUTES");
  for (const group of ["Principal", "Comunicación", "Aprendizaje"]) {
    assert.match(navModelSource, new RegExp(`label: "${group}"`), `missing navigation group: ${group}`);
  }

  assert.match(mobileSource, /aria-expanded=\{open\}/);
  assert.match(mobileSource, /aria-controls=\{menuId\}/);
  assert.match(mobileSource, /aria-current=\{active \? "page" : undefined\}/);
  assert.match(mobileSource, /event\.key !== "Escape"/);
  assert.match(mobileSource, /addEventListener\("pointerdown", onPointerDown\)/);
  assert.match(mobileSource, /document\.body\.style\.overflow = "hidden"/);
  assert.match(mobileSource, /firstLinkRef\.current\?\.focus\(\)/);
  assert.match(mobileSource, /triggerRef\.current\?\.focus\(\)/);
  assert.match(mobileSource, /isNavRouteActive\(pathname, item\.href\)/, "the mobile menu must use the shared active-route predicate");
  assert.match(navModelSource, /pathname === href \|\| \(href !== "\/dashboard" && pathname\.startsWith\(`\$\{href\}\/`\)\)/);
});

test("Quick Add and Notifications form one shared header action group on mobile and desktop, while Calendar lives only in navigation (issue #91, issue #129, issue #182)", async () => {
  const [headerSource, navModelSource, layoutSource, mobileSource, guestAppSource, quickAddSource, dashboardClientSource, dashboardGreetingSource] = await Promise.all([
    readFile(new URL("../../../src/components/student-header-actions.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../src/components/nav-destinations.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../src/components/private-app-layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../src/components/mobile-header-navigation.tsx", import.meta.url), "utf8"),
    readProductFeatureSources(),
    readFile(new URL("../../../src/components/quick-add.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../src/components/dashboard/dashboard-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../src/components/dashboard/dashboard-greeting.tsx", import.meta.url), "utf8"),
  ]);

  // Shared order: Quick Add, then Notifications. Calendar is reachable from
  // the mobile menu and desktop sidebar instead of being duplicated here.
  const quickAddIdx = headerSource.indexOf('aria-label="Añadir rápido"');
  const notifIdx = headerSource.search(/aria-label=\{alerts\.length/);
  assert.ok(quickAddIdx > -1 && notifIdx > quickAddIdx, "expected Quick Add followed by Notifications");
  assert.doesNotMatch(headerSource, /aria-label="Abrir calendario"|CalendarDays/);

  // The action cluster reuses the shared allowlist (NAV_ACTION_ROUTES) and the
  // shared active-route predicate - it keeps no parallel route array of its own.
  assert.match(headerSource, /import \{ NAV_ACTION_ROUTES, isNavRouteActive \} from "@\/components\/nav-destinations"/);
  assert.match(headerSource, /NAV_ACTION_ROUTES\.some\(\(route\) => isNavRouteActive\(pathname, route\)\)/);
  assert.doesNotMatch(headerSource, /const VISIBLE_ROUTES =/, "the header must not re-declare its own visible-route list");
  for (const route of ["/dashboard", "/roadmap", "/tasks", "/bloc", "/noticias", "/work", "/courses", "/hackathons", "/calendar", "/profile"]) {
    assert.match(navModelSource, new RegExp(`"${route}"|href: "${route}"`), `missing route in the shared allowlist: ${route}`);
  }
  // Admin-only /settings is not a navigation destination or an action route.
  assert.doesNotMatch(navModelSource, /"\/settings"/);

  // issue #129 and #182: the layout owns neither a detached desktop action row
  // nor a second mobile copy. The mobile shell composes the shared action group
  // once at touch size; desktop page headers keep the compact default group.
  const layoutMounts = (layoutSource.match(/<StudentHeaderActions\b/g) ?? []).length;
  const mobileMounts = (mobileSource.match(/<StudentHeaderActions size="touch" \/>/g) ?? []).length;
  assert.equal(layoutMounts, 0, "the layout must delegate the complete mobile header to MobileHeaderNavigation");
  assert.equal(mobileMounts, 1, "expected exactly one touch-sized action group in the mobile header");

  // The old per-view/per-route duplicates are gone: no more BrandHeaderActions row,
  // no more floating QuickAdd mount, no more local NotificationBell in guest-app.tsx.
  assert.doesNotMatch(guestAppSource, /BrandHeaderActions/);
  assert.doesNotMatch(guestAppSource, /<QuickAdd\b/);
  assert.doesNotMatch(guestAppSource, /function NotificationBell/);
  assert.doesNotMatch(dashboardClientSource, /MobileHeaderActions|headerActions/);
  assert.doesNotMatch(dashboardGreetingSource, /actions:/);

  // QuickAdd itself no longer renders its own always-on floating trigger.
  assert.doesNotMatch(quickAddSource, /aria-label="Añadir rápido"/);
  assert.match(quickAddSource, /export function QuickAdd\(\{ open, setOpen, actions \}: QuickAddProps\)/);
});

test("Each page's own header mounts StudentHeaderActions exactly once for its desktop actions slot - relocated, not lost or duplicated (issue #129)", async () => {
  const files = [
    "../../../src/components/dashboard/dashboard-greeting.tsx",
    "../../../src/features/learning/client/competencies-view.tsx",
    "../../../src/features/tasks/client/tasks-view.tsx",
    "../../../src/features/news/client/news-view.tsx",
    "../../../src/features/account/client/profile-form.tsx",
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    const mounts = (source.match(/<StudentHeaderActions \/>/g) ?? []).length;
    assert.equal(mounts, 1, `${file} should mount StudentHeaderActions exactly once`);
  }
  const [featurePage, calendar, courses, events] = await Promise.all([
    readFile(new URL("../../../src/shared/ui/feature-page.tsx", import.meta.url), "utf8"),
    readFeatureSource("calendar"),
    readFeatureSource("courses"),
    readFeatureSource("events"),
  ]);
  assert.equal((featurePage.match(/<StudentHeaderActions \/>/g) ?? []).length, 1, "the shared feature header owns one desktop action cluster");
  assert.equal((calendar.match(/<StudentHeaderActions \/>/g) ?? []).length, 1, "Calendar owns one desktop action cluster");
  assert.equal((courses.match(/<StudentHeaderActions \/>/g) ?? []).length, 2, "Course detail has mutually exclusive regular and not-found headers");
  assert.equal((events.match(/<StudentHeaderActions \/>/g) ?? []).length, 2, "Event detail has mutually exclusive regular and not-found headers");
});

test("The notifications popover meets the accessibility requirements (issue #91)", async () => {
  const headerSource = await readFile(new URL("../../../src/components/student-header-actions.tsx", import.meta.url), "utf8");

  assert.match(headerSource, /aria-expanded=\{open\}/);
  assert.match(headerSource, /aria-controls=\{panelId\}/);
  assert.match(headerSource, /event\.key !== "Escape"/);
  assert.match(headerSource, /triggerRef\.current\?\.focus\(\)/);
  assert.match(headerSource, /addEventListener\("pointerdown", onPointerDown\)/);
  assert.match(headerSource, /closeButtonRef\.current\?\.focus\(\)/);
});

test("PageHeader renders exactly one h1 with eyebrow/title/subtitle/actions slots, and never hardcodes the display font (issue #129)", async () => {
  const source = await readFile(new URL("../../../src/components/page-header.tsx", import.meta.url), "utf8");
  const h1Matches = source.match(/<h1[ >]/g) ?? [];
  assert.equal(h1Matches.length, 1, "the shared header primitive must render exactly one h1");
  assert.match(source, /al-page-header-eyebrow/);
  assert.match(source, /al-page-header-subtitle/);
  assert.doesNotMatch(source, /font-barlow/, "product headings use Inter (the default body font), not the display font");
});

test("PageHeader anchors its actions slot to the top of the text block (items-start), not its bottom - items-end tied the actions' position to subtitle length/wrapping, which differs per page and made the same icon cluster land at a different height on every route (issue #129 follow-up)", async () => {
  const source = await readFile(new URL("../../../src/components/page-header.tsx", import.meta.url), "utf8");
  assert.match(source, /md:items-start/);
  assert.doesNotMatch(source, /md:items-end|md:items-center/, "the actions slot must anchor to the eyebrow line - the one element whose size never varies by page - not to a page-dependent midpoint or bottom");
  assert.match(source, /flex shrink-0 flex-wrap items-center gap-2/, "the actions cluster must never be compressed by a long title/subtitle next to it");
});

test("The shared page-header tokens in globals.css style the eyebrow/title/subtitle with Inter (the default body font), not --font-barlow (issue #129)", async () => {
  const source = await readFile(new URL("../../../src/app/globals.css", import.meta.url), "utf8");
  // #362: the header consumes the semantic text contract; contrast is measured
  // in tests/architecture/design-system/visual-token-contract.test.mjs.
  assert.match(source, /\.al-page-header-title \{[^}]*color: var\(--al-text-strong\)/, "the title must read the strong text token");
  assert.match(source, /\.al-page-header-eyebrow \{[^}]*color: var\(--al-text-brand-strong\)/, "the eyebrow must read the accessible brand text token");
  assert.match(source, /\.al-page-header-subtitle \{[^}]*color: var\(--al-text-muted\)/, "the subtitle must read the muted text token");
  assert.doesNotMatch(source, /\.al-page-header[^}]*font-barlow/);
});

test("The dashboard layout keeps desktop actions inside each page header and delegates the new sticky mobile header to one component (issue #129, issue #182)", async () => {
  const [layoutSource, mobileSource] = await Promise.all([
    readFile(new URL("../../../src/components/private-app-layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../src/components/mobile-header-navigation.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(layoutSource, /pt-6 md:flex/, "the old standalone desktop actions row (the source of the excessive top gap) must be removed");
  assert.doesNotMatch(layoutSource, /StudentHeaderActions/, "the layout must not recreate the action cluster outside the mobile header component");
  assert.match(layoutSource, /<MobileHeaderNavigation \/>/);
  assert.match(mobileSource, /sticky top-0[\s\S]*md:hidden/, "the replacement top navigation must remain mobile-only and sticky");
  assert.doesNotMatch(layoutSource, /pb-safe|pb-20/, "bottom-navigation spacing must not leave an empty mobile footer");
});

test("Every first-level authenticated route renders the shared PageHeader instead of a bespoke ad-hoc heading (issue #129)", async () => {
  const routes = [
    { file: "../../../src/components/dashboard/dashboard-greeting.tsx", label: "Inicio" },
    { file: "../../../src/features/learning/client/competencies-view.tsx", label: "Competencias" },
    { file: "../../../src/features/tasks/client/tasks-view.tsx", label: "Tareas" },
    { file: "../../../src/features/news/client/news-view.tsx", label: "Noticias" },
    { file: "../../../src/components/calendar/app-calendar.tsx", label: "Calendario" },
    { file: "../../../src/features/account/client/profile-form.tsx", label: "Perfil" },
  ];
  for (const route of routes) {
    const source = await readFile(new URL(route.file, import.meta.url), "utf8");
    assert.match(source, /from "@\/components\/page-header"/, `${route.label} must import the shared PageHeader`);
    assert.match(source, /<PageHeader/, `${route.label} must render PageHeader`);
  }

  for (const feature of ["work", "courses", "events", "bloc"]) {
    const source = await readFeatureSource(feature);
    assert.match(source, /from "@\/shared\/ui\/feature-page"/);
    assert.match(source, /<FeaturePage/);
  }
});

test("GuestApp's shared header gives Trabajo, Cursos, Eventos y retos and Bloc de notas a real eyebrow and subtitle, not just a bare view-name h1 (issue #129)", async () => {
  for (const [feature, title] of [["work", "Trabajo"], ["courses", "Cursos"], ["events", "Eventos y retos"], ["bloc", "Bloc de notas"]]) {
    const source = await readFeatureSource(feature);
    assert.match(source, /<FeaturePage/);
    assert.match(source, new RegExp(`title="${title}"`));
    assert.match(source, /eyebrow="[^"]+"/);
    assert.match(source, /subtitle="[^"]+"/);
  }
});

test("Perfil's title switches from the Barlow display font to the shared Inter page header, and gains an eyebrow (issue #129)", async () => {
  const source = await readFile(new URL("../../../src/features/account/client/profile-form.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /al-profile-title|font-barlow/, "the old Barlow-styled title must be gone");
  assert.match(source, /eyebrow="Tu cuenta"/);
});

test("Profile and Saved size themselves from the available dashboard width and remain operable on phones (issue #188)", async () => {
  const [profile, saved] = await Promise.all([
    readFile(new URL("../../../src/features/account/client/profile-form.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../src/features/account/client/saved-hub.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(profile, /\.al-profile-shell \{[\s\S]*min-width: 0;[\s\S]*container-type: inline-size;/);
  assert.match(profile, /\.al-profile-grid \{[\s\S]*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(profile, /@container \(min-width: 700px\)[\s\S]*grid-template-columns: minmax\(0, 1\.4fr\) minmax\(240px, 1fr\)/);
  assert.match(profile, /@media \(max-width: 480px\)[\s\S]*\.al-profile-card,[\s\S]*\.al-profile-stats-card \{[\s\S]*padding: 16px;/);
  assert.match(profile, /\.al-profile-actions \{ align-items: stretch; flex-direction: column; \}/);
  assert.match(profile, /\.al-profile-submit \{ width: 100%; \}/);

  assert.match(saved, /grid min-w-0 gap-4 \[grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,18rem\),1fr\)\)\]/);
  assert.doesNotMatch(saved, /md:grid-cols-3/, "Saved columns must respond to their container instead of the viewport/sidebar breakpoint");
  assert.match(saved, /flex min-w-0 flex-col/);
  assert.match(saved, /h-11 w-11[\s\S]*sm:h-8 sm:w-8/, "Saved row actions need phone-sized touch targets while remaining compact on desktop");
});

test("Calendario, Noticias and Competencias each compose StudentHeaderActions into their own header instead of relying on a removed shared layout row (issue #129)", async () => {
  const [calendar, noticias, competencies] = await Promise.all([
    readFile(new URL("../../../src/components/calendar/app-calendar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../src/features/news/client/news-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../src/features/learning/client/competencies-view.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(calendar, /headerActions/);
  assert.match(noticias, /StudentHeaderActions/);
  assert.match(competencies, /StudentHeaderActions/);
});

test("Nuevo evento and the Google Calendar status live in the calendar's own month-navigation toolbar; the top header keeps only the global icon cluster and the calendar-navigation Hoy button is gone (owner-reported follow-up, issue #179)", async () => {
  const source = await readFile(new URL("../../../src/components/calendar/app-calendar.tsx", import.meta.url), "utf8");

  const headerStart = source.indexOf("<PageHeader");
  const headerEnd = source.indexOf("/>", headerStart) + 2;
  const pageHeaderJsx = source.slice(headerStart, headerEnd);
  assert.doesNotMatch(pageHeaderJsx, /Nuevo evento/, "the top PageHeader must no longer carry the event-creation button");
  assert.doesNotMatch(pageHeaderJsx, /calendarStatus/, "the Google Calendar status must not render in the top header anymore");
  assert.match(pageHeaderJsx, /\{headerActions\}/, "the global icon cluster must remain there, same as every other page");

  assert.match(source, /statusSlot\?: React\.ReactNode;/, "CalendarHeader needs a dedicated slot for the connection status, distinct from the anchored-popover children prop used by the compact variant");

  // The month-navigation "Hoy" button was removed from both header variants
  // (issue #179) - the month arrows plus the always-visible agenda cover it.
  const headerFn = source.slice(source.indexOf("function CalendarHeader"), source.indexOf("type CalendarMonthGridProps"));
  assert.doesNotMatch(headerFn, />Hoy<\/Button>/, "no calendar-navigation Hoy button in either header variant");
  assert.doesNotMatch(headerFn, /onToday/, "the onToday prop and handler are gone with the button");

  const nonCompactActionsRow = headerFn.slice(headerFn.indexOf('<div className="grid min-w-0 gap-2 sm:flex sm:flex-wrap sm:items-center">'));
  assert.match(nonCompactActionsRow, /\{statusSlot\}[\s\S]*Nuevo evento/, "the status slot and the create button share the toolbar row");

  const calendarViewCall = source.slice(source.indexOf("<CalendarHeader", source.indexOf("export function CalendarView")), source.indexOf("<CalendarHeader", source.indexOf("export function CalendarView")) + 300);
  assert.match(calendarViewCall, /onCreate=\{\(\) => setNewEventOpen\(true\)\}/, "must reuse the exact same handler the old header button called, not a new one");
  assert.match(calendarViewCall, /statusSlot=\{calendarStatus\}/);

  const guestApp = await readProductFeatureSources();
  assert.match(guestApp, /headerActions=\{<StudentHeaderActions \/>\}/);
  assert.match(guestApp, /calendarStatus=\{<GoogleCalendarStatusControl \/>\}/);
});

test("GoogleCalendarStatusControl's connected/disconnected/loading states are visually distinct (green when connected, inviting when not) with unchanged underlying logic - same state variables, same effect, same disconnect handler (owner-reported follow-up)", async () => {
  const source = await readProductFeatureSources();
  const fnStart = source.indexOf("function GoogleCalendarStatusControl");
  const fnEnd = source.indexOf("function catalogCalendarHref", fnStart);
  const fn = source.slice(fnStart, fnEnd);

  // Logic untouched: same state, same effect endpoint, same disconnect call.
  assert.match(fn, /const \[connected, setConnected\] = useState\(false\);/);
  assert.match(fn, /const \[loading, setLoading\] = useState\(true\);/);
  assert.match(fn, /const \[busy, setBusy\] = useState\(false\);/);
  assert.match(fn, /fetch\("\/api\/google\/calendar\/status", \{ cache: "no-store" \}\)/);
  assert.match(fn, /method: "DELETE"/);

  // Presentation: clearly distinct per state, not just a small dot.
  assert.match(fn, /bg-emerald-50 px-3 text-xs font-bold text-emerald-800/, "connected state must read as green/positive, not generic");
  assert.match(fn, /border-\[#f4b398\] bg-\[#fff7f3\] px-3 text-xs font-bold text-\[#c94f21\]/, "disconnected state must read as an inviting call-to-connect, not generic");
  assert.match(fn, /"Google Calendar conectado"/);
  assert.match(fn, /"Conectar Google Calendar"/);
  assert.doesNotMatch(fn, /hidden sm:inline/, "the status label must always be visible now that it lives in the calendar's own toolbar, not squeezed into a narrow global header");
  // issue #179: a real Google "G", not an ambiguous four-colour square; the label is not clipped.
  assert.match(fn, /function GoogleGlyph/, "the mark is the Google G glyph");
  assert.match(fn, /<GoogleGlyph \/>/);
  assert.doesNotMatch(fn, /grid-cols-2 overflow-hidden rounded-\[3px\]/, "the old four-colour square is gone");
  assert.doesNotMatch(fn, /\btruncate\b/, "the connection label must not be clipped");
});

test("Calendar navigation, integration status and month cells fit mobile widths without changing the desktop month grid (issue #188)", async () => {
  const [calendar, guestApp] = await Promise.all([
    readFile(new URL("../../../src/components/calendar/app-calendar.tsx", import.meta.url), "utf8"),
    readProductFeatureSources(),
  ]);

  assert.match(calendar, /<div className="min-w-0 space-y-5 text-\[#111111\]">/);
  assert.match(calendar, /grid min-w-0 grid-cols-\[44px_44px_minmax\(0,1fr\)\] items-center gap-2 sm:flex/);
  assert.match(calendar, /h-11 w-11[\s\S]*sm:h-9 sm:w-9/);
  assert.match(calendar, /min-w-0 truncate text-base font-semibold sm:ml-1 sm:text-lg/);
  assert.match(calendar, /grid min-w-0 gap-2 sm:flex sm:flex-wrap sm:items-center/);
  assert.match(calendar, /h-11 w-full justify-center rounded-xl px-3 sm:h-9 sm:w-auto/);
  assert.match(calendar, /relative flex h-10 min-w-0 items-center justify-center/);
  assert.match(calendar, /hidden overflow-x-auto border-t border-\[#eee8de\] md:block[\s\S]*variant="full"/);
  assert.match(calendar, /border-t border-\[#eee8de\] p-3 md:hidden[\s\S]*variant="compact"/);

  const statusStart = guestApp.indexOf("function GoogleCalendarStatusControl");
  const statusEnd = guestApp.indexOf("function catalogCalendarHref", statusStart);
  const status = guestApp.slice(statusStart, statusEnd);
  assert.match(status, /h-11 w-full min-w-0[\s\S]*sm:h-9 sm:w-auto/);
  assert.doesNotMatch(status, /whitespace-nowrap rounded-xl/, "Google Calendar labels must be allowed to fit before the desktop breakpoint");
});

test("Calendar events open a detail dialog on click and its action deep-links to the exact item, never a bare list page (issue #179)", async () => {
  const [calendar, events, guestApp, tasksView, tasksPage] = await Promise.all([
    readFile(new URL("../../../src/components/calendar/app-calendar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../src/lib/dashboard/calendar-events.ts", import.meta.url), "utf8"),
    readProductFeatureSources(),
    readFile(new URL("../../../src/features/tasks/client/tasks-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../src/app/(tasks)/tasks/page.tsx", import.meta.url), "utf8"),
  ]);

  // Nothing navigates on the first click: both the pill and the agenda row
  // open the shared dialog for every type, not a <Link>.
  const pill = calendar.slice(calendar.indexOf("function CalendarPill"), calendar.indexOf("function calendarEventEyebrow"));
  const row = calendar.slice(calendar.indexOf("function CalendarAgendaRow"), calendar.indexOf("function CalendarPill"));
  for (const fragment of [pill, row]) {
    assert.match(fragment, /onClick=\{\(\) => setDetailOpen\(true\)\}/);
    assert.match(fragment, /<CalendarEventDetailDialog event=\{event\} onClose/);
    assert.doesNotMatch(fragment, /<Link href=\{event\.href\}/, "the event itself must not be a navigating link");
  }

  // The dialog action resolves per type; Google stays an external link.
  const action = calendar.slice(calendar.indexOf("function calendarEventAction"), calendar.indexOf("function CalendarEventDetailDialog"));
  assert.match(action, /"Abrir tarea"/);
  assert.match(action, /"Ver curso"/);
  assert.match(action, /"Ver evento"/);
  assert.match(action, /event\.type === "google"[\s\S]*?"Ver en Google Calendar"[\s\S]*?external: true/);

  // Real deep links, shared by the calendar page, mini-calendar and alerts.
  assert.match(events, /task: \(id: string\) => `\/tasks\?task=\$\{encodeURIComponent\(id\)\}`/);
  assert.match(events, /course: \(id: string\) => `\/courses\/\$\{encodeURIComponent\(id\)\}`/);
  assert.match(events, /hackathon: \(id: string\) => `\/hackathons\/\$\{encodeURIComponent\(id\)\}`/);
  assert.doesNotMatch(events, /href: "\/tasks"/, "task events must carry the ?task= deep link");
  assert.doesNotMatch(events, /href: "\/courses"/, "course events must carry the detail route");
  assert.doesNotMatch(guestApp.slice(guestApp.indexOf("function getCalendarEvents")), /href: "\/courses"|href: "\/tasks"/, "the /calendar generator must not fall back to list pages");

  // A single task can be opened straight from its id.
  assert.match(tasksView, /useSearchParams/);
  assert.match(tasksView, /searchParams\.get\("task"\)/);
  assert.match(tasksView, /setTaskDialog\(\{ taskId: match\.id, mode: "view" \}\)/);
  assert.match(tasksView, /router\.replace\(pathname/, "the ?task= param is dropped once consumed");
  assert.match(tasksPage, /<Suspense/, "useSearchParams needs a Suspense boundary");
});

test("Competencias' progress card sits inside PageHeader's own actions, glued to the +/calendar/bell icon cluster in the same top row - not stacked below it in its own row leaving an empty gap (owner-reported follow-up)", async () => {
  const source = await readFile(new URL("../../../src/features/learning/client/competencies-view.tsx", import.meta.url), "utf8");

  // The old two-row stack (a dedicated space-y wrapper around PageHeader
  // plus a sibling card row below it) is exactly what left the large,
  // "unprofessional" empty gap under the subtitle. That wrapper must be
  // gone - PageHeader now renders directly, and the card lives inside it.
  assert.doesNotMatch(source, /<div className="space-y-4 border-b/, "the old wrapper that stacked PageHeader and the progress card into two separate rows must be removed");

  const headerStart = source.indexOf("<PageHeader");
  const actionsIdx = source.indexOf("actions={", headerStart);
  const headerEnd = source.indexOf("\n      />", actionsIdx);
  assert.ok(headerStart > -1 && actionsIdx > headerStart && headerEnd > actionsIdx, "PageHeader must declare an actions prop");
  const actionsBlock = source.slice(actionsIdx, headerEnd);

  const cardIdx = actionsBlock.indexOf("bg-[#114b3b]");
  const iconsIdx = actionsBlock.indexOf("<StudentHeaderActions />");
  assert.ok(cardIdx > -1, "the progress card must render inside PageHeader's actions, next to the icon cluster");
  assert.ok(iconsIdx > -1 && iconsIdx > cardIdx, "the progress card must come before StudentHeaderActions in reading order - glued to its left, same top row");

  assert.match(actionsBlock, /Progreso guardado/);
  assert.match(actionsBlock, /\{progress\}%/);
  assert.match(actionsBlock, /shrink-0/, "the card must not be allowed to stretch/shrink oddly when squeezed next to the icon cluster");
});
