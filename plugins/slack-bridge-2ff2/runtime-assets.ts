// This module lives beside server.ts and the compiled server.mjs. Asset URLs
// therefore remain stable in source installs and dependency-free release bundles.
export const capabilityCatalogUrl = new URL("./src/capability-catalog.json", import.meta.url);
export const mermaidScriptUrl = new URL("./assets/mermaid.min.js", import.meta.url);
