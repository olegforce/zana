import { useState } from "react";
import { TasksMobileSheet } from "../../shell/mobile.js";
import { Icon } from "../../vendor/shared-ui/components/ui/icon.js";
import { TASK_PRIORITIES, TASK_STATUSES } from "../../shared/contract.js";
import { TASK_SORTS, type TaskSort } from "../../shared/pagination.js";
import { EMPTY_FILTERS, hasActiveFilters, type ListFilterState } from "./filter-bar.js";
import { PRIORITY_LABELS, STATUS_LABELS, SORT_LABELS, type LabelFilterOption } from "./lib.js";

export function MobileTaskFilters({ query, onQuery, filters, onChange, sort, onSortChange, labelOptions, taskCount }: {
  query: string; onQuery: (value: string) => void; filters: ListFilterState; onChange: (value: ListFilterState) => void;
  sort: TaskSort; onSortChange: (value: TaskSort) => void; labelOptions: readonly LabelFilterOption[]; taskCount: number | undefined;
}) {
  const [open, setOpen] = useState(false);
  const active = hasActiveFilters(filters);
  function choices<T extends string>(title: string, values: readonly T[], selected: T[], label: (value: T) => string, change: (value: T[]) => void) {
    return <fieldset><legend>{title}</legend><div className="tasks-filter-options">{values.map((value) => <label key={value}>
      <input type="checkbox" checked={selected.includes(value)} onChange={(event) => change(event.target.checked ? [...selected, value] : selected.filter(item => item !== value))} />{label(value)}
    </label>)}</div></fieldset>;
  }
  return <>
    <div className="tasks-mobile-searchbar">
      <label><Icon name="Search" className="size-4" /><input type="search" value={query} onChange={event => onQuery(event.target.value)} placeholder="Search tasks…" aria-label="Search tasks" /></label>
      <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><Icon name="SlidersHorizontal" className="size-4" />Filters{active && <span className="tasks-filter-dot" />}</button>
    </div>
    <div className="tasks-mobile-list-summary"><span aria-live="polite">{taskCount === undefined ? "Loading tasks…" : `${taskCount} task${taskCount === 1 ? "" : "s"}`}</span>
      {active && <button type="button" onClick={() => onChange(EMPTY_FILTERS)}>Clear filters</button>}
    </div>
    <TasksMobileSheet title="Task filters" open={open} onClose={() => setOpen(false)}
      footer={<button type="button" onClick={() => setOpen(false)}>Show tasks</button>}>
      <div className="tasks-mobile-filters">
        <label className="tasks-mobile-sort">Sort by<select aria-label="Sort tasks" value={sort} onChange={event => onSortChange(event.target.value as TaskSort)}>{TASK_SORTS.map(value => <option key={value} value={value}>{SORT_LABELS[value]}</option>)}</select></label>
        {choices("Status", TASK_STATUSES, filters.statuses, value => STATUS_LABELS[value], statuses => onChange({ ...filters, statuses }))}
        {choices("Priority", TASK_PRIORITIES, filters.priorities, value => PRIORITY_LABELS[value], priorities => onChange({ ...filters, priorities }))}
        {(labelOptions.length > 0 || filters.labelNames.length > 0) && choices("Labels", [...new Set([...labelOptions.map(option => option.name), ...filters.labelNames])], filters.labelNames, value => value, labelNames => onChange({ ...filters, labelNames }))}
      </div>
    </TasksMobileSheet>
  </>;
}
