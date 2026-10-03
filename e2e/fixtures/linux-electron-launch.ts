/**
 * Linux CI launch flags for unpackaged Electron under xvfb.
 *
 * Ubuntu 24.04 GitHub runners (ubuntu-latest) block Chromium's sandbox via
 * AppArmor (`kernel.apparmor_restrict_unprivileged_userns=1`) and Electron 38+
 * prefers Wayland/Ozone, which never creates a window under Xvfb. Playwright's
 * `firstWindow` then times out even though `electron.launch` connected.
 *
 * Flags must be argv (Chromium reads ozone before any JS). Pair with the
 * workflow `sysctl` that relaxes userns — `--no-sandbox` alone is not enough
 * on noble. See microsoft/playwright#34251.
 */
export function linuxCiElectronArgs(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'linux') return [];
  // Xvfb has no hardware GPU. Keep WebGL available for xterm via Chromium's
  // software renderer, and keep frames flowing for screenshots in occluded windows.
  return ['--no-sandbox', '--ozone-platform=x11', '--use-gl=angle',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];
}

export function linuxCiElectronEnv(
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  if (platform !== 'linux') return {};
  return {
    ELECTRON_OZONE_PLATFORM_HINT: 'x11',
    ELECTRON_DISABLE_SANDBOX: '1',
  };
}
