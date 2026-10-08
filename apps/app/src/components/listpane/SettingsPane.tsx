import { ArrowLeft, FolderCog, Search, X } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useState, useId } from 'react';
import { useData, useUi } from '../../store.js';
import { SETTINGS_SECTIONS, SETTINGS_GROUPS, SETTINGS_SUBSECTIONS } from '@/views/settings/settings-navigation';
import { SidebarResizer } from '../SidebarResizer.js';
import { useAppSettingsRouteMemory } from '../../hooks/useAppSettingsRouteMemory.js';
import { getSettingsRoutePath, getSettingsTabRoutePath } from '../../lib/route-paths.js';
import { searchSettings, type SettingsSearchHit, type SettingsSnippet } from '../../lib/settings-search/index.js';
import { settingsHitPath } from '../../lib/settings-search/links.js';
import { ensureSettingsSearchProviders } from '../../lib/settings-search/runtime.js';
import { buildCorpus } from '../../lib/settings-search/corpus.js';
import { useSettingsSnapshot } from '../../lib/settings-search/snapshot.js';
import { appSettingsNavCatalog, filterSettingsNav } from '../../lib/settings-nav-search.js';
import { useMobileNavDismiss } from '../mobile-nav-context.js';

/**
 * Focused Settings rail. Each Settings section (Global · Prompts · Personas ·
 * Squads · Usage · …, + the project-scoped Project settings) is a row that
 * navigates to `/settings/:section` (project settings live at
 * `/projects/:id/settings`). Scope (Global vs a single project) is chosen in the
 * content header's scope control (see `ScopeControl` in SettingsPanel.tsx),
 * NOT here. Plugins / Skills / MCP live on the top-level Extensions workspace.
 *
 * `SETTINGS_SECTIONS` is the shared source of truth for labels/icons/descs.
 */
const SECTION_ORDER = new Map<string, number>(SETTINGS_SECTIONS.map((s, i) => [s.id, i]));

function sectionTitle(section: string): string {
  if (section === 'project') return 'Project settings';
  return SETTINGS_SECTIONS.find((s) => s.id === section)?.label ?? section;
}

/** Group ranked hits by page in section order, keeping rank order inside a page. */
export function groupHitsByPage(hits: readonly SettingsSearchHit[]): Array<{ section: string; title: string; hits: SettingsSearchHit[] }> {
  const groups = new Map<string, SettingsSearchHit[]>();
  for (const hit of hits) {
    const list = groups.get(hit.entry.section) ?? [];
    list.push(hit);
    groups.set(hit.entry.section, list);
  }
  return [...groups.entries()]
    .sort((a, b) => (SECTION_ORDER.get(a[0]) ?? 1e6) - (SECTION_ORDER.get(b[0]) ?? 1e6))
    .map(([section, list]) => ({ section, title: sectionTitle(section), hits: list }));
}

function Highlighted({ snippet }: { snippet: SettingsSnippet }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  snippet.ranges.forEach(([start, end], i) => {
    if (start > at) parts.push(snippet.text.slice(at, start));
    parts.push(<mark key={i}>{snippet.text.slice(start, end)}</mark>);
    at = end;
  });
  if (at < snippet.text.length) parts.push(snippet.text.slice(at));
  return <>{parts}</>;
}

