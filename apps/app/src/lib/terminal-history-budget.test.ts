// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { terminalScrollbackBudget } from './terminal-resource-budget.js';

it.each([1,16,64])('keeps all history inside the allocation for %i mounted sessions', async count => {
  const term = new Terminal({ cols:80, rows:24, scrollback:terminalScrollbackBudget(count), allowProposedApi:true });
  try {
    await new Promise<void>(resolve => term.write(Array.from({ length:512 },(_,index) => `RETAINED-${index}\r\n`).join(''),resolve));
    const snapshot = () => Array.from({ length:term.buffer.active.length },(_,index) => term.buffer.active.getLine(index)!.translateToString(true)).join('\n');
    const before = snapshot();
    for (let index=0;index<512;index++) expect(before).toContain(`RETAINED-${index}\n`);
    const position = term.buffer.active.viewportY;
    term.options.scrollback = terminalScrollbackBudget(64);
    expect(snapshot()).toBe(before); expect(term.buffer.active.viewportY).toBe(position);
  } finally { term.dispose(); }
});
