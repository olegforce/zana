import { slackCommands } from "./capabilities.js";
import { homeLink, pt, section } from "./home-view.js";
import { plainSlack, decodeSlack, type Config, type Route } from "./model.js";

export type SlashCommand =
  | { action: "run"; project: string; task: string }
  | { action: "status"; project: string }
  | { action: "import"; project: string }
  | { action: "help" }
  | { action: "projects" }
  | { action: "connect" }
  | { error: string };

export const SLASH_HELP = [
  "Zana shortcuts",
  slackCommands
    .filter((entry) => entry.command.startsWith("/zana"))
    .map((entry) => `${entry.command} — ${entry.description}`)
    .join("\n"),
  'For names with spaces, use quotes: /zana run "My Project" review the tests. Project IDs also work. Confirm Start agent to launch; the form shows where the task will be shared.',
  "Use slash commands in a channel’s main composer. To continue or stop an existing task, mention @Zana in its conversation or use Home. Keep your Zana machine awake.",
];

/** One optional quoted Project token; the remaining task is preserved literally. */
export function parseSlash(value: unknown): SlashCommand {
  if (typeof value !== "string" || value.length > 2400)
    return {
      error:
        "Keep the command under 2,400 characters and the task under 2,000.",
    };
  const text = decodeSlack(value).trim();
  if (!text || /^(new|run)$/i.test(text))
    return { action: "run", project: "", task: "" };
  const [, verb, rest = ""] = text.match(/^(\S+)(?:\s+([\s\S]*))?$/)!;
  const action = verb.toLowerCase();
  if (["help", "projects", "connect"].includes(action))
    return rest
      ? { error: `Use /zana ${action} without extra arguments.` }
      : ({ action } as SlashCommand);
  if (action !== "run" && action !== "status" && action !== "import")
    return { error: "Unknown action. Use /zana help for available shortcuts." };
  if (!rest)
    return { action: action === "import" ? "import" : "status", project: "" };
  const match = rest.match(
    /^(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"']+))(?:\s+([\s\S]*))?$/,
  );
  if (!match)
    return {
      error:
        'Use a Project name or ID. Put names with spaces in quotes: /zana run "My Project" <task>.',
    };
  const project = (match[1] || match[2] || match[3]).trim(),
    task = (match[4] || "").trim();
  if (!project || project.length > 300 || task.length > 2000)
    return {
      error:
        "Use a Project name of up to 300 characters and a task of up to 2,000 characters.",
    };
  if (action === "status" || action === "import")
    return task
      ? { error: `Use /zana ${action} "Project name" with no task.` }
      : { action, project };
  return { action, project, task };
}

export function resolveSlashProject(
  selector: string,
  channel: string,
  routes: Route[],
  projects: { id: string; name: string }[],
): { project: string } | { error: string } {
  if (selector === ".") {
    const route = routes.find((r) => r.channel === channel);
    return route
      ? { project: route.projectId }
      : {
          error:
            "This channel has no connected Project. Use /zana projects or /zana connect.",
        };
  }
  const ids = [...new Set(routes.map((r) => r.projectId))];
  if (ids.includes(selector)) return { project: selector };
  const matches = projects.filter(
    (p) =>
      ids.includes(p.id) && p.name.toLowerCase() === selector.toLowerCase(),
  );
  if (matches.length === 1) return { project: matches[0].id };
  return {
    error:
      matches.length > 1
        ? "More than one connected Project has that name. Use its Project ID from /zana projects or choose it in /zana."
        : "No connected Project matches that name. Use /zana projects for exact names and IDs, or /zana to choose a Project.",
  };
}

/** Replies are visible only to the invoking user, with user-controlled names in plain text. */
export function slashReply(lines: string | string[], config: Config) {
  const content = Array.isArray(lines) ? lines : [lines];
  const url = homeLink(config);
  return {
    response_type: "ephemeral",
    text: plainSlack(content.join("\n")).slice(0, 12000),
    blocks: [
      ...content.map((line) => section(line.slice(0, 2900))),
      ...(url
        ? [
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  action_id: "slash_home",
                  text: pt("Open Zana Home"),
                  url,
                },
              ],
            },
          ]
        : []),
    ],
  };
}
