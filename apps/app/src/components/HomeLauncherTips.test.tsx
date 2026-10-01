// @vitest-environment happy-dom
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeLauncherTips } from './HomeLauncherTips.js';
import { HelpProvider } from './help/HelpProvider.js';
import { measureHelpTips } from './help/help-targets.js';
import { HOME_LAUNCHER_TIPS } from './home-launcher-tips.js';

const observers = { resize: vi.fn(), mutate: vi.fn(), resizeDisconnect: vi.fn(), mutationDisconnect: vi.fn() };
let resizeCallback: () => void;
let mutationCallback: () => void;
let frames: Map<number, FrameRequestCallback>;
let rectLeft = 0;
const rect = (left = 0, top = 0, width = 100, height = 30) => ({
  left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({})
});

beforeEach(() => {
  localStorage.clear();
  rectLeft = 0;
  frames = new Map();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resizeCallback = callback; }
    observe = observers.resize;
    disconnect = observers.resizeDisconnect;
  });
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) { mutationCallback = callback; }
    observe = observers.mutate;
    disconnect = observers.mutationDisconnect;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (this.classList.contains('contextual-help-surface')) return rect(10, 20, 800, 240);
    if (this.hidden || this.style.display === 'none') return rect(0, 0, 0, 0);
    return rect(30 + rectLeft, 60, 100, 30);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function flushMeasure() {
  act(() => { for (const [id, callback] of frames) { frames.delete(id); callback(0); } });
}

function launcher(extra?: React.ReactNode) {
  return <HelpProvider><HomeLauncherTips>
    <div className="launch-segmented"><button data-launch-mode="agent">CLI Agent</button><button data-launch-mode="thread">Modern</button></div>
    <div className="thread-command-editor-slot"><input aria-label="Task draft" /></div>
    <button data-testid="model-reasoning-picker-trigger">Model</button>
    <button aria-label="Project">Project</button>
    {extra}
  </HomeLauncherTips></HelpProvider>;
}
const enable = () => fireEvent.click(screen.getByRole('button', { name: /Need a few tips/ }));
const tip = (name: string) => screen.getByRole('button', { name: `Tip: ${name}` });

