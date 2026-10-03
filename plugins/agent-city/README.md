# Agent City

A living isometric city, contributed as **World**, the fourth layout in global and project **Agents** views.

- Projects become buildings. Live population controls height; idle agents belong to that population. Exited processes do not make buildings grow.
- Working agents light windows and walk; idle citizens gather in the park. Requests are amber and open the existing agent inspector.
- The Scheduler station lists plans and active runs. A plan is never counted as another agent. It follows the host's calendar toggle.
- The Done pavilion contains exited/error sessions. An exit is not a claim that a task succeeded.
- Every project appears in one continuous city, fitted to the available map area by default. Roads, plots and the rail line expand as projects arrive. Existing plots stay stable across arrivals, reordering and activity changes while the view is open. Vacant plots are reused.
- Zoom buttons and keyboard +/− enlarge the map; drag or arrow keys pan. Fit city (or Home/0) restores the whole city. Clicking a building opens its roster while the other buildings remain on the map.
- Project selection, status filters, search, and paginated rosters reach every item. Up to 12 actual citizens per building, within a 180-citizen scene budget, are illustrated; all agents remain accessible in rosters.
- Cars, a bus, and a train provide ambient motion. They do not claim that a task was launched or a result delivered.
- Motion can be paused; reduced motion is respected. Rendering stops offscreen/hidden and cleans up on unmount or reload.

## Run

The host must include `PluginAppSlots.experimental_agentsView`. This checkout adds that generic slot; the artwork and behavior live entirely in this plugin. Manage the plugin under Plugins → Installed plugins. It contributes no separate navigation page. Older hosts keep it installed, but need an app update before World is available.

From the repository root:

```sh
node packages/plugin-build/scripts/build-app.mjs plugins/agent-city
node packages/cli/dist/bin/zcc plugin install plugins/agent-city
node packages/cli/dist/bin/zcc plugin dev plugins/agent-city --once
```

Open **Agents → World** in an updated Zana build. A source install follows this directory. No credentials, backend polling, databases, or agent launches are added by the plugin.

The repository CLI is used above because the currently installed packaged CLI failed plugin preparation with a missing `esbuild` dependency. It targets the same running app.

## Verify

From the repository root:

```sh
pnpm exec tsc --noEmit -p tsconfig.json
pnpm exec vitest run plugins/agent-city apps/app/src/plugins/agents-view-model.test.ts packages/domain/src/agents-view.test.ts
pnpm test:e2e -- e2e/agent-city-plugin.spec.ts
```

The E2E uses a private built Electron app and a fake provider, with no model spend. It installs the actual plugin, opens a real thread inspector, reloads the UI, checks persisted selection and reduced motion, exercises the mobile gateway, then disables and re-enables the plugin.
