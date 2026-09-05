// Scoped CSS for the Work feature surface (tabs, portal search, company grid,
// candidatura cards). Kept out of work-feature.tsx so the container only wires
// the workflows together.
export const workBrandCss = `
  .al-work-tabs { display: inline-flex; align-items: center; gap: 2px; background: #f5f2ea; border-radius: 10px; padding: 3px; }
  .al-work-tab { border: none; background: transparent; border-radius: 8px; padding: 7px 14px; font-size: 13px; font-weight: 700; color: #6b6f72; cursor: pointer; transition: background .15s, color .15s; }
  .al-work-tab-active { background: var(--al-action-soft-bg-hover); color: var(--al-action-soft-text-hover); box-shadow: inset 0 0 0 1px var(--al-action-soft-border), 0 4px 12px rgba(80, 43, 27, 0.05); }

  .al-work-section-title { font-size: 13px; font-weight: 700; color: #333029; margin-bottom: 2px; }

  .al-work-portal-grid { display: grid; gap: 10px; align-items: start; }
  .al-work-portal-card { border: 1px solid #ece7dc; border-radius: 14px; background: white; padding: 10px; box-shadow: 0 8px 20px rgba(17, 17, 17, 0.04); transition: border-color .15s, box-shadow .15s; }
  .al-work-portal-card-expanded { border-color: rgba(225, 93, 45, 0.35); box-shadow: 0 10px 24px rgba(225, 93, 45, 0.1); }
  .al-work-portal-head { display: flex; width: 100%; align-items: center; gap: 10px; text-align: left; border: none; background: transparent; cursor: pointer; padding: 0; }
  .al-work-portal-mark { display: flex; height: 32px; width: 32px; flex-shrink: 0; align-items: center; justify-content: center; overflow: hidden; border-radius: 10px; border: 1px solid #ece7dc; background: white; }
  .al-work-portal-title { font-size: 13.5px; font-weight: 700; color: #111111; }
  .al-work-portal-sub { font-size: 11px; color: #9a958a; }
  .al-work-portal-expand { margin-top: 10px; display: grid; gap: 8px; }
  .al-work-portal-field { display: grid; gap: 3px; }
  .al-work-portal-field-label { font-size: 10px; font-weight: 700; color: #9a958a; text-transform: uppercase; letter-spacing: .03em; }
  .al-work-portal-search-btn { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; height: 34px; padding: 0 14px; border-radius: 10px; border: 1px solid var(--al-action-soft-border); background: var(--al-action-soft-bg); color: var(--al-action-soft-text); font-size: 12.5px; font-weight: 700; cursor: pointer; white-space: nowrap; text-decoration: none; transition: background .15s, border-color .15s, color .15s; }
  .al-work-portal-search-btn:hover { border-color: var(--al-action-soft-border-hover); background: var(--al-action-soft-bg-hover); color: var(--al-action-soft-text-hover); }
  .al-work-portal-search-btn-disabled { opacity: .5; cursor: not-allowed; pointer-events: none; }

  .al-work-province { position: relative; }
  .al-work-province-trigger { width: 100%; height: 32px; display: flex; align-items: center; justify-content: space-between; gap: 6px; border-radius: 8px; border: 1px solid #e4dfd5; background: white; padding: 0 10px; cursor: pointer; font-size: 12px; color: #111111; transition: border-color .15s, box-shadow .15s; }
  .al-work-province-trigger:hover:not(:disabled) { border-color: #d8d1c2; }
  .al-work-province-trigger[aria-expanded="true"] { border-color: rgba(225, 93, 45, 0.5); box-shadow: 0 0 0 3px rgba(225, 93, 45, 0.12); }
  .al-work-province-trigger:disabled { cursor: not-allowed; background: #f5f2ea; color: #9a958a; }
  .al-work-province-value { flex: 1; min-width: 0; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .al-work-province-placeholder { color: #a39d8e; }
  .al-work-province-chevron { width: 14px; height: 14px; color: #9a9589; flex-shrink: 0; transition: transform .15s; }
  .al-work-province-trigger[aria-expanded="true"] .al-work-province-chevron { transform: rotate(180deg); }
  .al-work-province-panel { position: absolute; z-index: 20; top: calc(100% + 6px); left: 0; right: 0; background: white; border: 1px solid #ece7dc; border-radius: 12px; box-shadow: 0 16px 40px rgba(17, 17, 17, 0.12); padding: 6px; }
  .al-work-province-filter { width: 100%; height: 30px; border-radius: 7px; border: 1px solid #ece7dc; padding: 0 8px; font-size: 12px; margin-bottom: 4px; }
  .al-work-province-list { list-style: none; margin: 0; padding: 0; max-height: 180px; overflow-y: auto; }
  .al-work-province-option { width: 100%; display: block; text-align: left; padding: 6px 8px; border-radius: 7px; border: none; background: transparent; font-size: 12px; color: #111111; cursor: pointer; }
  .al-work-province-option:hover { background: #f7f4ee; }
  .al-work-province-option-selected { background: #fbe7dd; color: #e15d2d; font-weight: 600; }
  .al-work-province-empty { padding: 8px; font-size: 12px; color: #9a958a; text-align: center; }

  .al-work-remote-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .al-work-remote-switch { position: relative; display: inline-flex; height: 20px; width: 36px; flex-shrink: 0; align-items: center; border-radius: 999px; border: 1px solid transparent; cursor: pointer; background: #e4dfd5; transition: background-color .15s, border-color .15s; }
  .al-work-remote-switch[aria-checked="true"] { border-color: var(--al-action-soft-border-hover); background: var(--al-action-soft-bg-hover); }
  .al-work-remote-switch-thumb { display: inline-block; height: 14px; width: 14px; border-radius: 999px; background: white; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2); transform: translateX(3px); transition: transform .15s; }
  .al-work-remote-switch[aria-checked="true"] .al-work-remote-switch-thumb { background: var(--al-action-soft-text); transform: translateX(17px); }

  .al-work-portal-link-grid { display: grid; gap: 8px; }
  .al-work-portal-link-card { display: flex; align-items: center; gap: 8px; border: 1px solid #ece7dc; border-radius: 12px; background: white; padding: 8px 10px; text-decoration: none; transition: border-color .15s, box-shadow .15s; }
  .al-work-portal-link-card:hover { border-color: rgba(225, 93, 45, 0.35); box-shadow: 0 8px 18px rgba(17, 17, 17, 0.05); }
  .al-work-portal-link-title { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600; color: #333029; }
  .al-work-portal-link-icon { color: #9a958a; flex-shrink: 0; }

  .al-work-companies-toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .al-work-company-views { display: inline-flex; align-items: center; gap: 2px; border: 1px solid #ece7dc; border-radius: 11px; background: white; padding: 3px; }
  .al-work-company-view { display: inline-flex; align-items: center; gap: 5px; height: 32px; padding: 0 10px; border: none; border-radius: 8px; background: transparent; color: #6b6f72; font-size: 12px; font-weight: 600; cursor: pointer; }
  .al-work-company-view-active { box-shadow: inset 0 0 0 1px var(--al-action-soft-border); background: var(--al-action-soft-bg-hover); color: var(--al-action-soft-text-hover); }
  .al-work-company-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
  .al-work-company-card { position: relative; border: 1px solid #ece7dc; border-radius: 16px; background: white; padding: 16px; box-shadow: 0 10px 26px rgba(17, 17, 17, 0.045); display: flex; flex-direction: column; gap: 8px; min-height: 178px; }
  .al-work-company-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .al-work-company-name { font-size: 14.5px; font-weight: 700; color: #111111; line-height: 1.3; }
  .al-work-company-category { font-size: 11.5px; color: #6b6f72; line-height: 1.4; margin-top: 2px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
  .al-work-company-note { font-size: 11px; color: #9a958a; line-height: 1.45; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
  .al-work-company-hint { font-size: 11px; color: #9a958a; line-height: 1.4; }
  .al-work-company-fav { display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 999px; border: 1px solid #ece7dc; background: white; color: #c9c3b6; cursor: pointer; flex-shrink: 0; transition: color .15s, border-color .15s, background .15s; }
  .al-work-company-fav-active { color: var(--al-action-soft-text); border-color: var(--al-action-soft-border-hover); background: var(--al-action-soft-bg-hover); }
  .al-work-company-actions { display: flex; gap: 8px; margin-top: auto; padding-top: 6px; }
  .al-work-company-btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 34px; border-radius: 10px; font-size: 12px; font-weight: 700; text-decoration: none; cursor: pointer; }
  .al-work-company-btn-solid { border: 1px solid var(--al-action-soft-border); color: var(--al-action-soft-text); background: var(--al-action-soft-bg); transition: background .15s, border-color .15s, color .15s; }
  .al-work-company-btn-solid:hover { border-color: var(--al-action-soft-border-hover); color: var(--al-action-soft-text-hover); background: var(--al-action-soft-bg-hover); }

  .al-work-tab:focus-visible, .al-work-portal-search-btn:focus-visible, .al-work-remote-switch:focus-visible, .al-work-company-view:focus-visible, .al-work-company-fav:focus-visible, .al-work-company-btn:focus-visible { outline: 3px solid var(--al-action-soft-focus); outline-offset: 2px; }

  .al-work-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 40px 16px; text-align: center; border: 1px dashed #e4dfd5; border-radius: 16px; background: white; }
  .al-work-empty-title { font-size: 14px; font-weight: 700; color: #333029; }
  .al-work-empty-desc { font-size: 12px; color: #9a958a; max-width: 360px; }
`;
