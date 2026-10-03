export interface HelpTip {
  id: string;
  selector: string;
  title: string;
  description: string;
  inset?: boolean;
}

export interface PositionedHelpTip {
  tip: HelpTip;
  left: number;
  top: number;
}

export function measureHelpTips(surface: HTMLElement, tips: readonly HelpTip[]): PositionedHelpTip[] {
  const origin = surface.getBoundingClientRect();
  return tips.flatMap((tip) => {
    const target = surface.querySelector<HTMLElement>(tip.selector);
    if (!target) return [];
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return [];
    const style = getComputedStyle(target);
    if (style.visibility === 'hidden' || style.display === 'none') return [];
    return [{
      tip,
      left: Math.max(12, Math.min(origin.width - 12, rect.right - origin.left - (tip.inset ? 56 : 4))),
      top: rect.top - origin.top + (tip.inset ? 12 : -4)
    }];
  });
}
