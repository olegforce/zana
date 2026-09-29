// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { ExtensionEntry } from '@zana-ai/zcc-domain/product';
import { DesktopOnlyPlugin } from './DesktopOnlyPlugin.js';
afterEach(cleanup);
it.each([true, false])('explains owner desktop availability without offering native actions (%s)', enabled => {
  const entry = { id: 'legacy', enabled, ...(enabled ? { manifest: { title: 'Legacy plugin', version: '1.2.3' } } : {}) } as ExtensionEntry;
  const view = render(<DesktopOnlyPlugin entry={entry} />);
  expect(view.getByRole('heading').textContent).toBe(enabled ? 'Legacy plugin' : 'legacy');
  expect(view.getByTestId('desktop-only-plugin').textContent).toContain(enabled ? 'Enabled' : 'Disabled');
  expect(view.queryAllByRole('button')).toHaveLength(0);
  expect(view.getByText(/requires the instance owner/)).toBeTruthy();
});
