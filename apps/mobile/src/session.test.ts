import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeSessionProvider, useNativeSession } from './session';
import type { ServerProfile } from './lib/profiles';
import type { SessionControllerDeps } from './lib/session-controller';

const fixture = vi.hoisted(() => ({
  profiles: { state: { activeId: 'a', profiles: [] as ServerProfile[] } },
  platform: { OS: 'android' },
  connect: vi.fn(),
  subscribe: vi.fn(),
  stop: vi.fn(),
  callbacks: undefined as SessionControllerDeps | undefined
}));
vi.mock('./state', () => ({ useProfiles: () => fixture.profiles }));
vi.mock('react-native', () => ({
  AppState: { addEventListener: fixture.subscribe },
  Platform: fixture.platform
}));
vi.mock('@react-native-cookies/cookies', () => ({ default: {} }));
vi.mock('./lib/session-controller', () => ({ connectNativeProfile: fixture.connect }));
let renderer: ReactTestRenderer | undefined;
let snapshots: ReturnType<typeof useNativeSession>[] = [];
function Page() {
  snapshots.push(useNativeSession());
  return null;
}
const profile = (id: string, credential: string): ServerProfile => ({ id, label: id, credential: credential.padEnd(43, 'x'), serverUrl: 'https://s-aaaaaaaaaaaaaaaaaaaaaaaa.connect.example.com', accountUrl: 'https://example.com', connectDomain: 'connect.example.com', deviceId: 'phone' });
const tree = () =>
  createElement(
    NativeSessionProvider,
    null,
    createElement(Page, { key: 'home' }),
    createElement(Page, { key: 'deep-link' })
  );
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  snapshots = [];
  fixture.profiles.state = { activeId: 'a', profiles: [profile('a', 'first')] };
  fixture.platform.OS = 'android';
  vi.clearAllMocks();
  fixture.connect.mockImplementation((_profile, deps) => {
    fixture.callbacks = deps;
    return fixture.stop;
  });
});
afterEach(async () => {
  if (renderer) await act(() => renderer!.unmount());
  renderer = undefined;
});
it('owns one connection across retained screens and keeps it when navigating', async () => {
  await act(() => {
    renderer = create(tree());
  });
  expect(fixture.connect).toHaveBeenCalledOnce();
  expect(fixture.callbacks?.platform).toBe('android');
  expect(snapshots.at(-1)?.ready).toBe(false);
  await act(() => fixture.callbacks!.onReady());
  expect(snapshots.slice(-2).every((s) => s.ready && s.revision === 1)).toBe(true);
  await act(() => {
    renderer!.update(tree());
  });
  expect(fixture.connect).toHaveBeenCalledOnce();
  await act(() => fixture.callbacks!.onResume());
  expect(snapshots.at(-1)?.resumeRevision).toBe(1);
  const remove = vi.fn();
  fixture.subscribe.mockReturnValue({ remove });
  const listener = vi.fn();
  fixture.callbacks!.subscribe(listener)();
  expect(fixture.subscribe).toHaveBeenCalledWith('change', listener);
  expect(remove).toHaveBeenCalledOnce();
  await act(() => renderer!.unmount());
  renderer = undefined;
  expect(fixture.stop).toHaveBeenCalledOnce();
});
it('gates a switched or repaired profile until its own cookie is installed', async () => {
  fixture.platform.OS = 'ios';
  await act(() => {
    renderer = create(tree());
  });
  expect(fixture.callbacks?.platform).toBe('ios');
  await act(() => fixture.callbacks!.onReady());
  fixture.profiles.state = { activeId: 'b', profiles: [profile('b', 'second')] };
  await act(() => renderer!.update(tree()));
  expect(snapshots.at(-1)?.ready).toBe(false);
  expect(fixture.stop).toHaveBeenCalledOnce();
  await act(() => fixture.callbacks!.onReady());
  expect(snapshots.at(-1)?.ready).toBe(true);
  fixture.profiles.state.profiles[0] = profile('b', 'repaired');
  await act(() => renderer!.update(tree()));
  expect(snapshots.at(-1)?.ready).toBe(false);
  expect(fixture.connect).toHaveBeenCalledTimes(3);
  await act(() => fixture.callbacks!.onReady());
  fixture.profiles.state = { activeId: '', profiles: [] };
  await act(() => renderer!.update(tree()));
  expect(snapshots.at(-1)?.ready).toBe(false);
  expect(fixture.stop).toHaveBeenCalledTimes(3);
});
it('surfaces renewal failures and reconnects once for every screen', async () => {
  await act(() => {
    renderer = create(tree());
  });
  const failure = new Error('offline');
  await act(() => fixture.callbacks!.onError(failure));
  expect(snapshots.at(-1)?.error).toBe(failure);
  expect(snapshots.at(-1)?.ready).toBe(false);
  await act(() => snapshots.at(-1)!.reconnect());
  expect(fixture.stop).toHaveBeenCalledOnce();
  expect(fixture.connect).toHaveBeenCalledTimes(2);
  expect(snapshots.at(-1)?.error).toBeNull();
  await act(() => fixture.callbacks!.onReady());
  expect(snapshots.at(-1)?.ready).toBe(true);
});
it('requires an app-level provider', async () => {
  await expect(async () => {
    await act(async () => {
      renderer = create(createElement(Page));
    });
  }).rejects.toThrow('Missing native session provider');
});

it('never opens a session for an old local profile and closes a session when its connection metadata becomes invalid', async () => {
  fixture.profiles.state.profiles[0] = { id: 'a', label: 'Old Mac', serverUrl: 'http://192.168.1.2:8785' };
  await act(() => { renderer = create(tree()); });
  expect(fixture.connect).not.toHaveBeenCalled();
  expect(snapshots.at(-1)?.ready).toBe(false);
  fixture.profiles.state.profiles[0] = profile('a', 'first');
  await act(() => renderer!.update(tree()));
  expect(fixture.connect).toHaveBeenCalledOnce();
  await act(() => fixture.callbacks!.onReady());
  fixture.profiles.state.profiles[0] = { ...profile('a', 'first'), connectDomain: undefined };
  await act(() => renderer!.update(tree()));
  expect(fixture.stop).toHaveBeenCalledOnce();
  expect(fixture.connect).toHaveBeenCalledOnce();
  expect(snapshots.at(-1)?.ready).toBe(false);
});

it('waits for a new cookie when the same saved record points at a different Connect computer', async () => {
  await act(() => { renderer = create(tree()); });
  await act(() => fixture.callbacks!.onReady());
  fixture.profiles.state.profiles[0] = {
    ...profile('a', 'first'), serverUrl: 'https://s-bbbbbbbbbbbbbbbbbbbbbbbb.connect.example.com'
  };
  await act(() => renderer!.update(tree()));
  expect(fixture.stop).toHaveBeenCalledOnce();
  expect(snapshots.at(-1)?.ready).toBe(false);
  await act(() => fixture.callbacks!.onReady());
  expect(snapshots.at(-1)?.ready).toBe(true);
});
