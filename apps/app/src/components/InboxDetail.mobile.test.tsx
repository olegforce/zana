// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InboxEntry } from '@zana-ai/zcc-domain/product';

const state = vi.hoisted(() => ({
  compact: true, selected: 'one', saved: false, kept: false, missing: false,
  entries: [] as InboxEntry[],
  readFile: vi.fn(), resolveDoc: vi.fn(), copy: vi.fn(), openIn: vi.fn(), save: vi.fn(), keep: vi.fn(), remove: vi.fn(), exportPdf: vi.fn()
}));
vi.mock('../hooks/useCompactLayout.js', () => ({ useCompactLayout: () => state.compact }));
vi.mock('../store.js', () => ({
  useInbox: (pick: (s: unknown) => unknown) => pick({ entries: state.entries, loading: false }),
  useInboxSelection: (pick: (s: unknown) => unknown) => pick({ selectedEntryId: state.selected, select: vi.fn() }),
  useInboxRead: (pick: (s: unknown) => unknown) => pick({ markRead: vi.fn() }),
  useData: (pick: (s: unknown) => unknown) => pick({ projects: state.missing ? [] : [{ id: 'p', name: 'My project', path: '/project' }], terminals: {}, structuredQuestionsEnabled: false, restoreTerminal: vi.fn(), createTerminal: vi.fn() }),
  useUi: (pick: (s: unknown) => unknown) => pick({ setNav: vi.fn(), selectTab: vi.fn(), pushToast: vi.fn() }),
  useInboxKeep: (pick: (s: unknown) => unknown) => pick({ keptIds: state.kept ? { one: true } : {} }),
  useSavedMark: (pick: (s: unknown) => unknown) => pick({ savedEntryIds: state.saved ? { one: true } : {} }),
  useInboxAnswered: (pick: (s: unknown) => unknown) => pick({ answeredIds: {} }),
  useSuggestions: (pick: (s: unknown) => unknown) => pick({ entries: [] }),
  deleteInboxEntry: (id: string) => state.remove(id),
  toggleInboxKeep: (id: string) => state.keep(id),
  saveInboxEntry: (...args: unknown[]) => state.save(...args),
  replyToInboxEntry: vi.fn()
}));
vi.mock('../lib/product-client.js', () => ({ product: {
  fs: { readFile: (...args: unknown[]) => state.readFile(...args), resolveDoc: (...args: unknown[]) => state.resolveDoc(...args) },
  clipboard: { writeText: (...args: unknown[]) => state.copy(...args) },
  openers: { openIn: (...args: unknown[]) => state.openIn(...args) },
  inbox: { exportPdf: (...args: unknown[]) => state.exportPdf(...args) }
} }));
vi.mock('./AgentLauncher.js', () => ({ AgentLauncher: ({ initialPrompt }: { initialPrompt: string }) => <div data-testid="launcher">{initialPrompt}</div> }));
vi.mock('./InboxQuestionBlock.js', () => ({ QuestionBlock: () => <div>Question</div> }));
vi.mock('./MarkdownContent.js', () => ({ MarkdownContent: ({ text }: { text: string }) => <p>{text}</p>, DocContent: ({ content }: { content: string }) => <p>{content}</p> }));
vi.mock('../lib/renderReportHtml.js', () => ({ renderReportHtml: vi.fn(async () => '<p>Report</p>') }));
vi.mock('../lib/executionInboxBlockerState.js', () => ({ useExecutionInboxBlockerState: () => 'actionable' }));
import { InboxDetail } from './InboxDetail.js';

