// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmInboxDeletion, isInboxListShortcut } from './inbox-keyboard.js';

let scope: HTMLElement;
let row: HTMLButtonElement;

beforeEach(() => {
  document.body.innerHTML = '<section class="inbox-view"><button>Message</button></section>';
  scope = document.querySelector('.inbox-view')!;
  row = scope.querySelector('button')!;
  row.focus();
});
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function allowed(target: EventTarget, init: KeyboardEventInit = {}, prepare?: (event: KeyboardEvent) => void): boolean {
  let result = false;
  const listener = (event: KeyboardEvent) => { result = isInboxListShortcut(event); };
  window.addEventListener('keydown', listener);
  try {
    const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, composed: true, cancelable: true, ...init });
    prepare?.(event);
    target.dispatchEvent(event);
    return result;
  } finally {
    window.removeEventListener('keydown', listener);
  }
}

describe('Inbox shortcut ownership', () => {
  it('accepts focused rows and ordinary detail content in the Inbox', () => {
    expect(allowed(row)).toBe(true);
    const text = document.createElement('p');
    scope.appendChild(text);
    expect(allowed(text)).toBe(true);
    row.blur();
    expect(allowed(text)).toBe(true);
  });

  it.each(['metaKey', 'ctrlKey', 'altKey', 'isComposing'])('ignores %s events', (flag) => {
    expect(allowed(row, { [flag]: true })).toBe(false);
  });

  it('respects an event already consumed by a child', () => {
    expect(allowed(row, {}, (event) => event.preventDefault())).toBe(false);
  });

  it.each([
    '<input>', '<textarea></textarea>', '<select><option>One</option></select>',
    '<div contenteditable="true"><span>Nested text</span></div>',
    '<div contenteditable><span>Inherited editing</span></div>',
    '<div contenteditable="plaintext-only"><span>Plain text</span></div>',
    '<div role="textbox"><span>Custom editor</span></div>',
    '<div role="combobox"><span>Custom picker</span></div>'
  ])('ignores text controls and their descendants: %s', (html) => {
    const container = document.createElement('div');
    container.innerHTML = html;
    scope.appendChild(container);
    expect(allowed(container.querySelector('span') ?? container.firstElementChild!)).toBe(false);
  });

  it('does not treat explicitly non-editable ordinary content as an editor', () => {
    const text = document.createElement('div');
    text.contentEditable = 'false';
    scope.appendChild(text);
    expect(allowed(text)).toBe(true);
  });

  it('checks the active editor as well as the event target', () => {
    const input = document.createElement('input');
    scope.appendChild(input);
    input.focus();
    expect(allowed(row)).toBe(false);
  });

  it('checks editors in a composed event path through a shadow host', () => {
    const host = document.createElement('div');
    scope.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<input>';
    expect(allowed(shadow.querySelector('input')!)).toBe(false);
  });

  it('rejects document/window events and interaction outside the Inbox', () => {
    expect(allowed(window)).toBe(false);
    expect(allowed(document.body)).toBe(false);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    expect(allowed(outside)).toBe(false);
    outside.focus();
    expect(allowed(row)).toBe(false);
  });

  it.each(['dialog', 'alertdialog', 'menu', 'listbox'])('ignores an inline %s popup', (role) => {
    const popup = document.createElement('div');
    popup.setAttribute('role', role);
    scope.appendChild(popup);
    popup.appendChild(row);
    expect(allowed(row)).toBe(false);
  });

  it('ignores an inline popover', () => {
    const popup = document.createElement('div');
    popup.setAttribute('popover', 'auto');
    scope.appendChild(popup);
    popup.appendChild(row);
    expect(allowed(row)).toBe(false);
  });

  it.each([
    '<div role="dialog" aria-modal="true"></div>', '<div role="alertdialog"></div>',
    '<dialog open></dialog>', '<div class="palette-backdrop"></div>',
    '<div class="modal-backdrop"></div>', '<div class="consent-overlay"></div>'
  ])('suspends shortcuts with an open overlay even if focus escaped: %s', (html) => {
    document.body.insertAdjacentHTML('beforeend', html);
    expect(allowed(row)).toBe(false);
  });

  it.each(['hidden', 'style="display: none"', 'style="visibility: hidden"', 'style="visibility: collapse"'])('ignores overlays with a hidden ancestor (%s)', (attribute) => {
    document.body.insertAdjacentHTML('beforeend', `<div ${attribute}><div role="dialog" aria-modal="true"></div></div>`);
    expect(allowed(row)).toBe(true);
  });

  it('ignores a closed native dialog', () => {
    document.body.insertAdjacentHTML('beforeend', '<dialog></dialog>');
    expect(allowed(row)).toBe(true);
  });
});

describe('permanent delete confirmation', () => {
  it.each(['message', 'saved report'] as const)('requires explicit confirmation for a %s', (kind) => {
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirm);
    expect(confirmInboxDeletion(kind)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(`Delete this ${kind} permanently?\n\nThis cannot be undone.`);
    confirm.mockReturnValue(true);
    expect(confirmInboxDeletion(kind)).toBe(true);
  });
});
