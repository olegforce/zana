import { product } from '../lib/product-client.js';

export const INSPECTOR_MIN_WIDTH = 640;
export const INSPECTOR_MIN_HEIGHT = 400;
export const INSPECTOR_VIEWPORT_GUTTER = 16;
export const INSPECTOR_KEYBOARD_STEP = 24;

export type InspectorResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export interface InspectorFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface InspectorViewport {
  width: number;
  height: number;
}

export function inspectorViewport(
  view: Pick<Window, 'innerWidth' | 'innerHeight'> | null | undefined = globalThis.window
): InspectorViewport {
  return {
    width: Math.max(1, view?.innerWidth ?? 1280),
    height: Math.max(1, view?.innerHeight ?? 800)
  };
}

export function scaleInspectorFrame(
  frame: InspectorFrame,
  from: InspectorViewport,
  to: InspectorViewport
): InspectorFrame {
  if (from.width === to.width && from.height === to.height) return clampInspectorFrame(frame, to);
  return clampInspectorFrame(
    {
      ...frame,
      width: frame.width * (to.width / from.width),
      height: frame.height * (to.height / from.height)
    },
    to
  );
}

export const INSPECTOR_SIZE_STORAGE_KEY = 'zcc.inspectorWindow.size';

type ChosenInspectorSize = { frame: InspectorFrame; viewport: InspectorViewport };

// Cache of the size the user chose, plus the app window it was chosen in.
// localStorage is the source of truth so closing one agent inspector and
// opening another (a remount, or a duplicate module copy) keeps the size.
let chosenInspectorSize: ChosenInspectorSize | null | undefined;

function isPositiveSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function parseChosenInspectorSize(raw: unknown): ChosenInspectorSize | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as { frame?: unknown; viewport?: unknown };
  if (!row.frame || typeof row.frame !== 'object' || !row.viewport || typeof row.viewport !== 'object') {
    return null;
  }
  const frame = row.frame as InspectorFrame;
  const viewport = row.viewport as InspectorViewport;
  if (
    !isPositiveSize(frame.width) ||
    !isPositiveSize(frame.height) ||
    !Number.isFinite(frame.left) ||
    !Number.isFinite(frame.top) ||
    !isPositiveSize(viewport.width) ||
    !isPositiveSize(viewport.height)
  ) {
    return null;
  }
  return {
    frame: { left: frame.left, top: frame.top, width: frame.width, height: frame.height },
    viewport: { width: viewport.width, height: viewport.height }
  };
}

