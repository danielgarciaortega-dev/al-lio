import { existsSync, readFileSync } from "fs";
import { join } from "path";

const root = process.cwd();
const requiredFiles = [
  "src/app/page.tsx",
  "src/app/layout.tsx",
  "src/app/globals.css",
  "src/features/work/index.ts",
  "src/features/courses/index.ts",
  "src/features/events/index.ts",
  "src/features/calendar/index.ts",
  "src/features/bloc/index.ts",
  "src/shared/ui/feature-page.tsx",
  "src/components/calendar/app-calendar.tsx",
  "src/components/quick-add.tsx",
  "public/data/empresas_tech_granada.md",
  "csv/oportunidades_tech_combinado.csv",
  "scripts/import-tech-opportunities.mjs",
  "scripts/audit-schema-code.mjs",
  "scripts/deploy-production.sh",
  "scripts/lib/compose-env-guard.sh",
  "scripts/lib/production-transition-policy.sh",
  "scripts/lib/release-worktree-integrity.sh",
  "scripts/config/production-compose-env-removals.allowlist",
  "scripts/prepare-release-env.sh",
  "scripts/validate-production-transition.sh",
  "src/app/api/version/route.ts",
  "docs/README.md",
  "docs/product/PRODUCT_SPEC.md",
  "docs/architecture/ARCHITECTURE_AND_STACK.md",
  "docs/integrations/INTEGRATIONS_AND_DEEPLINKS.md",
  "docs/integrations/SEED_HACKATHONS.md",
  "docs/operations/DEPLOY_VPS.md",
  "docs/operations/AUTONOMOUS_PRODUCTION_DEPLOY.md",
  "docs/PROJECT_STRUCTURE.md",
  "README.md",
];

const requiredGitignoreEntries = [
  ".next",
  "node_modules",
  ".env",
  ".env*.local",
  ".playwright-mcp",
  "dev-server*.log",
  "_dev_out.txt",
  "_pr_body.md",
];

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exitCode = 1;
}

for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) {
    fail(`Falta el archivo requerido: ${file}`);
  }
}

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const script of ["lint", "typecheck", "check:project", "check:boundaries", "check:authorization-boundaries", "audit:schema", "smoke", "verify:startup", "verify:cheap", "verify:prod", "test", "ci"]) {
  if (!packageJson.scripts?.[script]) {
    fail(`Falta el script npm: ${script}`);
  }
}

const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
for (const entry of requiredGitignoreEntries) {
  if (!gitignore.includes(entry)) {
    fail(`.gitignore no contiene: ${entry}`);
  }
}

const readme = readFileSync(join(root, "README.md"), "utf8");
for (const text of ["AL-LÍO", "npm run verify:startup", "docs/README.md"]) {
  if (!readme.includes(text)) {
    fail(`README.md deberia mencionar: ${text}`);
  }
}

const blocTypes = readFileSync(join(root, "src/features/bloc/client/bloc-types.ts"), "utf8");
const settingsFeature = readFileSync(join(root, "src/features/settings/client/settings-feature.tsx"), "utf8");
const coursesCatalogue = readFileSync(join(root, "src/features/courses/client/courses-catalogue.tsx"), "utf8");
if (!blocTypes.includes("techlife.bloc.D1OS.v1")) fail("Bloc debe conservar la clave de migracion local heredada");
if (!settingsFeature.includes("techlife.app.settings.D1OS.v1")) fail("Settings debe conservar la clave local heredada");
if (!coursesCatalogue.includes("techOpportunities")) fail("Courses debe combinar el catalogo de oportunidades");

const applicationStore = readFileSync(join(root, "src/shared/store/application-store.tsx"), "utf8");
for (const text of ["export function ApplicationStoreProvider", "export function useApplicationStore"]) {
  if (!applicationStore.includes(text)) {
    fail(`shared/store/application-store.tsx deberia contener: ${text}`);
  }
}
if (applicationStore.includes("server/actions") || applicationStore.includes("toast.")) {
  fail("El store compartido debe ser un contenedor de datos sin mutaciones de producto");
}

if (packageJson.scripts?.dev !== "next dev -p 3000") {
  fail('El script dev debe fijar el puerto 3000 para impedir dos instancias Next sobre la misma carpeta .next');
}

const quickAdd = readFileSync(join(root, "src/components/quick-add.tsx"), "utf8");
for (const text of ["Podrás planificarla con fecha", "Tarea", "Curso", "Reto"]) {
  if (!quickAdd.includes(text)) {
    fail(`components/quick-add.tsx deberia contener: ${text}`);
  }
}

const appCalendar = readFileSync(join(root, "src/components/calendar/app-calendar.tsx"), "utf8");
for (const text of ["CalendarHeader", "CalendarMonthGrid", "TaskCalendar", "CalendarView"]) {
  if (!appCalendar.includes(text)) {
    fail(`components/calendar/app-calendar.tsx deberia contener: ${text}`);
  }
}

const taskActions = readFileSync(join(root, "src/features/tasks/server/actions.ts"), "utf8");
if (taskActions.includes('revalidatePath("/dashboard")')) {
  fail('Las acciones de Tasks no deben revalidar "/dashboard"; rompe foco y refresca el layout completo');
}

const companiesMd = readFileSync(join(root, "public/data/empresas_tech_granada.md"), "utf8");
const jsonMatch = companiesMd.match(/```json\s*([\s\S]*?)```/);
if (!jsonMatch) {
  fail("No se ha encontrado bloque JSON en public/data/empresas_tech_granada.md");
} else {
  try {
    const companies = JSON.parse(jsonMatch[1]);
    if (!Array.isArray(companies) || companies.length < 60) {
      fail("El seed de empresas deberia contener al menos 60 empresas");
    }
  } catch (error) {
    fail(`El JSON de empresas no es valido: ${error.message}`);
  }
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log("OK: chequeo de estructura del proyecto completado.");
