# Live verification

1. Build/install/reload using the repository CLI as described in README.md. Check plugin status is `running`.
2. On a host with `experimental_agentsView`, open Agents → World. Verify Agent City appears under Plugins → Installed plugins and has no separate navigation entry. Older hosts keep it installed without exposing World; this is installation verification only.
3. Select a project, open an agent, and verify the existing inspector displays that same agent. Check the scheduler station and Done pavilion.
4. Pause animation, use status/search filters, verify at least ten buildings share one map, zoom/pan/Fit city, add a project without losing the existing buildings, and check a small viewport. With reduced motion enabled the motion control must be disabled and the scene still usable.
5. In an isolated test install, edit the heading, run `plugin dev --once`, verify the open view remounts, and disable/re-enable the plugin to verify safe fallback and restoration. Never perform destructive probes on the user's agents.
6. Run `pnpm test:e2e -- e2e/agent-city-plugin.spec.ts` for the automated production-boundary checks in a private Electron app and paired mobile gateway.

The user's currently installed host predates the new slot. Installation was verified in its native UI. The initial compatibility navigation page was removed after user feedback; management belongs in Installed plugins. World itself is verified in the updated private Electron build; opening it in the main app requires running an updated host build.
