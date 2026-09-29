import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Demo from '../app/demo';

const fixture = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ replace: fixture.replace }) }));
vi.mock('./ui', () => ({
  Action: 'Action', Field: 'Field', Heading: 'Heading', Label: 'Label', Screen: 'Screen',
  useColors: () => ({ panel: '#fff' })
}));
let renderer: ReactTestRenderer;
const action = (title: string) => renderer.root.findByProps({ title });
const input = () => renderer.root.findByProps({ testID: 'demo-message' });
const text = () => JSON.stringify(renderer.toJSON());
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('The demo must not use the network'); }));
  await act(() => { renderer = create(createElement(Demo)); });
});
afterEach(async () => {
  await act(() => renderer.unmount());
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('discloses sample data and scripted replies, and rejects empty messages', async () => {
  expect(text()).toContain('Replies are scripted');
  expect(text()).toContain('messages are not saved or sent to a server');
  expect(action('Send sample message').props.disabled).toBe(true);
  await act(() => input().props.onChangeText('   '));
  await act(() => action('Send sample message').props.onPress());
  expect(text()).not.toContain('Demo assistant');
});

it('keeps a single bounded local exchange and can reset it', async () => {
  await act(() => input().props.onChangeText('  Plan my website  '));
  expect(action('Send sample message').props.disabled).toBe(false);
  await act(() => action('Send sample message').props.onPress());
  expect(text()).toContain('Plan my website');
  expect(text()).toContain('This is a scripted demo reply');
  expect(input().props.value).toBe('');
  await act(() => input().props.onChangeText('x'.repeat(1100)));
  await act(() => action('Send sample message').props.onPress());
  expect(text()).not.toContain('Plan my website');
  expect(text()).toContain('x'.repeat(1000));
  expect(text()).not.toContain('x'.repeat(1001));
  await act(() => action('Reset demo').props.onPress());
  expect(text()).not.toContain('Demo assistant');
  expect(input().props.value).toBe('');
});

it('returns to the real pairing form', async () => {
  await act(() => action('Connect my computer').props.onPress());
  expect(fixture.replace).toHaveBeenCalledExactlyOnceWith('/connect');
});
