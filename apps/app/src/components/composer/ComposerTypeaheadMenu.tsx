import { useMemo } from 'react';
import { File, Folder, FolderGit2, MessageSquare, Puzzle, Sparkles, Terminal } from 'lucide-react';
import { suggestionKey, type TypeaheadSuggestion } from './types.js';

function directoryFromPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index > 0 ? path.slice(0, index) : '';
}

type SectionKind = 'threads' | 'projects' | 'files' | 'commands' | 'skills' | 'plugins';

function sectionKind(item: TypeaheadSuggestion): SectionKind {
  if (item.kind === 'thread') return 'threads';
  if (item.kind === 'project') return 'projects';
  if (item.kind === 'plugin') return 'plugins';
  if (item.kind === 'command') {
    return item.source === 'skill' ? 'skills' : 'commands';
  }
  return 'files';
}

function sectionLabel(kind: SectionKind): string {
  if (kind === 'threads') return 'Agents';
  if (kind === 'projects') return 'Projects';
  if (kind === 'commands') return 'Commands';
  if (kind === 'skills') return 'Skills';
  if (kind === 'plugins') return 'Plugins';
  return 'Files';
}

/** Stable section order matching BB's Commands → Skills hierarchy. */
const SECTION_ORDER: readonly SectionKind[] = [
  'commands',
  'skills',
  'threads',
  'projects',
  'plugins',
  'files'
];

function displayCommandName(name: string): string {
  return name.replace(/^\//, '');
}

function primaryLabel(item: TypeaheadSuggestion): string {
  if (item.kind === 'path') return item.name;
  if (item.kind === 'thread') return item.title;
  if (item.kind === 'project') return item.name;
  if (item.kind === 'plugin') return item.label;
  return displayCommandName(item.name);
}

function trailingLabel(item: TypeaheadSuggestion): string {
  if (item.kind === 'path') return directoryFromPath(item.path);
  if (item.kind === 'thread') return item.projectName?.trim() || '';
  if (item.kind === 'command') return item.description;
  if (item.kind === 'plugin') return item.pluginId;
  return '';
}

function rowTitle(item: TypeaheadSuggestion): string {
  const primary = primaryLabel(item);
  const trailing = trailingLabel(item);
  if (item.kind === 'path') return item.path;
  if (trailing) return `${primary} · ${trailing}`;
  return primary;
}

function RowIcon({ item }: { item: TypeaheadSuggestion }) {
  if (item.kind === 'path' && item.entryKind === 'directory') {
    return <Folder className="composer-typeahead-icon" size={14} aria-hidden="true" />;
  }
  if (item.kind === 'path') return <File className="composer-typeahead-icon" size={14} aria-hidden="true" />;
  if (item.kind === 'thread') return <MessageSquare className="composer-typeahead-icon" size={14} aria-hidden="true" />;
  if (item.kind === 'project') return <FolderGit2 className="composer-typeahead-icon" size={14} aria-hidden="true" />;
  if (item.kind === 'plugin') return <Puzzle className="composer-typeahead-icon" size={14} aria-hidden="true" />;
  if (item.kind === 'command' && item.source === 'skill') {
    return <Sparkles className="composer-typeahead-icon" size={14} aria-hidden="true" />;
  }
  return <Terminal className="composer-typeahead-icon" size={14} aria-hidden="true" />;
}

export function ComposerTypeaheadMenu({
  suggestions,
  selectedIndex,
  triggerKind,
  onApply
}: {
  suggestions: readonly TypeaheadSuggestion[];
  selectedIndex: number;
  triggerKind: 'mention' | 'command';
  onApply: (item: TypeaheadSuggestion) => void;
}) {
  const sections = useMemo(() => {
    const grouped = new Map<SectionKind, TypeaheadSuggestion[]>();
    for (const item of suggestions) {
      const kind = sectionKind(item);
      const existing = grouped.get(kind);
      if (existing) existing.push(item);
      else grouped.set(kind, [item]);
    }
    return SECTION_ORDER
      .filter((kind) => grouped.has(kind))
      .map((kind) => ({ kind, items: grouped.get(kind)! }));
  }, [suggestions]);

  const indexByKey = useMemo(() => {
    const map = new Map<string, number>();
    suggestions.forEach((item, index) => {
      map.set(suggestionKey(item), index);
    });
    return map;
  }, [suggestions]);

  return (
    <div
      className="mention-popover composer-typeahead-menu"
      role="listbox"
      data-testid="composer-typeahead-menu"
      aria-label={triggerKind === 'command' ? 'Commands' : 'Mentions'}
    >
      {sections.length === 0 ? (
        <div className="composer-typeahead-empty">
          {triggerKind === 'command' ? 'No matching commands' : 'No matching mentions'}
        </div>
      ) : sections.map((section) => (
        <div key={section.kind} className="composer-typeahead-section">
          <div className="composer-typeahead-heading">{sectionLabel(section.kind)}</div>
          <div className="composer-typeahead-rows">
            {section.items.map((item) => {
              const index = indexByKey.get(suggestionKey(item)) ?? -1;
              const selected = index === selectedIndex;
              const trailing = trailingLabel(item);
              return (
                <button
                  key={suggestionKey(item)}
                  type="button"
                  role="option"
                  data-testid="composer-typeahead-item"
                  data-kind={item.kind}
                  data-source={item.kind === 'command' ? (item.source ?? 'command') : undefined}
                  aria-selected={selected}
                  className={`mention-item composer-typeahead-item${selected ? ' active' : ''}`}
                  title={rowTitle(item)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onApply(item);
                  }}
                >
                  <RowIcon item={item} />
                  <span className="composer-typeahead-primary">{primaryLabel(item)}</span>
                  {trailing ? (
                    <span className="composer-typeahead-trailing">{trailing}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
