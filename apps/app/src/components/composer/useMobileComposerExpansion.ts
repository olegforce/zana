import { useEffect, useRef, type RefObject } from 'react';

/** Enlarge the existing editor in place so its draft, selection and undo survive. */
export function useMobileComposerExpansion(
  rootRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  onClose: () => void
) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return;
    const opener = document.activeElement as HTMLElement | null;
    const viewport = window.visualViewport;
    const resize = () => {
      root.style.top = `${viewport?.offsetTop ?? 0}px`;
      root.style.height = `${viewport?.height ?? window.innerHeight}px`;
    };
    resize();
    viewport?.addEventListener('resize', resize);
    viewport?.addEventListener('scroll', resize);
    window.addEventListener('resize', resize);
    root.querySelector<HTMLButtonElement>('.mobile-composer-expanded-done')?.focus();
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Picklists may retain focus on their trigger; their own listener gets
      // Escape/Tab first. Portalled dialogs are outside this native listener.
      if (root.querySelector('[aria-haspopup][aria-expanded="true"]')) return;
      if (event.key === 'Escape') {
        if (root.querySelector('.thread-command-options-toggle[aria-expanded="true"]')) return;
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
      if (event.key !== 'Tab') return;
      const controls = [...root.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [contenteditable="true"], [tabindex="0"]'
      )].filter((element) => {
        for (let node: HTMLElement | null = element; node && node !== root; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (node.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
        }
        return true;
      });
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    root.addEventListener('keydown', keydown);
    return () => {
      viewport?.removeEventListener('resize', resize);
      viewport?.removeEventListener('scroll', resize);
      window.removeEventListener('resize', resize);
      root.removeEventListener('keydown', keydown);
      root.style.removeProperty('top');
      root.style.removeProperty('height');
      if (opener?.isConnected) opener.focus();
    };
  }, [enabled, rootRef]);
}
