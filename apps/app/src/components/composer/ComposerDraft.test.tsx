// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { EditorContent, type JSONContent } from '@tiptap/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerDraftProvider } from './ComposerDraft.js';
import { useComposerPromptField } from './use-composer-prompt-field.js';
import { mentionAttrsForSuggestion } from './mention-attrs.js';

vi.mock('../../lib/fetch-with-app-surface.js', () => ({ apiJson: async () => ({}) }));
vi.mock('../../lib/app-surface.js', () => ({ hasDesktopBridge: () => false }));
vi.mock('../../lib/product-client.js', () => ({
  product: {
    pluginApps: { onChanged: () => () => {} },
    skills: { onChanged: () => () => {} },
    threads: { commands: async () => ({ commands: [] }) },
    commands: { list: async () => [] }
  }
}));
vi.mock('./use-composer-suggestions.js', () => ({
  useMentionProviderRows: () => [],
  useComposerSuggestions: () => ({ suggestions: [], menuOpen: false })
}));

let field: ReturnType<typeof useComposerPromptField>;
function Probe({ initialText }: { initialText?: string }) {
  field = useComposerPromptField({
    placeholder: 'Prompt', testId: 'prompt', projectId: 'project', projects: [],
    initialText, slashCatalog: { kind: 'cli' }, onSubmit: () => {}
  });
  return <EditorContent editor={field.editor} />;
}
function Surface({ mode, initialText }: { mode: string; initialText?: string }) {
  return <ComposerDraftProvider><Probe key={mode} initialText={initialText} /></ComposerDraftProvider>;
}
const ready = () => waitFor(() => expect(field.editor).not.toBeNull());
beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('shared composer draft', () => {
  it('preserves rich text and mention identities through repeated mode changes', async () => {
    const { rerender } = render(<Surface mode="cli" />);
    await ready();
    const content: JSONContent = {
      type: 'doc', content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'Review this ', marks: [{ type: 'bold' }] },
        { type: 'mention', attrs: mentionAttrsForSuggestion({ kind: 'project', projectId: 'project', name: 'Example' }) }
      ] }, { type: 'paragraph', content: [{ type: 'text', text: 'Second line' }] }]
    };
    act(() => { field.editor!.commands.setContent(content); });
    const saved = field.editor!.getJSON();
    const serialized = field.serialize();
    expect(serialized.mentions).toHaveLength(1);
    for (const mode of ['modern', 'squad', 'cli']) {
      const previous = field.editor;
      rerender(<Surface mode={mode} />);
      await ready();
      expect(field.editor).not.toBe(previous);
      expect(field.editor!.getJSON()).toEqual(saved);
      expect(field.serialize()).toEqual(serialized);
    }
    act(() => { field.setText('Edited in CLI'); });
    rerender(<Surface mode="squad" />);
    await ready();
    expect(field.text).toBe('Edited in CLI');
  });

  it('seeds once and keeps the edited draft instead of restoring the original seed', async () => {
    const { rerender } = render(<Surface mode="cli" initialText="Original seed" />);
    await ready();
    expect(field.text).toBe('Original seed');
    act(() => { field.setText('Edited seed'); });
    rerender(<Surface mode="modern" initialText="Original seed" />);
    await ready();
    expect(field.text).toBe('Edited seed');
  });

  it.each(['clear', 'delete'] as const)('keeps an empty draft after %s instead of resurrecting a seed', async (action) => {
    const { rerender } = render(<Surface mode="modern" initialText="Original seed" />);
    await ready();
    act(() => { action === 'clear' ? field.clear() : field.setText(''); });
    rerender(<Surface mode="squad" initialText="Original seed" />);
    await ready();
    expect(field.text).toBe('');
  });

  it('does not leak drafts into a different launcher or an existing thread composer', async () => {
    const { unmount } = render(<Surface mode="cli" initialText="Private draft" />);
    await ready();
    expect(field.text).toBe('Private draft');
    unmount();
    const other = render(<Surface mode="modern" />);
    await ready();
    expect(field.text).toBe('');
    other.unmount();
    render(<Probe initialText="Thread follow-up" />);
    await ready();
    expect(field.text).toBe('Thread follow-up');
  });
});
