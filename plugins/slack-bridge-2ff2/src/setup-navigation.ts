/** The plugin detail page is the single destination for Slack configuration. */
export function settingsPath(pluginId: string, connectProject = false): string {
  return `/extensions/plugins/${encodeURIComponent(pluginId)}?view=installed${connectProject ? "&setup=connect" : ""}#plugin-configure`;
}

/** Preserve saved setup links from Slack and older installations. Older hosts
 * may first redirect an unknown plugin route to Home during startup. */
export function restoreSetupRoute(pluginId: string) {
  const root = `/plugins/${encodeURIComponent(pluginId)}/main`;
  let initial = new URL(window.location.href);
  if (initial.pathname === "/" && !initial.search && !initial.hash) {
    const entry = window.performance.getEntriesByType?.("navigation")[0];
    if (!entry) return;
    try {
      initial = new URL(entry.name);
    } catch {
      return;
    }
  }
  if (
    initial.origin !== window.location.origin ||
    initial.search ||
    initial.hash ||
    ![root, `${root}/connect`].includes(initial.pathname)
  )
    return;
  window.history.replaceState(
    window.history.state,
    "",
    settingsPath(pluginId, initial.pathname.endsWith("/connect")),
  );
  window.dispatchEvent(new PopStateEvent("popstate"));
}
