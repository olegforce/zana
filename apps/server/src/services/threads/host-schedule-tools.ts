/** Agent schedule operations go directly to the instance owner, once per request.
 * Browser subscriptions are notifications only and never execute commands. */
import { asControlResult, callControlAsProductServer } from '../../http/cli-agent-ops.js';
import type { DynamicTool, ToolCallResponse } from '@zana-ai/zcc-domain/thread-runtime';
import type { Result, ScheduledTask } from '@zana-ai/zcc-domain/product';
import { pluginToolResultToResponse } from '../../plugins/plugin-agent-tools.js';
import type { ProductHttpContext } from '../../http/product-context.js';
import {
  SCHEDULE_LIST_DESCRIPTION,
  SCHEDULE_RUN_NOW_DESCRIPTION,
  SCHEDULE_SET_ENABLED_DESCRIPTION,
  formatResolveError,
  projectSchedule,
  resolveSchedule,
  scopeSchedules
} from '../scheduler/schedule-manage-mcp-tools.js';

export const SCHEDULE_LIST_NAME = 'schedule_list';
export const SCHEDULE_RUN_NOW_NAME = 'schedule_run_now';
export const SCHEDULE_SET_ENABLED_NAME = 'schedule_set_enabled';

export const HOST_SCHEDULE_INSTRUCTION = [
  'List or toggle Scheduler UI schedules with `schedule_list` / `schedule_set_enabled`.',
  'Fire one immediately with `schedule_run_now` (desktop Scheduler).'
].join(' ');

export const HOST_SCHEDULE_TOOLS: DynamicTool[] = [
  {
    name: SCHEDULE_LIST_NAME,
    description: SCHEDULE_LIST_DESCRIPTION,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        allProjects: { type: 'boolean' }
      }
    },
    presentation: {
      label: { pending: 'Listing schedules', completed: 'Listed schedules' },
      icon: { glyph: 'Calendar' }
    }
  },
  {
    name: SCHEDULE_RUN_NOW_NAME,
    description: SCHEDULE_RUN_NOW_DESCRIPTION,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', minLength: 1 },
        allProjects: { type: 'boolean' }
      }
    },
    presentation: {
      label: { pending: 'Running schedule', completed: 'Ran schedule' },
      icon: { glyph: 'Play' }
    }
  },
  {
    name: SCHEDULE_SET_ENABLED_NAME,
    description: SCHEDULE_SET_ENABLED_DESCRIPTION,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'enabled'],
      properties: {
        id: { type: 'string', minLength: 1 },
        enabled: { type: 'boolean' },
        allProjects: { type: 'boolean' }
      }
    },
    presentation: {
      label: { pending: 'Updating schedule', completed: 'Updated schedule' },
      icon: { glyph: 'ToggleLeft' }
    }
  }
];

function fail(name: string, error: string): ToolCallResponse {
  return pluginToolResultToResponse(name, { ok: false, error });
}

function row(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return input as Record<string, unknown>;
}

async function invokeOwner<T>(ctx: ProductHttpContext, method: string, args: unknown[]): Promise<T> {
  const response = asControlResult<T>(await callControlAsProductServer(ctx.dataDir, 'product.invoke', { method, args }));
  if (!response.ok) throw new Error(response.message);
  return response.value;
}

export async function invokeHostScheduleTool(
  ctx: ProductHttpContext,
  args: { name: string; threadId: string; projectId: string; input: unknown }
): Promise<ToolCallResponse> {
  const { name, projectId, input } = args;
  const fields = row(input);
  try {
    if (!ctx.toProjects().some(project => project.id === projectId)) throw new Error('Unknown project');
    if (![SCHEDULE_LIST_NAME, SCHEDULE_RUN_NOW_NAME, SCHEDULE_SET_ENABLED_NAME].includes(name)) throw new Error(`Unsupported schedule tool: ${name}`);
    const widen = fields.allProjects === true;
    const tasks = await invokeOwner<ScheduledTask[]>(ctx, 'scheduler.list', []);
    if (!Array.isArray(tasks)) throw new Error('Invalid scheduler response');
    const scoped = scopeSchedules(tasks, projectId, widen);

    if (name === SCHEDULE_LIST_NAME) {
      const hits = scoped.map(projectSchedule);
      return pluginToolResultToResponse(name, {
        scope: widen ? 'all-projects' : `project:${projectId}`,
        count: hits.length,
        schedules: hits
      });
    }

    const id = typeof fields.id === 'string' ? fields.id.trim() : '';
    if (!id) throw new Error('id is required');
    const found = resolveSchedule(scoped, id);
    if (!found.ok) return fail(name, formatResolveError(found, id));

    if (name === SCHEDULE_SET_ENABLED_NAME && typeof fields.enabled !== 'boolean') throw new Error('enabled is required');
    const result = await invokeOwner<Result<ScheduledTask>>(ctx,
      name === SCHEDULE_RUN_NOW_NAME ? 'scheduler.runNow' : 'scheduler.setEnabled',
      name === SCHEDULE_RUN_NOW_NAME ? [found.task.id] : [found.task.id, fields.enabled]);
    if (!result.ok) return fail(name, result.message);
    return pluginToolResultToResponse(name, {
      ok: true,
      action: name === SCHEDULE_RUN_NOW_NAME ? 'run-now' : fields.enabled ? 'enable' : 'disable',
      schedule: projectSchedule(result.value)
    });
  } catch (error) {
    return fail(name, error instanceof Error ? error.message : `${name} failed`);
  }
}
