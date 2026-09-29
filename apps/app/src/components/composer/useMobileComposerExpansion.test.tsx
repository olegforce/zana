// @vitest-environment happy-dom
import { useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useMobileComposerExpansion } from './useMobileComposerExpansion.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Fixture({ mobile = true }: { mobile?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useMobileComposerExpansion(ref, mobile && open, () => setOpen(false));
  return <>
    <button onClick={(e) => { e.currentTarget.focus(); setOpen(true); }}>Expand</button>
    <div ref={ref} data-testid="root" data-open={open && mobile}>
      <button className="mobile-composer-expanded-done" onClick={() => setOpen(false)}>Done</button>
      <textarea aria-label="Draft" defaultValue="Keep this draft" />
      <button disabled>Unavailable</button>
      <div hidden><button>Hidden metadata</button></div>
      <div style={{ display: 'none' }}><button>Hidden toolbar</button></div>
      <button style={{ visibility: 'hidden' }}>Invisible</button>
      <button>Send</button>
    </div>
  </>;
}

it('focuses Done, traps visible controls, and restores the opener without replacing the draft', () => {
  render(<Fixture />);
  const draft = screen.getByLabelText('Draft');
  const expand = screen.getByText('Expand');
  fireEvent.click(expand);
  const done = screen.getByText('Done');
  expect(document.activeElement).toBe(done);
  fireEvent.keyDown(done, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(screen.getByText('Send'));
  fireEvent.keyDown(screen.getByText('Send'), { key: 'Tab' });
  expect(document.activeElement).toBe(done);
  draft.focus();
  fireEvent.keyDown(draft, { key: 'Tab' });
  expect(document.activeElement).toBe(draft); // ordinary Tab is left to the browser
  fireEvent.change(draft, { target: { value: 'Still here after resizing' } });
  fireEvent.keyDown(done, { key: 'Escape' });
  expect(screen.getByTestId('root').getAttribute('data-open')).toBe('false');
  expect(document.activeElement).toBe(expand);
  expect(screen.getByLabelText('Draft')).toBe(draft);
  expect((draft as HTMLTextAreaElement).value).toBe('Still here after resizing');
});

it('follows the visual viewport and releases geometry/listeners when returning to desktop', () => {
  const viewport = new EventTarget() as EventTarget & { height: number; offsetTop: number };
  Object.assign(viewport, { height: 800, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  const removed = vi.spyOn(viewport, 'removeEventListener');
  const { rerender } = render(<Fixture />);
  fireEvent.click(screen.getByText('Expand'));
  const root = screen.getByTestId('root');
  expect(root.style.height).toBe('800px');
  viewport.height = 360;
  viewport.offsetTop = 24;
  viewport.dispatchEvent(new Event('resize'));
  viewport.dispatchEvent(new Event('scroll'));
  expect(root.style.height).toBe('360px');
  expect(root.style.top).toBe('24px');
  rerender(<Fixture mobile={false} />);
  expect(root.style.height).toBe('');
  expect(root.style.top).toBe('');
  expect(removed).toHaveBeenCalledWith('resize', expect.any(Function));
  expect(removed).toHaveBeenCalledWith('scroll', expect.any(Function));
});

it('uses window geometry when VisualViewport is absent and handles closing with Done', () => {
  vi.stubGlobal('visualViewport', undefined);
  const removed = vi.spyOn(window, 'removeEventListener');
  const { unmount } = render(<Fixture />);
  fireEvent.click(screen.getByText('Expand'));
  window.dispatchEvent(new Event('resize'));
  expect(screen.getByTestId('root').style.height).toBe(`${window.innerHeight}px`);
  fireEvent.click(screen.getByText('Done'));
  expect(document.activeElement).toBe(screen.getByText('Expand'));
  fireEvent.click(screen.getByText('Expand'));
  unmount();
  expect(removed).toHaveBeenCalledWith('resize', expect.any(Function));
});

it('leaves nested menus, expanded options and handled editor keys to their owners', () => {
  render(<Fixture />);
  fireEvent.click(screen.getByText('Expand'));
  const done = screen.getByText('Done');
  const root = screen.getByTestId('root');
  done.setAttribute('aria-haspopup', 'listbox');
  done.setAttribute('aria-expanded', 'true');
  fireEvent.keyDown(done, { key: 'Escape' });
  expect(root.getAttribute('data-open')).toBe('true');
  done.removeAttribute('aria-haspopup');
  done.classList.add('thread-command-options-toggle');
  fireEvent.keyDown(done, { key: 'Escape' });
  expect(root.getAttribute('data-open')).toBe('true');
  done.removeAttribute('aria-expanded');
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  event.preventDefault();
  done.dispatchEvent(event);
  expect(root.getAttribute('data-open')).toBe('true');
});
