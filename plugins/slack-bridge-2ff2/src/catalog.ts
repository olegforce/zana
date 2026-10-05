import { readFileSync } from "node:fs";
import { capabilityCatalogUrl } from "../runtime-assets.js";
import type catalogShape from "./capability-catalog.json";

// JSON imports remain cached by the process across path-plugin reloads. Read this
// bounded, packaged catalog once per plugin generation so policy and UI stay aligned.
const source = readFileSync(
  capabilityCatalogUrl,
  "utf8",
);
if (source.length > 128_000)
  throw new Error("Slack capability catalog is too large.");
const catalog = JSON.parse(source) as typeof catalogShape;
export default catalog;
