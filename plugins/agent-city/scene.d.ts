import type { CityBuilding } from './model.js';
export function createCityRenderer(canvas: HTMLCanvasElement, root: HTMLElement): {
  refreshPalette(): void;
  draw(buildings: CityBuilding[], selected: string, elapsed: number, animate: boolean): void;
  hit(x: number, y: number): string | undefined;
} | null;
