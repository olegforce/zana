import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { slackbotTools } from './mcp.mjs';
it('ships the authored capability catalog without drift', () => {
  const source = JSON.parse(readFileSync(fileURLToPath(new URL('../../packages/slack-capabilities/catalog.json', import.meta.url)), 'utf8'));
  expect(slackbotTools).toEqual(source.tools);
  expect(new Set(slackbotTools.map((tool: any) => tool.name)).size).toBe(slackbotTools.length);
  expect(source.commands.some((command: any) => command.command === '/zana import [project]')).toBe(true);
});

it('assigns every configurable MCP tool to exactly one functionality', () => {
  const source = JSON.parse(readFileSync(fileURLToPath(new URL('../../packages/slack-capabilities/catalog.json', import.meta.url)), 'utf8'));
  const names = source.features.flatMap((feature: any) => feature.tools);
  expect(new Set(source.features.map((feature: any) => feature.id)).size).toBe(source.features.length);
  expect(new Set(names).size).toBe(names.length);
  expect(names.sort()).toEqual(slackbotTools.map((tool: any) => tool.name).filter((name: string) => name !== 'zana_connect').sort());
});
