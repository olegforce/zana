const EDITOR_SELECTOR = 'input, textarea, select, iframe, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]';
const POPUP_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [popover]';
const MODAL_SELECTOR = 'dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"], .palette-backdrop, .modal-backdrop, .consent-overlay';

function isDisplayed(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (node.hasAttribute('hidden') || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return true;
}

function ownsTextInput(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(EDITOR_SELECTOR));
}

/** A visible Inbox is not necessarily the keyboard owner (editors and portals are independent surfaces). */
export function isInboxListShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const scope = target.closest('.inbox-view');
  if (!scope || target.closest(POPUP_SELECTOR)) return false;
  const doc = target.ownerDocument;
  const active = doc.activeElement;
  if (active && active !== doc.body && !scope.contains(active)) return false;
  if (ownsTextInput(target) || ownsTextInput(active) || event.composedPath().some(ownsTextInput)) return false;
  // Also block a modal whose focus has not moved yet, or has escaped to the background.
  return !Array.from(doc.querySelectorAll(MODAL_SELECTOR)).some(isDisplayed);
}

export function confirmInboxDeletion(kind: 'message' | 'saved report'): boolean {
  return window.confirm(`Delete this ${kind} permanently?\n\nThis cannot be undone.`);
}
