// @vitest-environment happy-dom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileMessagePreview } from './MobileMessagePreview.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(height = 200, enabled = true) {
  const size = { height, viewport: 72 };
  const observers: Array<{ resize: () => void; disconnect: ReturnType<typeof vi.fn> }> = [];
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
    return this.classList.contains('mobile-message-preview-content') ? size.height : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () {
    return this.classList.contains('mobile-message-preview-viewport') ? size.viewport : 0;
  });
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn();
    disconnect = vi.fn();
    constructor(public resize: () => void) { observers.push(this); }
  });
  const change = vi.fn();
  function Harness({ enabled }: { enabled: boolean }) {
    const [expanded, setExpanded] = useState(false);
    return <MobileMessagePreview enabled={enabled} expanded={expanded} onExpandedChange={(value) => {
      change(value); setExpanded(value);
    }}><p>Full message with an <a href="#file">attached file</a></p></MobileMessagePreview>;
  }
  const result = render(<Harness enabled={enabled} />);
  return { ...result, size, observers, change, setEnabled: (value: boolean) => result.rerender(<Harness enabled={value} />) };
}

describe('mobile sent message preview', () => {
  it('expands and collapses overflowing content through an accessible control', () => {
    const { observers, change } = fixture();
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    const more = screen.getByRole('button', { name: 'Show more' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(more.getAttribute('aria-controls')!)?.textContent).toContain('Full message');
    fireEvent.click(more);
    expect(scroll).toHaveBeenCalledWith({ block: 'start', inline: 'nearest' });
    expect(change).toHaveBeenLastCalledWith(true);
    expect(observers[0]!.disconnect).toHaveBeenCalledOnce();
    const less = screen.getByRole('button', { name: 'Show less' });
    expect(less.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(less);
    expect(scroll).toHaveBeenCalledTimes(2);
    expect(change).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
  });

  it('only offers expansion when text, loaded images or viewport reflow exceed the budget', () => {
    const { size, observers, unmount } = fixture(50);
    expect(screen.queryByRole('button')).toBeNull();
    size.height = 120;
    act(() => observers[0]!.resize());
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
    size.viewport = 130;
    act(() => observers[0]!.resize());
    expect(screen.queryByRole('button')).toBeNull();
    unmount();
    expect(observers[0]!.disconnect).toHaveBeenCalledOnce();
  });

  it('leaves disabled content untouched and cleans up when switching back to desktop', () => {
    const { container, observers, setEnabled } = fixture(200, false);
    expect(container.querySelector('.mobile-message-preview')).toBeNull();
    expect(screen.getByRole('link').textContent).toBe('attached file');
    expect(observers).toHaveLength(0);
    setEnabled(true);
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
    setEnabled(false);
    expect(observers[0]!.disconnect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('reveals clipped keyboard targets without expanding for a visible attachment', () => {
    const { container, change } = fixture();
    const link = screen.getByRole('link');
    const viewport = container.querySelector('.mobile-message-preview-viewport')!;
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ bottom: 72 } as DOMRect);
    const rect = vi.spyOn(link, 'getBoundingClientRect').mockReturnValue({ bottom: 40 } as DOMRect);
    fireEvent.focus(link);
    expect(change).not.toHaveBeenCalled();
    rect.mockReturnValue({ bottom: 150 } as DOMRect);
    fireEvent.focus(link);
    expect(change).toHaveBeenCalledWith(true);
    fireEvent.focus(link);
    expect(change).toHaveBeenCalledOnce();
  });

  it('measures once when ResizeObserver is unavailable', () => {
    const { setEnabled } = fixture(200, false);
    vi.stubGlobal('ResizeObserver', undefined);
    setEnabled(true);
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
  });
});
