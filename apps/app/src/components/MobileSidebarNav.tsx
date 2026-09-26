import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Folder, Search, X } from 'lucide-react';
import type { SidebarRailItem } from './SidebarRail.js';
import { PROJECTS_SECTION_SORT_ID } from './sidebarNavOrder.js';
import '../styles/mobile-tools-picker.css';

/** A searchable tile picker over the same live destinations as the desktop rail. */
export function MobileSidebarNav({ items, navAriaLabel, renderItem }: {
  items: readonly SidebarRailItem[];
  navAriaLabel: string;
  renderItem(id: string): ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [sectionId, setSectionId] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const sectionButtons = useRef(new Map<string, HTMLButtonElement>());
  const lastSection = useRef<string | null>(null);
  const section = items.find((item) => item.kind === 'section' && item.id === sectionId);
  const labelFor = (item: SidebarRailItem) => item.kind === 'row'
    ? item.label : item.id === PROJECTS_SECTION_SORT_ID ? 'Projects' : 'Project agents';
  const needle = query.trim().toLocaleLowerCase();
  const visible = items.filter((item) =>
    item.id !== 'home' && item.id !== 'inbox' &&
    `${labelFor(item)} ${item.id}`.toLocaleLowerCase().includes(needle)
  );

  useEffect(() => {
    if (sectionId) back.current?.focus();
    else if (lastSection.current) sectionButtons.current.get(lastSection.current)?.focus();
  }, [sectionId]);

  return (
    <nav className="mobile-tools-picker" aria-label={navAriaLabel} data-testid="sidebar-navigation">
      {section ? <>
        <button ref={back} type="button" className="mobile-tools-back" onClick={() => setSectionId(null)}>
          <ArrowLeft size={18} aria-hidden="true" /> Plugins & tools
        </button>
        <div className="mobile-tools-section mobile-sidebar-scroll">{renderItem(section.id)}</div>
      </> : <>
        <div className="mobile-tools-heading">
          <h2>Plugins & tools</h2>
          <div className="mobile-agent-search">
            <Search size={18} aria-hidden="true" />
            <input ref={search} type="search" aria-label="Search plugins and tools" placeholder="Search plugins and tools"
              value={query} onChange={(event) => setQuery(event.target.value)} />
            {query && <button type="button" aria-label="Clear tools search" onClick={() => {
              setQuery('');
              search.current?.focus();
            }}><X size={16} aria-hidden="true" /></button>}
          </div>
        </div>
        <div className="mobile-tools-scroll">
          {visible.length > 0 ? <div className="mobile-tools-grid">
            {visible.map((item) => item.kind === 'row' ? renderItem(item.id) : (
              <button key={item.id} type="button" className="mobile-tools-section-tile"
                ref={(element) => {
                  if (element) sectionButtons.current.set(item.id, element);
                  else sectionButtons.current.delete(item.id);
                }} onClick={() => {
                  lastSection.current = item.id;
                  setSectionId(item.id);
                }}>
                <Folder size={24} aria-hidden="true" />
                <span>{labelFor(item)}</span>
              </button>
            ))}
          </div> : <p className="mobile-tools-empty" role="status">
            {needle ? 'No plugins or tools match your search.' : 'No tools available yet.'}
          </p>}
        </div>
      </>}
    </nav>
  );
}