export function SettingsPane() {
  const dismissMobileNav = useMobileNavDismiss();
  const settingsTab = useUi((s) => s.settingsTab);
  const setSettingsAnchor = useUi((s) => s.setSettingsAnchor);
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const focusedProjectId = useUi((s) => s.focusedProjectId);
  const projects = useData((s) => s.projects);
  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;
  const routeMemory = useAppSettingsRouteMemory();
  const projectId = focusedProjectId ?? selectedProjectId ?? selectedProject?.id ?? null;
  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [active, setActive] = useState(0);
  // Bumped when lazily fetched sources (plugin settings) arrive, so an open query re-ranks with them.
  const [sourcesTick, setSourcesTick] = useState(0);
  const navigate = useNavigate();
  const listId = useId();
  const searching = query.trim().length > 0;
  const snapshot = useSettingsSnapshot(projectId, searchFocused || searching);
  const hits = useMemo(() => {
    if (!searching) return [];
    ensureSettingsSearchProviders();
    return searchSettings(query, snapshot);
  }, [searching, query, snapshot, sourcesTick]);
  const pages = useMemo(() => groupHitsByPage(hits), [hits]);
  const flat = useMemo(() => pages.flatMap((p) => p.hits), [pages]);
  const activeHit = flat[Math.min(active, flat.length - 1)];
  const optionId = (hit: SettingsSearchHit) => `${listId}-${hit.entry.id}`;
  const activeOptionId = searching && activeHit ? optionId(activeHit) : undefined;
  useEffect(() => {
    if (activeOptionId) document.getElementById(activeOptionId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeOptionId]);
  const parentLabel = (id: string) => buildCorpus(snapshot).entries.find((r) => r.entry.id === id)?.entry.label;

  const open = (hit: SettingsSearchHit) => {
    const { entry } = hit;
    const anchor = entry.kind === 'section' || entry.href ? undefined : entry.id;
    const path = settingsHitPath(hit, projectId);
    setSettingsAnchor(anchor ?? null);
    void navigate(path);
    dismissMobileNav?.();
  };
  const catalog = useMemo(
    () => appSettingsNavCatalog({
      groups: SETTINGS_GROUPS,
      sections: SETTINGS_SECTIONS,
      subsections: SETTINGS_SUBSECTIONS
    }),
    []
  );
  const groups = useMemo(() => filterSettingsNav('', catalog), [catalog]);

  const renderRow = (section: { id: string; label: string; subsections: Array<{ id: string; label: string }> }) => {
    const meta = SETTINGS_SECTIONS.find((row) => row.id === section.id);
    const Icon = meta?.icon ?? FolderCog;
    return (
      <div key={section.id} className="settings-section-group">
        <Link
          to={getSettingsTabRoutePath(section.id, projectId)}
          data-testid={`settings-nav-${section.id}`}
          className={`settings-section-item ${settingsTab === section.id ? 'active' : ''}`}
          aria-current={settingsTab === section.id ? 'page' : undefined}
          onClick={() => { setSettingsAnchor(null); dismissMobileNav?.(); }}
        >
          <Icon size={16} strokeWidth={1.7} aria-hidden="true" />
          <span className="settings-section-copy">
            <span className="settings-section-label">{section.label}</span>
          </span>
        </Link>
        {section.subsections.length > 0 ? (
          <div className="settings-subsection-list">
            {section.subsections.map((sub) => (
              <Link
                key={sub.id}
                to={getSettingsRoutePath(section.id, sub.id)}
                className="settings-subsection-item"
                data-testid={`settings-nav-${section.id}-${sub.id}`}
                onClick={() => { setSettingsAnchor(sub.id); dismissMobileNav?.(); }}
              >
                {sub.label}
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <aside className="sidebar settings-pane">
      <Link to={routeMemory.appRoutePath} className="settings-app-back" onClick={() => dismissMobileNav?.()}>
        <ArrowLeft size={16} strokeWidth={1.7} aria-hidden="true" />
        Back to app
      </Link>
      <div className="settings-search">
        <Search size={14} className="settings-search-icon" aria-hidden="true" />
        <input
          type="text"
          className="settings-search-input"
          data-testid="settings-search"
          aria-label="Search settings"
          placeholder="Search settings…"
          value={query}
          aria-autocomplete="list"
          aria-controls={searching && flat.length > 0 ? listId : undefined}
          aria-activedescendant={activeOptionId}
          onFocus={() => {
            setSearchFocused(true);
            void ensureSettingsSearchProviders().prefetchPluginSettings().then(() => setSourcesTick((n) => n + 1));
          }}
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.stopPropagation();
              setQuery('');
            } else if (searching && flat.length > 0 && event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((i) => Math.min(i + 1, flat.length - 1));
            } else if (searching && flat.length > 0 && event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (searching && event.key === 'Enter' && activeHit && !event.nativeEvent.isComposing) {
              event.preventDefault();
              open(activeHit);
            }
          }}
        />
        {query ? (
          <button
            type="button"
            className="settings-search-clear"
            aria-label="Clear search"
            onClick={() => setQuery('')}
          >
            <X size={12} />
          </button>
        ) : null}
      </div>
      {searching ? (
        flat.length === 0 ? (
          <p className="settings-search-empty" role="status">No matching settings</p>
        ) : (
          <div className="settings-results" role="listbox" id={listId} aria-label="Settings search results">
            {pages.map((page) => (
              <div key={page.section} className="settings-group" role="group" aria-label={page.title}>
                <div className="settings-group-label">{page.title}</div>
                {page.hits.map((hit) => (
                  <div
                    key={hit.entry.id}
                    id={optionId(hit)}
                    role="option"
                    aria-selected={hit === activeHit}
                    data-testid={`settings-result-${hit.entry.id}`}
                    className="settings-result"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => open(hit)}
                  >
                    <span className="settings-result-label">{hit.entry.label}</span>
                    <span className="settings-result-crumb">{hit.breadcrumb}</span>
                    {hit.snippet ? (
                      <span className="settings-result-snippet"><Highlighted snippet={hit.snippet} /></span>
                    ) : null}
                    {hit.matchedValue ? <span className="settings-result-value">Current: {hit.matchedValue}</span> : null}
                    {hit.entry.dependsOn ? (
                      <span className="settings-result-gate">
                        Appears when {parentLabel(hit.entry.dependsOn) ?? 'its parent setting'} is on
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )
      ) : (
      <nav className="settings-picker" aria-label="Settings navigation">
            {groups.map((group) => (
              <div key={group.id} className="settings-group">
                <div className="settings-group-label">{group.label}</div>
                {group.sections.map(renderRow)}
              </div>
            ))}
      </nav>
      )}
      <SidebarResizer />
    </aside>
  );
}
