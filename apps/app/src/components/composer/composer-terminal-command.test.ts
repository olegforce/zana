import { describe, expect, it, vi } from 'vitest';
import { COMPOSER_TERMINAL_COMMAND, parseComposerTerminalCommand, submitComposerTerminalCommand } from './composer-terminal-command.js';

describe('composer terminal command', () => {
  it.each(['hello', 'Explain /terminal pwd', '/terminally pwd', '/Terminal pwd', '/terminal; pwd', '/plan /terminal pwd'])('leaves %s as an agent message', async (text) => {
    const runTerminal = vi.fn();
    expect(parseComposerTerminalCommand(text)).toBeNull();
    expect(await submitComposerTerminalCommand({ text, imageCount: 0, runTerminal })).toBe(false);
    expect(runTerminal).not.toHaveBeenCalled();
  });

  it.each(['/terminal', ' /terminal ', '/terminal\n'])('opens an interactive shell for %s', async (text) => {
    const runTerminal = vi.fn().mockResolvedValue(undefined);
    expect(await submitComposerTerminalCommand({ text, imageCount: 0, runTerminal })).toBe(true);
    expect(runTerminal).toHaveBeenCalledWith(null);
  });

  it('passes quotes, shell operators and multiline commands unchanged', async () => {
    const command = 'printf "%s\\n" "$HOME" && pwd\nprintf done';
    const runTerminal = vi.fn().mockResolvedValue(undefined);
    expect(await submitComposerTerminalCommand({ text: `/terminal ${command}`, imageCount: 0, runTerminal })).toBe(true);
    expect(runTerminal).toHaveBeenCalledExactlyOnceWith(command);
  });

  it('does not silently discard images or execute attached commands', async () => {
    const runTerminal = vi.fn();
    await expect(submitComposerTerminalCommand({ text: '/terminal pwd', imageCount: 1, runTerminal })).rejects.toThrow('Remove image attachments');
    expect(runTerminal).not.toHaveBeenCalled();
  });

  it('requires a terminal host', async () => {
    await expect(submitComposerTerminalCommand({ text: '/terminal pwd', imageCount: 0 })).rejects.toThrow('Open a thread');
  });

  it('bounds commands before launch and accepts the limit', async () => {
    const runTerminal = vi.fn().mockResolvedValue(undefined);
    await expect(submitComposerTerminalCommand({ text: `/terminal ${'x'.repeat(10_001)}`, imageCount: 0, runTerminal })).rejects.toThrow('10,000');
    expect(runTerminal).not.toHaveBeenCalled();
    await expect(submitComposerTerminalCommand({ text: `/terminal ${'x'.repeat(10_000)}`, imageCount: 0, runTerminal })).resolves.toBe(true);
  });

  it('propagates launch failures so the composer can preserve the draft', async () => {
    const runTerminal = vi.fn().mockRejectedValue(new Error('Host disconnected'));
    await expect(submitComposerTerminalCommand({ text: '/terminal pwd', imageCount: 0, runTerminal })).rejects.toThrow('Host disconnected');
    expect(COMPOSER_TERMINAL_COMMAND.description).toContain('/terminal <command>');
  });
});