function readStoredInspectorSize(): ChosenInspectorSize | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(INSPECTOR_SIZE_STORAGE_KEY);
    if (!raw) return null;
    return parseChosenInspectorSize(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function writeStoredInspectorSize(value: ChosenInspectorSize | null): void {
  chosenInspectorSize = value;
  if (typeof localStorage === 'undefined') return;
  try {
    if (!value) localStorage.removeItem(INSPECTOR_SIZE_STORAGE_KEY);
    else localStorage.setItem(INSPECTOR_SIZE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* quota / private mode */
  }
}

function resolvedInspectorSize(): ChosenInspectorSize | null {
  if (typeof localStorage === 'undefined') return chosenInspectorSize ?? null;
  const stored = readStoredInspectorSize();
  chosenInspectorSize = stored;
  return stored;
}

export function rememberInspectorSize(frame: InspectorFrame, viewport: InspectorViewport): void {
  writeStoredInspectorSize({
    frame: { left: frame.left, top: frame.top, width: frame.width, height: frame.height },
    viewport: { width: viewport.width, height: viewport.height }
  });
}

export function clearInspectorSize(): void {
  writeStoredInspectorSize(null);
}

export function currentInspectorFrame(viewport: InspectorViewport): InspectorFrame | null {
  const chosen = resolvedInspectorSize();
  if (!chosen) return null;
  return scaleInspectorFrame(chosen.frame, chosen.viewport, viewport);
}

export function clampInspectorFrame(
  frame: InspectorFrame,
  viewport: InspectorViewport
): InspectorFrame {
  const maxWidth = Math.max(1, viewport.width - INSPECTOR_VIEWPORT_GUTTER * 2);
  const maxHeight = Math.max(1, viewport.height - INSPECTOR_VIEWPORT_GUTTER * 2);
  const minWidth = Math.min(INSPECTOR_MIN_WIDTH, maxWidth);
  const minHeight = Math.min(INSPECTOR_MIN_HEIGHT, maxHeight);
  const width = Math.min(maxWidth, Math.max(minWidth, Math.round(frame.width)));
  const height = Math.min(maxHeight, Math.max(minHeight, Math.round(frame.height)));
  // Keep the backdrop's centered placement after switching to a custom size.
  const left = (viewport.width - width) / 2;
  const top = (viewport.height - height) / 2;
  return { left, top, width, height };
}

export function inspectorFrameFromRect(rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}): InspectorFrame {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

export function inspectorFrameFromPointer(args: {
  start: InspectorFrame;
  originX: number;
  originY: number;
  clientX: number;
  clientY: number;
  edge: InspectorResizeEdge;
  viewport: InspectorViewport;
}): InspectorFrame {
  const dx = args.clientX - args.originX;
  const dy = args.clientY - args.originY;
  let { width, height } = args.start;
  // Each dragged edge follows the pointer while its opposite mirrors it.
  if (args.edge.includes('e')) width += dx * 2;
  if (args.edge.includes('w')) width -= dx * 2;
  if (args.edge.includes('s')) height += dy * 2;
  if (args.edge.includes('n')) height -= dy * 2;

  return clampInspectorFrame(
    { ...args.start, width, height },
    args.viewport
  );
}

export function inspectorFrameFromKey(
  frame: InspectorFrame,
  key: string,
  viewport: InspectorViewport
): InspectorFrame | null {
  if (key === 'ArrowRight') {
    return clampInspectorFrame({ ...frame, width: frame.width + INSPECTOR_KEYBOARD_STEP }, viewport);
  }
  if (key === 'ArrowLeft') {
    return clampInspectorFrame({ ...frame, width: frame.width - INSPECTOR_KEYBOARD_STEP }, viewport);
  }
  if (key === 'ArrowDown') {
    return clampInspectorFrame({ ...frame, height: frame.height + INSPECTOR_KEYBOARD_STEP }, viewport);
  }
  if (key === 'ArrowUp') {
    return clampInspectorFrame({ ...frame, height: frame.height - INSPECTOR_KEYBOARD_STEP }, viewport);
  }
  if (key === 'Home') {
    return clampInspectorFrame(
      { ...frame, width: INSPECTOR_MIN_WIDTH, height: INSPECTOR_MIN_HEIGHT },
      viewport
    );
  }
  if (key === 'End') {
    return clampInspectorFrame(
      {
        left: INSPECTOR_VIEWPORT_GUTTER,
        top: INSPECTOR_VIEWPORT_GUTTER,
        width: viewport.width,
        height: viewport.height
      },
      viewport
    );
  }
  return null;
}

export function cursorForInspectorEdge(edge: InspectorResizeEdge): string {
  if (edge === 'e' || edge === 'w') return 'ew-resize';
  if (edge === 'n' || edge === 's') return 'ns-resize';
  if (edge === 'ne' || edge === 'sw') return 'nesw-resize';
  return 'nwse-resize';
}

export function inspectorModalClassName(fullScreen: boolean, resizing = false): string {
  return `modal agent-terminal-modal${fullScreen ? ' is-fullscreen' : ''}${resizing ? ' is-resizing' : ''}`;
}

export function inspectorFrameStyle(
  frame: InspectorFrame | null,
  fullScreen: boolean
): { position: 'absolute'; left: number; top: number; width: number; height: number; minWidth: number; minHeight: number; maxHeight: number; maxWidth: number; margin: number } | undefined {
  if (fullScreen || !frame) return undefined;
  return {
    position: 'absolute',
    left: frame.left,
    top: frame.top,
    width: frame.width,
    height: frame.height,
    // Override the stylesheet's 94vw/94vh min/max lock. Width/height alone
    // cannot shrink below that floor, so a remount looks like a reset.
    minWidth: frame.width,
    minHeight: frame.height,
    maxWidth: frame.width,
    maxHeight: frame.height,
    margin: 0
  };
}

export function applyInspectorFullScreen(next: boolean): void {
  void product.app.setFullScreen(next);
}

export function releaseInspectorFullScreen(wasFullScreen: boolean): void {
  if (wasFullScreen) applyInspectorFullScreen(false);
}

export function focusInspectorDialog(node: { focus(): void } | null): void {
  node?.focus();
}

export function stopInspectorDialogClick(event: { stopPropagation(): void }): void {
  event.stopPropagation();
}

export function toggleInspectorFullScreen(
  current: boolean,
  setFullScreen: (next: boolean) => void
): boolean {
  const next = !current;
  setFullScreen(next);
  applyInspectorFullScreen(next);
  return next;
}
