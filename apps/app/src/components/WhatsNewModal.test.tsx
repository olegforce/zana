// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  open: true,
  notes: [{ version: '2.3.0', markdown: '# Release 2.3.0' }],
  toVersion: '2.3.0' as string | null,
  close: vi.fn(),
}));
vi.mock('../store.js', () => ({ useWhatsNew: (selector: (value: typeof state) => unknown) => selector(state) }));
vi.mock('./MarkdownContent.js', () => ({ MarkdownContent: ({ text }: { text: string }) => <div>{text}</div> }));
import { WhatsNewModal } from './WhatsNewModal.js';

afterEach(() => {
  cleanup();
  state.open = true;
  state.notes = [{ version: '2.3.0', markdown: '# Release 2.3.0' }];
  state.toVersion = '2.3.0';
  state.close.mockClear();
});

describe('WhatsNewModal video', () => {
  it('shows the walkthrough with the release notes and closes normally', () => {
    render(<WhatsNewModal />);
    expect(screen.getByRole('dialog', { name: 'What’s new in v2.3.0' })).toBeTruthy();
    expect(screen.getByLabelText('Use Zana everywhere walkthrough')).toBeTruthy();
    expect(screen.getByText('# Release 2.3.0')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(state.close).toHaveBeenCalledOnce();
  });

  it('unmounts the player when the notes close', () => {
    const { rerender } = render(<WhatsNewModal />);
    state.open = false;
    rerender(<WhatsNewModal />);
    expect(screen.queryByLabelText('Use Zana everywhere walkthrough')).toBeNull();
  });

  it('does not open an empty release list', () => {
    state.notes = [];
    render(<WhatsNewModal />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps media attached to its version when browsing older notes', () => {
    state.toVersion = null;
    state.notes.push({ version: '2.2.0', markdown: '# Previous release' });
    render(<WhatsNewModal />);
    expect(screen.getByRole('dialog', { name: 'What’s new' })).toBeTruthy();
    expect(screen.getAllByLabelText('Use Zana everywhere walkthrough')).toHaveLength(1);
    expect(screen.getByText('v2.2.0')).toBeTruthy();
    expect(screen.getByText('# Previous release')).toBeTruthy();
  });
});
