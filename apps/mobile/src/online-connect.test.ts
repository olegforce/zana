import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Connect from '../app/connect';
import { OnlineConnect } from './OnlineConnect';
import { EMPTY_STATE, type MobileState } from './lib/profiles';
const f = vi.hoisted(() => ({ state: {} as MobileState, ready: true, update: vi.fn(), start: vi.fn(), poll: vi.fn(), discover: vi.fn(), open: vi.fn(), replace: vi.fn(), push: vi.fn(), advanced: vi.fn(), listener: undefined as any, remove: vi.fn(), appState: { currentState: 'active' } }));
vi.mock('react-native', () => ({ View: 'View', ActivityIndicator: 'Spinner', Platform: { OS: 'ios' }, Linking: { openURL: f.open }, AppState: { get currentState() { return f.appState.currentState; }, addEventListener: (_: any, callback: any) => { f.listener = callback; return { remove: f.remove }; } } }));
vi.mock('./ui', () => ({ Screen: 'Screen', Heading: 'Heading', Label: 'Label', Action: 'Action', useColors: () => ({ accent: 'purple' }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'new' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ replace: f.replace, push: f.push }), useLocalSearchParams: () => ({}) }));
vi.mock('./state', () => ({ useProfiles: () => ({ state: f.state, ready: f.ready, update: f.update }) }));
vi.mock('./lib/client', () => ({ startPhoneLogin: f.start, pollPhoneLogin: f.poll, discoverAccountServers: f.discover }));
const account = { accountUrl: 'https://zana-ide.com', connectDomain: 'connect.zana-ide.com', credential: 'c'.repeat(43), deviceId: 'phone' };
const login = { deviceCode: 'd'.repeat(43), userCode: 'u'.repeat(22), expiresAt: Date.now() + 600000, verificationUrl: 'https://zana-ide.com/connect/?phone=' + 'u'.repeat(22) };
const server = { id: 'mac', name: 'My Mac', serverUrl: 'https://s-' + 'a'.repeat(24) + '.connect.zana-ide.com', browserUrl: 'https://my-mac.zana-ide.com', live: true };
let renderer: ReactTestRenderer;
const element = () => createElement(OnlineConnect);
const button = (title: string) => renderer.root.findByProps({ title });
const text = () => JSON.stringify(renderer.toJSON());
async function mount() { await act(() => { renderer = create(element()); }); }
async function press(title: string) { await act(async () => { await button(title).props.onPress(); }); }
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  f.state = { ...EMPTY_STATE, profiles: [] }; f.ready = true; f.appState.currentState = 'active';
  f.start.mockResolvedValue(login); f.poll.mockResolvedValue(null); f.discover.mockResolvedValue([server]); f.open.mockResolvedValue(undefined);
  f.update.mockImplementation(async change => { f.state = change(f.state); renderer.update(element()); });
});
afterEach(async () => { if (renderer) await act(() => renderer.unmount()); vi.useRealTimers(); });
it('makes GitHub the default route with no manual connection form', async () => {
  await act(() => { renderer = create(createElement(Connect)); });
  expect(button('Continue with GitHub')).toBeTruthy();
  expect(text()).not.toContain('Server URL');
  await press('Try a demo without connecting'); expect(f.push).toHaveBeenCalledWith('/demo');
  await press('Manage account and devices'); expect(f.open).toHaveBeenCalledWith('https://zana-ide.com/connect/');
  expect(text()).not.toContain('Advanced connection options');
  expect(text()).not.toContain('Scan pairing QR');
});
it('persists before opening the browser, resumes approval, displays the domain, and chooses the authenticated transport', async () => {
  await mount(); await press('Continue with GitHub');
  expect(f.state.phoneLogin).toEqual(login); expect(f.open).toHaveBeenCalledWith(login.verificationUrl);
  expect(f.update.mock.invocationCallOrder[0]).toBeLessThan(f.open.mock.invocationCallOrder[0]);
  f.poll.mockResolvedValue(account);
  await act(() => f.listener('active'));
  expect(f.state.account).toEqual(account); expect(f.state.phoneLogin).toBeUndefined();
  expect(text()).toContain('my-mac.zana-ide.com');
  await press('My Mac · Connect');
  expect(f.state.profiles[0]).toMatchObject({ ...account, serverUrl: server.serverUrl });
  expect(f.replace).toHaveBeenCalledWith('/');
});
it('resumes a persisted request, retries a failed poll and cleans up its timer/listener', async () => {
  f.state.phoneLogin = login; f.poll.mockRejectedValueOnce(new Error('Network unavailable'));
  await mount(); expect(text()).toContain('Network unavailable');
  await press('Continue in browser'); expect(f.open).toHaveBeenCalledWith(login.verificationUrl);
  await press('Check sign-in');
  await act(() => vi.advanceTimersByTimeAsync(3000)); expect(f.poll).toHaveBeenCalledTimes(3);
  await press('Cancel sign-in'); expect(f.state.phoneLogin).toBeUndefined(); expect(f.remove).toHaveBeenCalled();
});
it('does not restore a cancelled request when its HTTP response arrives late', async () => {
  f.state.phoneLogin = login; let resolve!: (value: any) => void;
  f.poll.mockImplementation(() => new Promise(done => { resolve = done; }));
  await mount(); await press('Cancel sign-in');
  await act(() => resolve(account));
  expect(f.state.account).toBeUndefined(); expect(f.state.phoneLogin).toBeUndefined();
});
it('waits for the app to return to foreground, and handles offline and empty accounts', async () => {
  f.state.phoneLogin = login; f.appState.currentState = 'background'; await mount(); expect(f.poll).not.toHaveBeenCalled();
  f.appState.currentState = 'active'; f.poll.mockResolvedValue(account); f.discover.mockResolvedValue([{ ...server, live: false }]);
  await act(() => f.listener('active'));
  expect(button('My Mac · Offline').props.disabled).toBe(true);
  await press('My Mac · Offline'); expect(f.replace).not.toHaveBeenCalled();
  f.discover.mockResolvedValue([]); await press('Refresh computers'); expect(text()).toContain('No computers yet');
});
it('keeps storage/network failures recoverable and prevents duplicate sign-ins', async () => {
  await mount(); let resolve!: (value: any) => void;
  f.start.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(() => { button('Continue with GitHub').props.onPress(); button('Continue with GitHub').props.onPress(); });
  expect(f.start).toHaveBeenCalledOnce();
  f.update.mockRejectedValueOnce(new Error('Secure storage unavailable'));
  await act(() => resolve(login)); expect(text()).toContain('Secure storage unavailable'); expect(f.open).not.toHaveBeenCalled();
  f.open.mockRejectedValueOnce(new Error('Browser unavailable')); await press('Continue with GitHub'); expect(text()).toContain('Browser unavailable');
});
it('preserves saved connections and reports failed discovery/selection without navigating', async () => {
  f.state.account = account; f.state.profiles = [{ id: 'old', label: 'Old', serverUrl: 'http://192.168.1.2:8785' }];
  f.discover.mockRejectedValueOnce(new Error('Sign in again')); await mount(); expect(text()).toContain('Sign in again');
  await press('Refresh computers'); f.update.mockRejectedValueOnce(new Error('Storage full')); await press('My Mac · Connect');
  expect(text()).toContain('Storage full'); expect(f.replace).not.toHaveBeenCalled(); expect(f.state.profiles).toHaveLength(1);
  await press('Back to saved computers'); expect(f.replace).toHaveBeenCalledWith('/settings');
  await press('Sign in again'); expect(f.state.phoneLogin).toEqual(login);
});
it('does not start before secure storage loads', async () => {
  f.ready = false; await mount(); expect(button('Continue with GitHub').props.disabled).toBe(true);
  await press('Continue with GitHub'); expect(f.start).not.toHaveBeenCalled();
});
