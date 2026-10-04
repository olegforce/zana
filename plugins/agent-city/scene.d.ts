import type { CityBuilding } from './model.js';
import type { InteriorModel } from './interior.js';
export function createCityRenderer(canvas: HTMLCanvasElement, root: HTMLElement): {
  refreshPalette(): void;
  dispose(): void;
  draw(buildings: CityBuilding[], selected: string, elapsed: number, animate: boolean, interior?: InteriorModel): void;
  hit(x: number, y: number): string | undefined;
} | null;
