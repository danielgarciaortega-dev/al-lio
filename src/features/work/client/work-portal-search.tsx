"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { buildJobSearchUrl, type JobPlatform } from "@/lib/deeplinks/job-search-urls";
import { SPANISH_PROVINCES } from "@/lib/deeplinks/spanish-provinces";
import { type SavedQuickSearch } from "@/features/work/server/actions";
import { deriveQuickSearchFields } from "./work-model";
import { PortalMark } from "./work-portal-cards";

const WORK_DIACRITICS_PATTERN = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, "g");

function normalizeForProvinceSearch(value: string) {
  return value.trim().toLowerCase().normalize("NFD").replace(WORK_DIACRITICS_PATTERN, "");
}

function ProvinceCombobox({
  value,
  onChange,
  disabled,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder: string;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setFilter("");
    const raf = requestAnimationFrame(() => filterRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const results = useMemo(() => {
    const needle = normalizeForProvinceSearch(filter);
    if (!needle) return SPANISH_PROVINCES;
    return SPANISH_PROVINCES.filter((province) => normalizeForProvinceSearch(province).includes(needle));
  }, [filter]);

  return (
    <div className="al-work-province" ref={containerRef}>
      <button
        type="button"
        className="al-work-province-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={cn("al-work-province-value", (disabled || !value) && "al-work-province-placeholder")}>
          {disabled ? placeholder : value || placeholder}
        </span>
        <ChevronDown className="al-work-province-chevron" aria-hidden="true" />
      </button>
      {open && !disabled && (
        <div className="al-work-province-panel">
          <input
            ref={filterRef}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Buscar provincia..."
            className="al-work-province-filter"
            aria-label="Filtrar provincias"
          />
          <ul className="al-work-province-list" role="listbox" aria-label={ariaLabel}>
            {results.length === 0 && <li className="al-work-province-empty">Sin resultados</li>}
            {results.map((province) => {
              const isSelected = province === value;
              return (
                <li key={province}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={cn("al-work-province-option", isSelected && "al-work-province-option-selected")}
                    onClick={() => {
                      onChange(province);
                      setOpen(false);
                    }}
                  >
                    {province}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

const QuickJobSearchCard = memo(function QuickJobSearchCard({
  platform,
  expanded,
  onToggle,
  saved,
  onSearch,
}: {
  platform: JobPlatform;
  expanded: boolean;
  onToggle: (p: JobPlatform) => void;
  saved?: SavedQuickSearch;
  onSearch: (platform: JobPlatform, keyword: string, location: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [province, setProvince] = useState("");
  const [remote, setRemote] = useState(false);
  const hydrated = useRef(false);

  useEffect(() => {
    if (hydrated.current || !saved) return;
    hydrated.current = true;
    const fields = deriveQuickSearchFields(saved);
    setQuery(fields.keyword);
    setProvince(fields.province);
    setRemote(fields.remote);
  }, [saved]);

  const effectiveLocation = remote ? "Teletrabajo" : province;
  const url = useMemo(() => buildJobSearchUrl(platform, query, effectiveLocation), [platform, query, effectiveLocation]);
  const canSearch = query.trim().length > 0;

  return (
    <div className={cn("al-work-portal-card", expanded && "al-work-portal-card-expanded")}>
      <button type="button" className="al-work-portal-head" onClick={() => onToggle(platform)}>
        <PortalMark platform={platform} />
        <div className="min-w-0">
          <p className="al-work-portal-title truncate">{platform}</p>
          <p className="al-work-portal-sub truncate">Busqueda rapida</p>
        </div>
      </button>
      {expanded && (
        <div className="al-work-portal-expand">
          <div className="al-work-portal-field">
            <span className="al-work-portal-field-label">Qué buscas</span>
            <Input value={query} onChange={(event) => setQuery(event.target.value)} className="h-8 text-xs" placeholder="Puesto o palabra clave" aria-label={`Busqueda en ${platform}`} />
          </div>
          <div className="al-work-portal-field">
            <span className="al-work-portal-field-label">Provincia</span>
            <ProvinceCombobox
              value={province}
              onChange={setProvince}
              disabled={remote}
              placeholder={remote ? "Teletrabajo" : "Elige provincia"}
              ariaLabel={`Provincia de busqueda en ${platform}`}
            />
          </div>
          <label className="al-work-remote-row">
            <span className="al-work-portal-field-label">Teletrabajo</span>
            <button
              type="button"
              role="switch"
              aria-checked={remote}
              onClick={() => setRemote((current) => !current)}
              className="al-work-remote-switch"
            >
              <span className="al-work-remote-switch-thumb" />
            </button>
          </label>
          <a
            href={canSearch ? url : undefined}
            target="_blank"
            rel="noreferrer"
            aria-disabled={!canSearch}
            className={cn("al-work-portal-search-btn", !canSearch && "al-work-portal-search-btn-disabled")}
            onClick={(event) => {
              if (!canSearch) { event.preventDefault(); return; }
              onSearch(platform, query, effectiveLocation);
            }}
          >
            Buscar <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      )}
    </div>
  );
});

export { QuickJobSearchCard };
