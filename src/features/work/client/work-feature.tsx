"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Building2, Heart, Plus, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { type JobPlatform } from "@/lib/deeplinks/job-search-urls";
import { getQuickSearchesAction, saveQuickSearchAction, type SavedQuickSearch } from "@/features/work/server/actions";
import { toast } from "sonner";
import type { JobApplication, ApplicationStatus } from "@/lib/job-radar/types";
import { APPLICATION_STATUSES, STATUS_LABELS } from "@/lib/job-radar/types";
import type { VerifiedJob, VerifiedJobPrivateAction } from "@/lib/jobs/types";
import { VerifiedJobsView } from "@/components/jobs/verified-jobs-view";
import { useWorkActions, type WorkActions } from "@/features/work/client";
import { useApplicationStore } from "@/shared/store/application-store";
import type { Store } from "@/components/store/types";
import { FeaturePage } from "@/shared/ui/feature-page";
import { CandidaturaCard } from "./work-candidatura-card";
import { CompanyCard } from "./work-company-card";
import { OTHER_JOB_PLATFORMS, PortalLinkCard, WORKING_JOB_PLATFORMS } from "./work-portal-cards";
import { QuickJobSearchCard } from "./work-portal-search";
import { workBrandCss } from "./work-styles";
import {
  filterApplicationsByStatus,
  filterCompanies,
  firstQuickSearchPerPlatform,
  normalizeVerifiedJobsPayload,
} from "./work-model";

type WorkTab = "verified" | "portals" | "companies" | "candidaturas";

const WORK_TABS: [Exclude<WorkTab, "verified">, string][] = [
  ["portals", "Portales"],
  ["companies", "Empresas"],
  ["candidaturas", "Candidaturas"],
];

