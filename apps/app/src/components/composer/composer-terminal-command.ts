export const COMPOSER_TERMINAL_COMMAND = {
  name: '/terminal',
  description: 'Open a side-panel terminal, or run /terminal <command>',
  source: 'command' as const
};

/** Match only a leading command token; preserve the shell's quotes and newlines. */
export function parseComposerTerminalCommand(text: string): { command: string | null } | null {
  const match = /^\s*\/terminal(?:\s+([\s\S]*))?$/u.exec(text);
  return match ? { command: match[1]?.trim() || null } : null;
}

export async function submitComposerTerminalCommand(args: {
  text: string;
  imageCount: number;
  runTerminal?: (command: string | null) => Promise<void>;
}): Promise<boolean> {
  const intent = parseComposerTerminalCommand(args.text);
  if (!intent) return false;
  if (!args.runTerminal) throw new Error('Open a thread to run a command in its side-panel terminal.');
  if (args.imageCount > 0) throw new Error('Remove image attachments before running a terminal command.');
  if (intent.command && intent.command.length > 10_000) {
    throw new Error('Terminal commands must be 10,000 characters or fewer.');
  }
  await args.runTerminal(intent.command);
  return true;
}