describe('HomeLauncherTips', () => {
  it('is opt-in and preserves the real controls and draft when shown or hidden', () => {
    const mount = vi.fn();
    function ExistingControl() { useEffect(mount, []); return <button>Existing control</button>; }
    render(launcher(<ExistingControl />));
    const input = screen.getByLabelText('Task draft');
    fireEvent.change(input, { target: { value: 'Keep this unsent task' } });
    expect(screen.queryAllByRole('button', { name: /^Tip:/ })).toHaveLength(0);
    expect(observers.resize).not.toHaveBeenCalled();
    enable();
    expect(screen.getAllByRole('button', { name: /^Tip:/ })).toHaveLength(5);
    expect(screen.getByRole('button', { name: /Done/ }).getAttribute('aria-pressed')).toBe('true');
    tip('Pick a model').focus();
    fireEvent.click(tip('Pick a model'));
    expect(screen.getByRole('region', { name: 'Launcher tip' }).textContent).toContain('thinking effort');
    fireEvent.click(screen.getByRole('button', { name: /Done/ }));
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.queryAllByRole('button', { name: /^Tip:/ })).toHaveLength(0);
    expect(screen.getByLabelText('Task draft')).toBe(input);
    expect((input as HTMLInputElement).value).toBe('Keep this unsent task');
    expect(mount).toHaveBeenCalledOnce();
  });

  it('navigates only the available tips and restores dot focus when closing', () => {
    render(launcher()); enable();
    fireEvent.click(tip('CLI Agent'));
    expect(screen.getByRole('region').textContent).toContain('Open an agent in a terminal');
    expect((screen.getByRole('button', { name: 'Previous tip' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next tip' }));
    expect(screen.getByRole('heading').textContent).toBe('Modern');
    expect(screen.getByRole('region').textContent).toContain('best UX');
    expect(screen.getByRole('region').textContent).toContain('accessible via mobile');
    fireEvent.click(screen.getByRole('button', { name: 'Previous tip' }));
    expect(screen.getByRole('heading').textContent).toBe('CLI Agent');
    fireEvent.click(tip('Set the project'));
    expect(screen.getByRole('region').textContent).toContain('Use Default Project for tasks that aren’t tied to anything specific');
    expect(screen.getByRole('region').textContent).toContain('recognize when your request relates to another project');
    expect((screen.getByRole('button', { name: 'Next tip' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close tip' }));
    expect(document.activeElement).toBe(tip('Set the project'));
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('closes explanations then tips on Escape while leaving composer and portal events alone', () => {
    render(launcher(createPortal(<button>Portalled picker</button>, document.body))); enable();
    fireEvent.click(tip('Pick a model'));
    fireEvent.keyDown(screen.getByLabelText('Task draft'), { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Portalled picker' }), { key: 'Escape' });
    fireEvent.keyDown(tip('Pick a model'), { key: 'ArrowRight' });
    expect(screen.getByRole('region')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close tip' }), { key: 'Escape' });
    expect(screen.queryByRole('region')).toBeNull();
    expect(document.activeElement).toBe(tip('Pick a model'));
    fireEvent.keyDown(tip('Pick a model'), { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Need a few tips/ }));
  });

  it('respects Escape already handled by a nested control', () => {
    render(<div onKeyDownCapture={(event) => event.preventDefault()}>{launcher()}</div>); enable();
    fireEvent.click(tip('Pick a model'));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close tip' }), { key: 'Escape' });
    expect(screen.getByRole('region')).toBeTruthy();
  });

  it('keeps mobile helpers in place until their click, without taking over composer or portal controls', () => {
    render(launcher(createPortal(<button>Portalled picker</button>, document.body)));
    const invitation = screen.getByRole('button', { name: /Need a few tips/ });
    const input = screen.getByLabelText('Task draft');
    input.focus();
    expect(fireEvent.mouseDown(invitation.querySelector('strong')!)).toBe(false);
    expect(document.activeElement).toBe(input);
    fireEvent.click(invitation);
    expect(document.activeElement).toBe(invitation);
    expect(fireEvent.mouseDown(input)).toBe(true);
    fireEvent.click(input);
    const portal = screen.getByRole('button', { name: 'Portalled picker' });
    expect(fireEvent.mouseDown(portal)).toBe(true);
    fireEvent.click(portal);
    expect(document.activeElement).toBe(invitation);
    expect(fireEvent.mouseDown(document.querySelector('.contextual-help-surface')!)).toBe(true);
    fireEvent.click(tip('Pick a model'));
    expect(document.activeElement).toBe(tip('Pick a model'));
  });

  it('leaves files, voice, and send without hints while their controls remain usable', () => {
    const attach = vi.fn();
    const voice = vi.fn();
    const send = vi.fn();
    const { container } = render(launcher(<>
      <button aria-label="Attach files" onClick={attach}>Files</button>
      <button className="voice-input-btn" onClick={voice}>Voice</button>
      <button className="thread-command-send" onClick={send}>Send</button>
    </>));
    enable();
    expect(screen.getAllByRole('button', { name: /^Tip:/ })).toHaveLength(5);
    expect(container.querySelector('[data-tip-id="attachments"], [data-tip-id="voice"], [data-tip-id="send"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Attach files' }));
    fireEvent.click(screen.getByRole('button', { name: 'Voice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(attach).toHaveBeenCalledOnce();
    expect(voice).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });

  it('remeasures on resize and mutation, coalesces updates, and cleans up', () => {
    const { unmount } = render(launcher()); enable();
    const dot = tip('Pick a model');
    expect(dot.style.left).toBe('116px');
    rectLeft = 80;
    resizeCallback(); mutationCallback(); window.dispatchEvent(new Event('resize'));
    expect(frames.size).toBe(1);
    flushMeasure();
    expect(dot.style.left).toBe('196px');
    resizeCallback();
    unmount();
    expect(frames.size).toBe(0);
    expect(observers.resizeDisconnect).toHaveBeenCalledOnce();
    expect(observers.mutationDisconnect).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event('resize'));
    expect(frames.size).toBe(0);
  });

  it('removes dots and stale explanations when switching to controls without a model', () => {
    function Launcher() {
      const [model, setModel] = useState(true);
      return <HelpProvider><HomeLauncherTips>
        <button aria-label="Squad" onClick={() => setModel(false)}>Squad</button>
        {model && <button data-testid="model-reasoning-picker-trigger">Model</button>}
        <button aria-label="Project">Project</button>
      </HomeLauncherTips></HelpProvider>;
    }
    render(<Launcher />); enable();
    fireEvent.click(tip('Pick a model'));
    fireEvent.click(screen.getByRole('button', { name: 'Squad', exact: true }));
    mutationCallback(); flushMeasure();
    expect(screen.queryByRole('button', { name: 'Tip: Pick a model' })).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Tip:/ })).toHaveLength(2);
  });
});

describe('launcher help target measurement', () => {
  it('recognizes every supported control and puts the prompt dot inside its field', () => {
    const surface = document.createElement('div');
    surface.className = 'contextual-help-surface';
    for (const entry of HOME_LAUNCHER_TIPS) {
      const button = document.createElement('button');
      if (entry.selector.startsWith('.')) button.className = entry.selector.slice(1);
      else {
        const attribute = /\[(.*?)="(.*?)"\]/.exec(entry.selector)!;
        button.setAttribute(attribute[1], attribute[2]);
      }
      surface.append(button);
    }
    document.body.append(surface);
    const measured = measureHelpTips(surface, HOME_LAUNCHER_TIPS);
    expect(measured).toHaveLength(HOME_LAUNCHER_TIPS.length);
    expect(measured.find(({ tip }) => tip.id === 'prompt')).toMatchObject({ left: 64, top: 52 });
    surface.remove();
  });

  it('skips hidden, zero-size, and missing controls and confines dots to the surface', () => {
    const surface = document.createElement('div');
    surface.className = 'contextual-help-surface';
    surface.innerHTML = '<button data-launch-mode="agent" hidden></button><div class="thread-command-editor-slot" style="visibility:hidden"></div><button aria-label="Project">Project</button>';
    document.body.append(surface);
    expect(measureHelpTips(surface, HOME_LAUNCHER_TIPS).map(({ tip }) => tip.id)).toEqual(['project']);
    rectLeft = -1000;
    expect(measureHelpTips(surface, HOME_LAUNCHER_TIPS)[0].left).toBe(12);
    rectLeft = 1000;
    expect(measureHelpTips(surface, HOME_LAUNCHER_TIPS)[0].left).toBe(788);
    surface.remove();
  });
});
