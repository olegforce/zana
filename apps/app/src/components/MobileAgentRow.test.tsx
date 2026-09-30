// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MobileAgentRow } from './MobileAgentRow';
import type { MobileAgentItem } from './mobile-agent-items';

const h = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../store', () => ({ pushErrorToast: h.toast, errorMessage: (error: Error) => error.message }));
const item: MobileAgentItem = {
  key: 'thread:t', kind: 'thread', id: 't', projectId: 'p', title: 'Review changes',
  projectName: 'Project', to: '/threads/t', status: 'Working', createdAt: 1
};

function mount(onClose = vi.fn().mockResolvedValue(undefined)) {
  const onOpen = vi.fn();
  render(<MemoryRouter><ul><MobileAgentRow item={item} active onOpen={onOpen} onClose={onClose} /></ul></MemoryRouter>);
  const row = screen.getByRole('link');
  let captured = false;
  row.setPointerCapture = vi.fn(() => { captured = true; });
  row.hasPointerCapture = vi.fn(() => captured);
  row.releasePointerCapture = vi.fn(() => { captured = false; });
  const pointer = (type: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel' | 'lostPointerCapture', x: number, y = 30, extra = {}) => {
    fireEvent[type](row, { pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y, ...extra });
  };
  return { row, pointer, onClose, onOpen };
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it('follows a right swipe, closes on release and suppresses the resulting link click', async () => {
  const { row, pointer, onClose, onOpen } = mount();
  pointer('pointerDown', 20);
  pointer('pointerMove', 140);
  expect(row.parentElement!.style.transform).toBe('translateX(120px)');
  expect(row.closest('li')!.dataset.ready).toBe('true');
  expect(row.setPointerCapture).toHaveBeenCalledWith(1);
  expect(onClose).not.toHaveBeenCalled();
  pointer('pointerUp', 140);
  fireEvent.click(row);
  expect(onOpen).not.toHaveBeenCalled();
  expect(row.releasePointerCapture).toHaveBeenCalledWith(1);
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(row.parentElement!.style.transform).toBe('translateX(0px)');
});

it.each([
  ['short drag', 60, 30], ['left swipe', -120, 30], ['scroll', 30, 160], ['diagonal', 140, 170]
])('does not close on a %s', (_label, x, y) => {
  const { pointer, onClose } = mount();
  pointer('pointerDown', 20);
  pointer('pointerMove', x as number, y as number);
  pointer('pointerUp', x as number, y as number);
  expect(onClose).not.toHaveBeenCalled();
});

it.each(['pointerCancel', 'lostPointerCapture'] as const)('resets a swipe on %s without closing or following the link', (type) => {
  const { row, pointer, onClose, onOpen } = mount();
  pointer('pointerDown', 20);
  pointer('pointerMove', 150);
  pointer(type, 150);
  pointer('pointerUp', 150);
  fireEvent.click(row);
  expect(onClose).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
  expect(row.parentElement!.style.transform).toBe('translateX(0px)');
});

it('supports taps with slight jitter, including after an aborted swipe', () => {
  const { row, pointer, onClose, onOpen } = mount();
  pointer('pointerDown', 20);
  pointer('pointerMove', 60);
  pointer('pointerUp', 60);
  pointer('pointerDown', 20);
  pointer('pointerMove', 24);
  pointer('pointerUp', 24);
  fireEvent.click(row);
  expect(onOpen).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
});

it('ignores other pointers and secondary mouse buttons', () => {
  const { row, pointer, onClose } = mount();
  pointer('pointerDown', 20, 30, { isPrimary: false });
  pointer('pointerMove', 150);
  pointer('pointerUp', 150);
  pointer('pointerDown', 20, 30, { button: 2 });
  pointer('pointerMove', 150);
  pointer('pointerUp', 150);
  pointer('pointerDown', 20);
  pointer('pointerMove', 150, 30, { pointerId: 2 });
  pointer('pointerUp', 150, 30, { pointerId: 2 });
  expect(onClose).not.toHaveBeenCalled();
  expect(row.parentElement!.style.transform).toBe('translateX(0px)');
});

it('caps the visual drag and allows reversing it before release', () => {
  const { row, pointer, onClose } = mount();
  pointer('pointerDown', 20);
  pointer('pointerMove', 400);
  expect(row.parentElement!.style.transform).toBe('translateX(180px)');
  pointer('pointerMove', 0);
  expect(row.parentElement!.style.transform).toBe('translateX(0px)');
  pointer('pointerUp', 0);
  expect(onClose).not.toHaveBeenCalled();
});

it('provides a close button and blocks repeated close attempts while pending', async () => {
  let resolve!: () => void;
  const onClose = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
  const { row, pointer, onOpen } = mount(onClose);
  const button = screen.getByRole('button', { name: 'Close Review changes' }) as HTMLButtonElement;
  fireEvent.click(button);
  expect(button.disabled).toBe(true);
  expect(row.closest('li')!.getAttribute('aria-busy')).toBe('true');
  fireEvent.click(button);
  pointer('pointerDown', 20);
  pointer('pointerMove', 150);
  pointer('pointerUp', 150);
  fireEvent.click(row);
  expect(onClose).toHaveBeenCalledOnce();
  expect(onOpen).not.toHaveBeenCalled();
  resolve();
  await waitFor(() => expect(button.disabled).toBe(false));
});

it('reports a failed close and allows retry', async () => {
  const onClose = vi.fn().mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValue(undefined);
  mount(onClose);
  const button = screen.getByRole('button', { name: 'Close Review changes' }) as HTMLButtonElement;
  fireEvent.click(button);
  await waitFor(() => expect(h.toast).toHaveBeenCalledWith('Connection lost'));
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
});
