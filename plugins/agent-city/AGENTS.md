# Agent City plugin

Ordinary package.json `zcc` plugin, id `agent-city`. The root repository instructions apply.

- `city-app.tsx` registers the World view through `experimental_agentsView`; keep all city-specific artwork and behavior here, never in core.
- `model.ts` derives project populations and stable plots in one continuous city. `scene.js` draws the approved isometric illustration; `scene.d.ts` describes the canvas boundary. `use-city.ts` owns and releases the animation/observer resources.
- The host supplies scoped fleet projections. Never poll a second source or invent progress, success, agents, cooperation, or schedule fires.
- Preserve the distinction between an agent session, a schedule plan and an execution summary. Only live members grow a building.
- Keep the complete keyboard-accessible roster available even when the scene caps illustrated citizens.
- `use-camera.ts` owns bounded pan/zoom; all projects fit by default. Never bring back district pagination. Keep canvas hit testing and DOM labels aligned at every camera zoom and viewport size.
- `server.ts` is intentionally empty. This plugin does not need server permissions or persistence.
- Use the commands in README.md. The built bundle is `app.js`; keep it ignored. Tests import the source `city-app.js` resolution so the bundle cannot shadow the source.
- Follow LIVE_TEST.md before claiming live verification. Do not restart the user's active installed app to adopt core changes without considering their running work.