beforeEach(() => {
  vi.clearAllMocks();
  state.compact = true; state.selected = 'one'; state.saved = false; state.kept = false; state.missing = false;
  state.entries = [{ id: 'one', ts: Date.now(), projectId: 'p', subject: 'A mobile report', comments: 'The useful summary.', docs: [{ path: '.zcc/library/report.md' }] }];
  state.readFile.mockResolvedValue({ ok: true, content: 'Full document content' });
  state.resolveDoc.mockResolvedValue({ ok: false });
  state.copy.mockResolvedValue({ ok: true });
  state.openIn.mockResolvedValue({ ok: true });
  state.save.mockResolvedValue(undefined);
  state.exportPdf.mockResolvedValue({ ok: true });
});
afterEach(cleanup);
const view = () => <MemoryRouter><InboxDetail visible /></MemoryRouter>;
const actions = () => fireEvent.click(screen.getByRole('button', { name: 'Message actions', exact: true }));

it('keeps reading chrome compact and loads documents only when opened', async () => {
  render(view());
  expect(screen.getByText('My project')).toBeTruthy();
  expect(screen.queryByLabelText('Download this inbox entry as PDF')).toBeNull();
  expect(state.readFile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'report.md', exact: true }));
  await screen.findByText('Full document content');
  expect(state.readFile).toHaveBeenCalledWith('/project/.zcc/library/report.md');
  expect(screen.queryByRole('button', { name: /in Finder|in Cursor|in VS Code/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Copy path to .zcc/library/report.md' }));
  await waitFor(() => expect(state.copy).toHaveBeenCalledWith('/project/.zcc/library/report.md'));
});

it('routes labeled actions to the existing keep, save, export, launch and delete handlers', async () => {
  render(view());
  actions(); fireEvent.click(screen.getByRole('button', { name: 'Keep this entry' }));
  expect(state.keep).toHaveBeenCalledWith('one');
  actions(); fireEvent.click(screen.getByRole('button', { name: 'Save for later' }));
  await waitFor(() => expect(state.save).toHaveBeenCalledWith(expect.objectContaining({ sourceEntryId: 'one' }), 'one'));
  actions(); fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
  await waitFor(() => expect(state.exportPdf).toHaveBeenCalled());
  actions(); fireEvent.click(screen.getByRole('button', { name: 'New agent from this message' }));
  expect(screen.getByTestId('launcher').textContent).toContain('The useful summary.');
  actions(); fireEvent.click(screen.getByRole('button', { name: 'Delete message' }));
  expect(state.remove).toHaveBeenCalledWith('one');
});

it('keeps saved/kept state and project availability honest in the action sheet', () => {
  state.saved = true; state.kept = true; state.missing = true;
  render(view());
  actions();
  expect(screen.getByRole('button', { name: 'Saved for later' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Remove keep flag' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('button', { name: 'New agent from this message' })).toBeNull();
});

it('does not offer export/save for an empty entry, and shows failed document reads without desktop openers', async () => {
  state.entries[0] = { ...state.entries[0]!, comments: '', docs: [] };
  const { rerender } = render(view());
  actions();
  expect(screen.queryByRole('button', { name: 'Save for later' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Download PDF' })).toBeNull();
  state.selected = 'two';
  state.entries = [{ ...state.entries[0]!, id: 'two', docs: [{ path: 'missing.md' }] }];
  state.readFile.mockResolvedValue({ ok: false, message: 'Document missing' });
  rerender(view());
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'missing.md' }));
  await screen.findByText('Document missing');
  expect(screen.queryByRole('button', { name: 'Reveal project folder' })).toBeNull();
});

it('keeps desktop actions and file preview behavior, and resets reply drafts for a different entry', async () => {
  const { rerender } = render(view());
  fireEvent.click(screen.getByRole('button', { name: 'Leave a reply' }));
  expect(document.activeElement).toBe(screen.getByRole('textbox'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Draft for the first message' } });
  state.selected = 'two';
  state.entries.push({ ...state.entries[0]!, id: 'two' });
  rerender(view());
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Leave a reply' }));
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  state.compact = false;
  rerender(view());
  expect(screen.queryByRole('button', { name: 'Message actions' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Download this inbox entry as PDF' })).toBeTruthy();
  await screen.findByText('Full document content');
  expect(screen.getByRole('button', { name: /in Finder/ })).toBeTruthy();
});