function Work({ store, actions }: { store: Store; actions: WorkActions }) {
  const [tab, setTab] = useState<WorkTab>("portals");
  const [expandedPortal, setExpandedPortal] = useState<JobPlatform | null>(null);
  const [companySearch, setCompanySearch] = useState("");
  const [companyView, setCompanyView] = useState<"all" | "favorites">("all");
  const [savedSearches, setSavedSearches] = useState<Record<string, SavedQuickSearch>>({});
  const [savedSearchesLoaded, setSavedSearchesLoaded] = useState(false);
  const [verifiedJobs, setVerifiedJobs] = useState<VerifiedJob[]>([]);
  const [verifiedJobsEnabled, setVerifiedJobsEnabled] = useState(false);
  const [verifiedJobsLoaded, setVerifiedJobsLoaded] = useState(false);
  const [verifiedJobBusyId, setVerifiedJobBusyId] = useState<string | null>(null);
  const workTabTouched = useRef(false);

  // Candidaturas state
  const [applications, setApplications] = useState<JobApplication[]>([]);
  const [appLoaded, setAppLoaded] = useState(false);
  const [appStatusFilter, setAppStatusFilter] = useState("");
  const [noteInput, setNoteInput] = useState<Record<string, string>>({});
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualForm, setManualForm] = useState({ company_name: "", company_url: "", job_title: "", job_url: "" });

  const handleToggleWork = useCallback((p: JobPlatform) => setExpandedPortal((v) => v === p ? null : p), []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/verified-jobs", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() : { enabled: false, jobs: [] })
      .then((payload) => {
        if (cancelled) return;
        const { enabled, jobs } = normalizeVerifiedJobsPayload(payload);
        setVerifiedJobsEnabled(enabled);
        setVerifiedJobs(jobs);
        if (enabled && !workTabTouched.current) setTab("verified");
      })
      .finally(() => { if (!cancelled) setVerifiedJobsLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const updateVerifiedJob = useCallback(async (job: VerifiedJob, action: VerifiedJobPrivateAction) => {
    setVerifiedJobBusyId(job.id);
    try {
      const response = await fetch(`/api/verified-jobs/${encodeURIComponent(job.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) throw new Error("Verified job action failed");
      const payload = await response.json();
      setAppLoaded(false);
      if (action === "dismiss") {
        setVerifiedJobs((current) => current.filter((item) => item.id !== job.id));
        toast.success("Oferta ocultada");
      } else {
        setVerifiedJobs((current) => current.map((item) => item.id === job.id ? {
          ...item,
          isSaved: payload.state.isSaved,
          privateApplicationId: payload.state.id,
          privateApplicationStatus: payload.state.status,
        } : item));
        toast.success(action === "applied"
          ? "Candidatura marcada como aplicada"
          : action === "unsave"
            ? "Oferta quitada de guardados"
            : "Oferta guardada");
      }
    } catch {
      toast.error("No se pudo actualizar la oferta");
    } finally {
      setVerifiedJobBusyId(null);
    }
  }, []);

  useEffect(() => {
    if (tab !== "portals" || savedSearchesLoaded) return;
    let cancelled = false;
    getQuickSearchesAction().then((rows) => {
      if (cancelled) return;
      setSavedSearches(firstQuickSearchPerPlatform(rows));
      setSavedSearchesLoaded(true);
    });
    return () => { cancelled = true; };
  }, [tab, savedSearchesLoaded]);

  const handlePortalSearch = useCallback((platform: JobPlatform, keyword: string, location: string) => {
    setSavedSearches((prev) => ({ ...prev, [platform]: { platform, keyword, location } }));
    saveQuickSearchAction(platform, keyword, location).catch(() => {});
  }, []);

  const filteredCompanies = useMemo(
    () => filterCompanies(store.companies, { search: companySearch, favoritesOnly: companyView === "favorites" }),
    [store.companies, companySearch, companyView],
  );
  const favoriteCompanyCount = store.companies.filter((company) => company.is_favorite).length;

  const fetchApplications = useCallback(async () => {
    const res = await fetch("/api/job-radar");
    if (!res.ok) return;
    const d = await res.json();
    setApplications(d.applications ?? []);
    setAppLoaded(true);
  }, []);

  const updateAppStatus = useCallback(async (id: string, status: ApplicationStatus) => {
    await fetch(`/api/job-radar/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setApplications((prev) => prev.map((a) => a.id === id ? { ...a, status, is_new: false } : a));
  }, []);

  const submitNote = useCallback(async (id: string) => {
    const text = noteInput[id]?.trim();
    if (!text) return;
    await fetch(`/api/job-radar/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: text }),
    });
    const created_at = new Date().toISOString();
    setApplications((prev) => prev.map((a) => a.id === id ? { ...a, notes: [...(a.notes ?? []), { text, created_at }] } : a));
    setNoteInput((prev) => ({ ...prev, [id]: "" }));
  }, [noteInput]);

  const removeApplication = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/job-radar/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Error al eliminar");
      setApplications((prev) => prev.filter((a) => a.id !== id));
      toast.success("Candidatura eliminada");
    } catch {
      toast.error("Error al eliminar la candidatura");
    }
  }, []);

  const submitManual = useCallback(async () => {
    const { company_name, company_url, job_title, job_url } = manualForm;
    if (!company_name.trim() || !company_url.trim() || !job_title.trim()) return;
    try {
      const res = await fetch("/api/job-radar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_name, company_url, job_title, job_url }),
      });
      if (!res.ok) throw new Error("Error al añadir");
      const d = await res.json();
      setApplications((prev) => [d.application, ...prev]);
      setManualForm({ company_name: "", company_url: "", job_title: "", job_url: "" });
      setShowManualForm(false);
      toast.success("Candidatura añadida");
    } catch {
      toast.error("Error al añadir la candidatura");
    }
  }, [manualForm]);

  useEffect(() => {
    if (tab === "candidaturas" && !appLoaded) {
      fetchApplications();
    }
  }, [tab, appLoaded, fetchApplications]);

  const filteredApplications = useMemo(
    () => filterApplicationsByStatus(applications, appStatusFilter),
    [applications, appStatusFilter],
  );
  const workTabs = useMemo<[WorkTab, string][]>(
    () => verifiedJobsEnabled ? [["verified", "Ofertas verificadas"], ...WORK_TABS] : WORK_TABS,
    [verifiedJobsEnabled],
  );

  return (
    <>
      <style>{workBrandCss}</style>
      <div className="al-work-tabs" style={{ marginTop: 8 }}>
        {workTabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={cn("al-work-tab", tab === id && "al-work-tab-active")}
            onClick={() => { workTabTouched.current = true; setTab(id); }}
          >
            {label}
          </button>
        ))}
      </div>

      {verifiedJobsEnabled && tab === "verified" && (
        verifiedJobsLoaded ? (
          <VerifiedJobsView jobs={verifiedJobs} busyId={verifiedJobBusyId} onAction={updateVerifiedJob} />
        ) : (
          <p className="text-sm text-muted-foreground">Cargando ofertas verificadas...</p>
        )
      )}

      {tab === "portals" && (
        <div className="space-y-6">
          <div className="space-y-3">
            <div>
              <p className="al-work-section-title">Búsqueda rápida</p>
              <p className="text-sm text-muted-foreground">
                Estos portales funcionan bien con nuestro buscador. Haz clic, escribe tu puesto y elige tu provincia (o activa teletrabajo) para abrir la búsqueda ya filtrada.
              </p>
            </div>
            <div className="al-work-portal-grid sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
              {WORKING_JOB_PLATFORMS.map((platform) => (
                <QuickJobSearchCard
                  key={platform}
                  platform={platform}
                  expanded={expandedPortal === platform}
                  onToggle={handleToggleWork}
                  saved={savedSearches[platform]}
                  onSearch={handlePortalSearch}
                />
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <p className="al-work-section-title">Otros portales</p>
              <p className="text-sm text-muted-foreground">
                Estos no filtran bien desde aquí, así que te llevan directos a su web para que busques allí.
              </p>
            </div>
            <div className="al-work-portal-link-grid sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
              {OTHER_JOB_PLATFORMS.map((platform) => (
                <PortalLinkCard key={platform} platform={platform} />
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === "companies" && (
        <div className="space-y-4">
          <div className="al-work-companies-toolbar">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-9" value={companySearch} onChange={(event) => setCompanySearch(event.target.value)} placeholder="Buscar empresa o categoria" />
            </div>
            <div className="al-work-company-views" role="group" aria-label="Vista de empresas">
              <button type="button" className={cn("al-work-company-view", companyView === "all" && "al-work-company-view-active")} onClick={() => setCompanyView("all")} aria-pressed={companyView === "all"}>
                Todas
              </button>
              <button type="button" className={cn("al-work-company-view", companyView === "favorites" && "al-work-company-view-active")} onClick={() => setCompanyView("favorites")} aria-pressed={companyView === "favorites"}>
                <Heart className="h-3.5 w-3.5" fill={companyView === "favorites" ? "currentColor" : "none"} />
                Favoritas {favoriteCompanyCount}
              </button>
            </div>
            {store.companies.length > 0 && (
              <span className="text-xs text-muted-foreground">{filteredCompanies.length} empresas</span>
            )}
          </div>

          {!store.companies.length ? (
            <div className="al-work-empty">
              <Building2 className="h-8 w-8 text-muted-foreground/40" />
              <p className="al-work-empty-title">Próximamente para tu ciclo</p>
              <p className="al-work-empty-desc">Todavía no tenemos empresas identificadas para tu familia profesional. Iremos añadiéndolas.</p>
            </div>
          ) : !filteredCompanies.length && companyView === "favorites" && !companySearch ? (
            <div className="al-work-empty">
              <Heart className="h-8 w-8 text-[#E15D2D]/50" />
              <p className="al-work-empty-title">Aún no tienes empresas favoritas</p>
              <p className="al-work-empty-desc">Marca el corazón de una empresa y aparecerá aquí al instante.</p>
            </div>
          ) : !filteredCompanies.length ? (
            <EmptyText>{companyView === "favorites" ? "No hay empresas favoritas con esa búsqueda." : "No hay empresas con esa búsqueda."}</EmptyText>
          ) : (
            <div className="al-work-company-grid">
              {filteredCompanies.map((company) => (
                <CompanyCard key={company.id} company={company} onToggleFavorite={() => actions.toggleCompanyFavorite(company.id)} />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "candidaturas" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setAppStatusFilter("")}
                  className={cn("rounded-full border px-3 py-1 text-xs transition-colors", !appStatusFilter ? "al-action-soft-selected" : "hover:bg-muted")}
                >
                  Todas
                </button>
                {APPLICATION_STATUSES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setAppStatusFilter((v) => v === s ? "" : s)}
                    className={cn("rounded-full border px-3 py-1 text-xs transition-colors", appStatusFilter === s ? "al-action-soft-selected" : "hover:bg-muted")}
                  >
                    {STATUS_LABELS[s]}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">Tu seguimiento es privado y solo aparece después de una acción tuya o una entrada manual.</p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setShowManualForm((v) => !v)}
                className="h-8 gap-1.5 text-xs"
              >
                <Plus className="h-3.5 w-3.5" />
                Añadir manual
              </Button>
            </div>
          </div>

          {showManualForm && (
            <Card className="p-4">
              <div className="space-y-3">
                <p className="text-sm font-medium">Añadir candidatura manual</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    placeholder="Empresa *"
                    value={manualForm.company_name}
                    onChange={(e) => setManualForm((f) => ({ ...f, company_name: e.target.value }))}
                  />
                  <Input
                    type="url"
                    inputMode="url"
                    placeholder="URL pagina empleo *"
                    value={manualForm.company_url}
                    onChange={(e) => setManualForm((f) => ({ ...f, company_url: e.target.value }))}
                  />
                  <Input
                    placeholder="Puesto *"
                    value={manualForm.job_title}
                    onChange={(e) => setManualForm((f) => ({ ...f, job_title: e.target.value }))}
                  />
                  <Input
                    type="url"
                    inputMode="url"
                    placeholder="URL oferta (opcional)"
                    value={manualForm.job_url}
                    onChange={(e) => setManualForm((f) => ({ ...f, job_url: e.target.value }))}
                  />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={submitManual}>Guardar</Button>
                  <Button size="sm" variant="ghost" onClick={() => setShowManualForm(false)}>Cancelar</Button>
                </div>
              </div>
            </Card>
          )}

          {!appLoaded ? (
            <p className="text-sm text-muted-foreground">Cargando candidaturas...</p>
          ) : filteredApplications.length === 0 ? (
            <EmptyText>
              {appStatusFilter ? "Sin candidaturas con ese estado." : "Sin candidaturas. Guarda una oferta verificada o añade una manual."}
            </EmptyText>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{filteredApplications.length} candidatura{filteredApplications.length !== 1 ? "s" : ""}</p>
              {filteredApplications.map((app) => (
                <CandidaturaCard
                  key={app.id}
                  app={app}
                  noteValue={noteInput[app.id] ?? ""}
                  onNoteChange={(v) => setNoteInput((prev) => ({ ...prev, [app.id]: v }))}
                  onNoteSubmit={() => submitNote(app.id)}
                  onStatusChange={updateAppStatus}
                  onDelete={removeApplication}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{children}</div>;
}

export function WorkFeature() {
  const { store } = useApplicationStore();
  const actions = useWorkActions();
  return (
    <FeaturePage eyebrow="Empleo y candidaturas" title="Trabajo" subtitle="Portales de búsqueda, tus empresas guardadas y el seguimiento de tus candidaturas.">
      <Work store={store} actions={actions} />
    </FeaturePage>
  );
}
