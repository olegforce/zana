// @vitest-environment happy-dom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ThreadDetailSearch } from './ThreadDetailSearch.js';

afterEach(cleanup);

it('focuses search, submits the query and clears it with the mobile close action', () => {
  const submit = vi.fn();
  function Fixture() {
    const [value, setValue] = useState('');
    return <ThreadDetailSearch mobileHeader value={value} onChange={setValue} onSubmit={submit} />;
  }
  render(<Fixture />);
  const input = screen.getByRole('searchbox') as HTMLInputElement;
  fireEvent.click(screen.getByRole('button', { name: 'Search in thread' }));
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: '  mobile  ' } });
  fireEvent.submit(input.closest('form')!);
  expect(submit).toHaveBeenLastCalledWith('mobile');
  const close = screen.getByRole('button', { name: 'Close search' });
  close.focus();
  fireEvent.click(close);
  expect(input.value).toBe('');
  expect(submit).toHaveBeenLastCalledWith('');
  expect(input.closest('form')!.classList.contains('has-query')).toBe(false);
  expect(document.activeElement).not.toBe(close);
  expect(document.activeElement).not.toBe(input);
});

it('retains Escape behavior and leaves desktop without the extra close control', () => {
  const change = vi.fn();
  const submit = vi.fn();
  render(<ThreadDetailSearch value="query" onChange={change} onSubmit={submit} />);
  expect(screen.queryByRole('button', { name: 'Close search' })).toBeNull();
  const input = screen.getByRole('searchbox');
  input.focus();
  fireEvent.keyDown(input, { key: 'ArrowLeft' });
  expect(change).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(change).toHaveBeenCalledWith('');
  expect(submit).toHaveBeenCalledWith('');
  expect(document.activeElement).not.toBe(input);
});
