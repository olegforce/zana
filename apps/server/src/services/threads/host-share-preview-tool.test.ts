import { expect, it, vi } from 'vitest';
import { invokeSharePreview, SHARE_PREVIEW_TOOL } from './host-share-preview-tool.js';
const h = vi.hoisted(() => ({ change: vi.fn(async () => ({ shares: [] })), list: vi.fn(async () => ({ shares: [] })) }));
vi.mock('../previews/preview-service.js', () => ({ previewService: () => h }));
it('uses host-attested thread scope for share and stop and lists previews', async () => {
  expect(SHARE_PREVIEW_TOOL.name).toBe('share_preview');
  await invokeSharePreview({} as any, { threadId: 'owner', input: { action: 'share', port: 5173 } });
  expect(h.change).toHaveBeenCalledWith({ port: 5173 }, false, 'owner');
  await invokeSharePreview({} as any, { threadId: 'owner', input: { action: 'stop', port: 5173 } });
  expect(h.change).toHaveBeenCalledWith({ port: 5173 }, true, 'owner');
  await invokeSharePreview({} as any, { threadId: 'owner', input: { action: 'list' } }); expect(h.list).toHaveBeenCalled();
});
it('reports invalid input and service failures without accepting a host override', async () => {
  for (const input of [{ action: 'share' }, { action: 'share', port: 22 }, { action: 'share', port: 3000, hostId: 'forged' }]) {
    expect(JSON.stringify(await invokeSharePreview({} as any, { threadId: 'owner', input }))).toMatch(/required|1024|Unrecognized/);
  }
  h.change.mockRejectedValueOnce(new Error('Turn on Remote access'));
  expect(JSON.stringify(await invokeSharePreview({} as any, { threadId: 'owner', input: { action: 'share', port: 3000 } }))).toContain('Turn on Remote access');
});
