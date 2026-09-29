// @vitest-environment happy-dom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { create } from 'zustand';
const mocks = vi.hoisted(() => ({ read: vi.fn(), list: vi.fn(), write: vi.fn(), toast: vi.fn(), hosts: [] as any[] }));
vi.mock('@/lib/monacoSetup', () => ({}));
vi.mock('../../hooks/useHosts.js', () => ({ useHosts: () => mocks.hosts }));
vi.mock('@/hooks/useMonacoTheme', () => ({ useMonacoTheme: () => 'dark' }));
vi.mock('@/hooks/useFileDrop', () => ({ useFileDrop: () => ({ dropOver: false, dropHandlers: {} }) }));
vi.mock('@/components/AiEnhanceSelection', () => ({ useAiEnhanceSelection: () => ({ registerEditor: vi.fn(), modal: null }) }));
vi.mock('../../lib/product-client.js', () => ({ product: {
  fs: { listDir: mocks.list, readFile: mocks.read, writeFile: mocks.write },
  git: { status: async () => null, listWorktrees: async () => [], listBranches: async () => [] },
  environments: { list: async () => [] }
} }));
vi.mock('@/store', async () => {
  const { create } = await import('zustand');
  const useUi = create<any>((set: any) => ({ explorerFile: {}, explorerGoto: {}, explorerTreeMode: {}, explorerDiff: {},
    pushToast: mocks.toast, setProjectView: vi.fn(), selectTab: vi.fn(), setExplorerTreeMode: vi.fn(), setExplorerDiff: vi.fn(),
    setExplorerFile: (id: string, path: string) => set((state: any) => ({ explorerFile: { ...state.explorerFile, [id]: path } }))
  }));
  const useData = create<any>(() => ({ gitStatus: {}, createTerminal: vi.fn(), loadGitStatus: vi.fn() }));
  return { useUi, useData };
});
vi.mock('@/components/explorer', () => ({
  WorktreeMenu: () => null, ExplorerGitFooter: () => null, ExplorerTreeHeader: () => null,
  ExplorerContextMenu: () => null, ChangesList: () => null, useFileOperations: () => ({}),
  TreeList: ({ list, onFileClick }: any) => <>{list.map((row: any) => <button key={row.path} onClick={() => onFileClick(row)}>{row.name}</button>)}</>,
  FileViewer: ({ fileResult, editedContent, onContentChange, onSave, nativeFiles }: any) => <div>
    {fileResult?.ok && <textarea aria-label="File contents" value={editedContent ?? fileResult.content} onChange={event => onContentChange(event.target.value)} />}
    <button onClick={onSave}>Save fixture</button><span>{nativeFiles ? 'native openers' : 'no native openers'}</span>
  </div>
}));
import { ExplorerView } from './ExplorerView.js';
import { useUi } from '@/store';
const project: any = { id: 'p', name: 'Shared', path: '/a', hostId: 'a', sources: [{ id: 'source-b', hostId: 'b', path: '/b', createdAt: 1 }] };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.hosts = [{ id: 'a', name: 'Primary', isPrimary: true, status: 'connected' }, { id: 'b', name: 'Secondary', status: 'connected' }];
  useUi.setState({ explorerFile: {}, explorerGoto: {} });
  mocks.list.mockImplementation(async (path: string) => [{ name: 'owner.txt', path: `${path}/owner.txt`, kind: 'file' }]);
  mocks.read.mockImplementation(async (_path: string, scope: any) => ({ ok: true, content: `machine-${scope.hostId}`, sha256: 'revision' }));
  mocks.write.mockResolvedValue({ ok: true, sha256: 'next', bytes: 4 });
  window.confirm = vi.fn().mockReturnValue(false);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('switches machine and edits only that source with its read revision', async () => {
  render(<ExplorerView project={project} />);
  await screen.findByRole('button', { name: 'owner.txt' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Explorer machine' }), { target: { value: 'b' } });
  fireEvent.click(await screen.findByRole('button', { name: 'owner.txt' }));
  expect(await screen.findByDisplayValue('machine-b')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('File contents'), { target: { value: 'edit-b' } });
  fireEvent.click(screen.getByText('Save fixture'));
  await waitFor(() => expect(mocks.write).toHaveBeenCalledWith('/b/owner.txt', 'edit-b', { projectId: 'p', hostId: 'b' }, 'revision'));
  expect(screen.getByText('no native openers')).toBeTruthy();
});
it('keeps unsaved contents if switching machines is cancelled', async () => {
  render(<ExplorerView project={project} />);
  fireEvent.click(await screen.findByRole('button', { name: 'owner.txt' }));
  await screen.findByDisplayValue('machine-a');
  fireEvent.change(screen.getByLabelText('File contents'), { target: { value: 'unsaved' } });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } });
  expect(window.confirm).toHaveBeenCalled(); expect(screen.getByDisplayValue('unsaved')).toBeTruthy();
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('a');
});
it('keeps existing project navigation working on the original source', async () => {
  render(<ExplorerView project={project} />);
  await act(async () => { useUi.getState().setExplorerFile('p', '/a/owner.txt'); });
  expect(await screen.findByDisplayValue('machine-a')).toBeTruthy();
});
it('pins a thread to its historical environment even after its source is removed', async () => {
  render(<ExplorerView project={{ ...project, sources: [] }} scope={{ projectId: 'p', hostId: 'b', environmentId: 'historical' }} checkoutPath="/old" />);
  await waitFor(() => expect(mocks.list).toHaveBeenCalledWith('/old', { projectId: 'p', hostId: 'b', environmentId: 'historical' }));
  expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
});
it('shows offline read failure without using the primary filesystem', async () => {
  mocks.hosts[1].status = 'disconnected'; mocks.list.mockRejectedValue(new Error('Machine unavailable'));
  render(<ExplorerView project={project} scope={{ projectId: 'p', hostId: 'b' }} />);
  expect((await screen.findByRole('alert')).textContent).toContain('Machine unavailable');
  expect(screen.queryByText('Empty directory.')).toBeNull();
  expect(mocks.list).toHaveBeenCalledWith('/b', { projectId: 'p', hostId: 'b' });
  expect(mocks.list.mock.calls.every(([path]) => path === '/b')).toBe(true);
});
it('keeps a dirty buffer when a save conflicts or the host disconnects', async () => {
  render(<ExplorerView project={project} />);
  fireEvent.click(await screen.findByRole('button', { name: 'owner.txt' })); await screen.findByDisplayValue('machine-a');
  fireEvent.change(screen.getByLabelText('File contents'), { target: { value: 'unsaved' } });
  mocks.write.mockResolvedValueOnce({ ok: false, message: 'file changed' });
  fireEvent.click(screen.getByText('Save fixture'));
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('file changed', 'error'));
  mocks.write.mockRejectedValueOnce(new Error('offline')); fireEvent.click(screen.getByText('Save fixture'));
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('offline', 'error'));
  expect(screen.getByDisplayValue('unsaved')).toBeTruthy();
});
it('does not erase keystrokes entered while a save is pending', async () => {
  let finish!: (value: any) => void;
  mocks.write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<ExplorerView project={project} />);
  fireEvent.click(await screen.findByRole('button', { name: 'owner.txt' })); await screen.findByDisplayValue('machine-a');
  fireEvent.change(screen.getByLabelText('File contents'), { target: { value: 'first edit' } });
  fireEvent.click(screen.getByText('Save fixture'));
  fireEvent.change(screen.getByLabelText('File contents'), { target: { value: 'newer edit' } });
  await act(async () => finish({ ok: true, sha256: 'next' }));
  expect(screen.getByDisplayValue('newer edit')).toBeTruthy();
  fireEvent.click(screen.getByText('Save fixture'));
  await waitFor(() => expect(mocks.write).toHaveBeenLastCalledWith('/a/owner.txt', 'newer edit', { projectId: 'p', hostId: 'a' }, 'next'));
});
it('does not select a sole connected foreign machine when primary identity is absent', () => {
  mocks.hosts = [{ id: 'b', name: 'Secondary', status: 'connected' }];
  render(<ExplorerView project={{ ...project, hostId: undefined }} />);
  expect(screen.getByText('Choose a machine with a registered checkout for this project.')).toBeTruthy();
  expect(mocks.list).not.toHaveBeenCalled();
});
it('remounts the explorer when a source path changes on the same host', async () => {
  const scope = { projectId: 'p', hostId: 'b' };
  const view = render(<ExplorerView project={project} scope={scope} />);
  await waitFor(() => expect(mocks.list).toHaveBeenCalledWith('/b', scope));
  view.rerender(<ExplorerView project={{ ...project, sources: [{ ...project.sources[0], path: '/replacement' }] }} scope={scope} />);
  await waitFor(() => expect(mocks.list).toHaveBeenCalledWith('/replacement', scope));
});
