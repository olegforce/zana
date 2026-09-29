/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';
import { PhoneTab } from './PhoneSettingsView.js';

afterEach(cleanup);

it('offers mobile browser access while the native app is coming soon', () => {
  render(<MemoryRouter><PhoneTab /></MemoryRouter>);
  const nativeApp = within(screen.getByRole('region', { name: 'Zana mobile app' }));
  expect(nativeApp.getByText('Coming soon')).toBeTruthy();
  expect(nativeApp.queryByRole('link')).toBeNull();
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.queryByText(/TestFlight|USB|Verify the connection/)).toBeNull();
  const steps = within(screen.getByRole('list', { name: 'Mobile browser setup' })).getAllByRole('listitem');
  expect(steps).toHaveLength(3);
  expect(steps[0].textContent).toContain('my-domain.zana-ide.com');
  expect(steps[1].textContent).toContain('Safari, Chrome');
  expect(steps[2].textContent).toContain('same GitHub account');
  expect(screen.getByText(/Keep this computer awake, Zana running, and Remote access enabled/)).toBeTruthy();
});

it('takes domain setup to the existing Remote access settings route', () => {
  render(<MemoryRouter initialEntries={['/settings/phone']}>
    <Routes>
      <Route path="/settings/phone" element={<PhoneTab />} />
      <Route path="/settings/remote-access" element={<h1>Remote access setup</h1>} />
    </Routes>
  </MemoryRouter>);
  fireEvent.click(screen.getByRole('link', { name: 'Set up my domain' }));
  expect(screen.getByRole('heading', { name: 'Remote access setup' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Zana mobile app' })).toBeNull();
});
