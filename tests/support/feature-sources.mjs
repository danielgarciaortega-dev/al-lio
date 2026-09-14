import { readFile } from "node:fs/promises";

const featureFiles = {
  work: [
    // work-feature.tsx first so the `function Work(` slice anchor resolves in
    // it; work-styles.ts (holding `workBrandCss`) then work-portal-search.tsx
    // (holding `WORK_DIACRITICS_PATTERN`, `function ProvinceCombobox(` and
    // `const QuickJobSearchCard = memo(`) come next and adjacent, so the
    // `const workBrandCss` -> `const WORK_DIACRITICS_PATTERN` slice in
    // catalogue-boundaries.test.mjs spans only the CSS string plus the
    // portal-search imports - never the leaf card files.
    "work/client/work-feature.tsx",
    "work/client/work-styles.ts",
    "work/client/work-portal-search.tsx",
    "work/client/work-portal-cards.tsx",
    "work/client/work-candidatura-card.tsx",
    "work/client/work-company-card.tsx",
    "work/client/work-model.ts",
  ],
  tasks: ["tasks/client/tasks-view.tsx"],
  courses: [
    "courses/client/course-catalogue-model.ts",
    "courses/client/courses-filter-controls.tsx",
    "courses/client/courses-catalogue.tsx",
    "courses/client/courses-feature.tsx",
    "courses/client/course-detail-view.tsx",
  ],
  events: [
    // events-feature.tsx first (it holds the EventsFeature wrapper the
    // navigation tests key off). hackathon-dates.ts precedes the catalogue so
    // its helpers never land inside a `CourseDetailView` -> `function
    // Hackathons(` slice; hackathons-catalogue.tsx then hackathon-detail-view.tsx
    // carry the `function Hackathons(` / `RequirementRow` / `HackathonDetailView`
    // slice anchors in the order the lifecycle tests expect; the pure model is
    // concatenated last so it never lands inside a `CourseDetailView` ->
    // `function Hackathons(` slice either.
    "events/client/events-feature.tsx",
    "events/client/events-filter-controls.tsx",
    "events/client/hackathon-dates.ts",
    "events/client/hackathons-catalogue.tsx",
    "events/client/hackathon-detail-view.tsx",
    "events/client/event-catalogue-model.ts",
  ],
  calendar: [
    // google-calendar-status.tsx first, then calendar-event-source.ts, so the
    // `GoogleCalendarStatusControl` -> `catalogCalendarHref` and
    // `getCalendarEvents` -> end-of-concat slices in app-shell.test.mjs still
    // resolve against the same content order they had inside the old
    // calendar-feature.tsx.
    "calendar/client/google-calendar-status.tsx",
    "calendar/client/calendar-event-source.ts",
    "calendar/client/calendar-feature.tsx",
  ],
  resources: ["resources/client/sources-feature.tsx"],
  settings: ["settings/client/settings-feature.tsx"],
  bloc: [
    "bloc/client/bloc-notepad.tsx",
    "bloc/client/bloc-styles.ts",
    "bloc/client/bloc-editor-toolbar.tsx",
    "bloc/client/bloc-note-list.tsx",
    "bloc/client/bloc-note-menus.tsx",
    "bloc/client/bloc-editor-helpers.ts",
    "bloc/client/bloc-export.ts",
    "bloc/client/bloc-persistence.ts",
    "bloc/client/bloc-types.ts",
    "bloc/client/bloc-feature.tsx",
  ],
};

export async function readFeatureSource(...features) {
  const files = features.flatMap((feature) => featureFiles[feature] ?? []);
  return (await Promise.all(
    files.map((file) => readFile(new URL(`../../src/features/${file}`, import.meta.url), "utf8")),
  )).join("\n\n");
}

export function readProductFeatureSources() {
  return readFeatureSource("work", "tasks", "courses", "events", "calendar", "resources", "settings", "bloc");
}
