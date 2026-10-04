// @vitest-environment happy-dom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), list: vi.fn(), write: vi.fn(), toast: vi.fn(), remoteRoot: vi.fn(), listRemote: vi.fn(), readRemote: vi.fn(), hosts: [] as any[] }));
vi.mock('@/lib/monacoSetup', () => ({}));
vi.mock('../../hooks/useHosts.js', () => ({ useHosts: () => mocks.hosts }));
vi.mock('@/hooks/useMonacoTheme', () => ({ useMonacoTheme: () => 'dark' }));
vi.mock('@/hooks/useFileDrop', () => ({ useFileDrop: () => ({ dropOver: false, dropHandlers: {} }) }));
vi.mock('@/components/AiEnhanceSelection', () => ({ useAiEnhanceSelection: () => ({ registerEditor: vi.fn(), modal: null }) }));
vi.mock('../../lib/product-client.js', () => ({ product: {
  fs: { listDir: mocks.list, readFile: mocks.read, writeFile: mocks.write, remoteRoot: mocks.remoteRoot, listDirRemote: mocks.listRemote, readFileRemote: mocks.readRemote },
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
  mocks.remoteRoot.mockResolvedValue({ ok: true, root: '/remote' });
  mocks.listRemote.mockResolvedValue([{ name: 'owner.txt', path: '/remote/owner.txt', kind: 'file' }]);
  mocks.readRemote.mockResolvedValue({ ok: true, content: 'ssh-remote' });
  window.confirm = vi.fn().mockReturnValue(false);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('edits only the thread-pinned checkout with its read revision, without a machine selector', async () => {
  render(<ExplorerView project={project} embedded scope={{ projectId: 'p', hostId: 'b' }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'owner.txt' }));
  expect(await screen.findByDisplayValue('machine-b')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('File contents'), { target: { value: 'edit-b' } });
  fireEvent.click(screen.getByText('Save fixture'));
  await waitFor(() => expect(mocks.write).toHaveBeenCalledWith('/b/owner.txt', 'edit-b', { projectId: 'p', hostId: 'b' }, 'revision'));
  expect(screen.getByText('no native openers')).toBeTruthy();
  expect(screen.queryByRole('combobox')).toBeNull();
});
it('keeps the project target and dirty buffer when the machine roster changes', async () => {
  const view = render(<ExplorerView project={project} />);
  fireEvent.click(await screen.findByRole('button', { name: 'owner.txt' }));
  await screen.findByDisplayValue('machine-a');
  fireEvent.change(screen.getByLabelText('File contents'), { target: { value: 'unsaved' } });
  mocks.hosts.reverse();
  view.rerender(<ExplorerView project={project} />);
  expect(screen.getByDisplayValue('unsaved')).toBeTruthy();
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(mocks.list.mock.calls.every(([path]) => path === '/a')).toBe(true);
});
it('keeps existing project navigation working on the original source', async () => {
  render(<ExplorerView project={project} />);
  await act(async () => { useUi.getState().setExplorerFile('p', '/a/owner.txt'); });
  expect(await screen.findByDisplayValue('machine-a')).toBeTruthy();
});
it('pins a thread to its historical environment even after its source is removed', async () => {
  render(<ExplorerView project={{ ...project, sources: [] }} scope={{ projectId: 'p', hostId: 'b', environmentId: 'historical' }} checkoutPath="/old" />);
  await waitFor(() => expect(mocks.list).toHaveBeenCalledWith('/old', { projectId: 'p', hostId: 'b', environmentId: 'historical' }));
  expect(screen.queryByRole('combobox')).toBeNull();
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
  expect(screen.getByRole('alert').textContent).toBe('Project checkout is unavailable.');
  expect(mocks.list).not.toHaveBeenCalled();
});
it('remounts the explorer when a source path changes on the same host', async () => {
  const scope = { projectId: 'p', hostId: 'b' };
  const view = render(<ExplorerView project={project} scope={scope} />);
  await waitFor(() => expect(mocks.list).toHaveBeenCalledWith('/b', scope));
  view.rerender(<ExplorerView project={{ ...project, sources: [{ ...project.sources[0], path: '/replacement' }] }} scope={scope} />);
  await waitFor(() => expect(mocks.list).toHaveBeenCalledWith('/replacement', scope));
});
it('shows no machine selector for local projects, including embedded explorers', async () => {
  const local = { ...project, sources: [] };
  const view = render(<ExplorerView project={local} />);
  await screen.findByRole('button', { name: 'owner.txt' });
  expect(screen.queryByRole('combobox', { name: 'Explorer machine' })).toBeNull();
  view.rerender(<ExplorerView project={local} embedded scope={{ projectId: 'p', hostId: 'a' }} />);
  expect(screen.queryByRole('combobox', { name: 'Explorer machine' })).toBeNull();
  expect(view.container.querySelector('.explorer-view.is-embedded')).toBeTruthy();
});
it('uses a remote-host project target without a machine selector', async () => {
  render(<ExplorerView project={{ ...project, hostId: 'b', path: '/b', sources: [] }} />);
  await screen.findByRole('button', { name: 'owner.txt' });
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(mocks.list).toHaveBeenCalledWith('/b', { projectId: 'p', hostId: 'b' });
});
it('shows an offline project error without adding a machine selector', async () => {
  mocks.hosts[0].status = 'disconnected';
  mocks.list.mockRejectedValueOnce(new Error('Project is offline'));
  render(<ExplorerView project={{ ...project, sources: [] }} />);
  expect((await screen.findByRole('alert')).textContent).toBe('Project is offline');
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(mocks.list).toHaveBeenCalledWith('/a', { projectId: 'p', hostId: 'a' });
});
it('retains the registered target when its host is absent from the roster', async () => {
  mocks.hosts = [mocks.hosts[1]];
  render(<ExplorerView project={{ ...project, sources: [] }} />);
  await screen.findByRole('button', { name: 'owner.txt' });
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(mocks.list).toHaveBeenCalledWith('/a', { projectId: 'p', hostId: 'a' });
});
it('uses the primary target for legacy local projects without a recorded host', async () => {
  render(<ExplorerView project={{ ...project, hostId: undefined }} />);
  await screen.findByRole('button', { name: 'owner.txt' });
  expect(mocks.list).toHaveBeenCalledWith('/a', { projectId: 'p', hostId: 'a' });
  expect(screen.queryByRole('combobox')).toBeNull();
});
it('keeps an SSH project on its remote filesystem without a machine selector', async () => {
  render(<ExplorerView project={{ ...project, path: '/placeholder', remote: { host: 'ssh-host', remotePath: '/remote' } }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'owner.txt' }));
  await screen.findByDisplayValue('ssh-remote');
  expect(mocks.remoteRoot).toHaveBeenCalledWith('p');
  expect(mocks.listRemote).toHaveBeenCalledWith('p', '/remote');
  expect(mocks.readRemote).toHaveBeenCalledWith('p', '/remote/owner.txt');
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.read).not.toHaveBeenCalled();
  expect(screen.queryByRole('combobox')).toBeNull();
});
