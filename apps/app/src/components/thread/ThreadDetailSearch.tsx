import { useEffect, useRef, type FormEvent, type KeyboardEvent } from 'react';
import { Search, X } from 'lucide-react';

export function threadDetailSearchClassName(draft: string): string {
  return draft.trim().length > 0 ? 'thread-detail-search has-query' : 'thread-detail-search';
}

export function ThreadDetailSearch({
  value,
  onChange,
  onSubmit,
  mobileHeader = false,
  autoFocus = false,
  onClose
}: {
  value: string;
  mobileHeader?: boolean;
  autoFocus?: boolean;
  onClose?: () => void;
  onChange: (value: string) => void;
  onSubmit: (needle: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(value.trim());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    onChange('');
    onSubmit('');
    event.currentTarget.blur();
    onClose?.();
  };

  return (
    <form
      className={threadDetailSearchClassName(value)}
      data-testid="thread-detail-search"
      onSubmit={submit}
    >
      <button
        type="button"
        className="icon-btn thread-detail-search-toggle"
        aria-label="Search in thread"
        onPointerDown={(event) => {
          // Focusing the toggle would move it as the mobile header expands,
          // before the tap can click it and focus the input.
          if (mobileHeader) event.preventDefault();
        }}
        onClick={() => inputRef.current?.focus()}
      >
        <Search size={14} />
      </button>
      <input
        ref={inputRef}
        type="search"
        value={value}
        aria-label="Search in thread"
        placeholder="Search"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {mobileHeader && <button
        type="button"
        className="icon-btn thread-detail-search-close"
        aria-label="Close search"
        onClick={(event) => {
          onChange('');
          onSubmit('');
          inputRef.current?.blur();
          event.currentTarget.blur();
          onClose?.();
        }}
      ><X size={18} aria-hidden="true" /></button>}
    </form>
  );
}
