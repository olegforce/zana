// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
const config = vi.hoisted(() => vi.fn());
vi.mock('@monaco-editor/react', () => ({ loader: { config } }));
vi.mock('monaco-editor', () => ({ editor: { create: vi.fn() } }));
vi.mock('monaco-editor/editor/editor.worker.js?worker', () => ({ default: class Editor {} }));
vi.mock('monaco-editor/language/json/json.worker.js?worker', () => ({ default: class Json {} }));
vi.mock('monaco-editor/language/css/css.worker.js?worker', () => ({ default: class Css {} }));
vi.mock('monaco-editor/language/html/html.worker.js?worker', () => ({ default: class Html {} }));
vi.mock('monaco-editor/language/typescript/ts.worker.js?worker', () => ({ default: class Ts {} }));
import { monaco } from './monacoSetup.js';

it('shares the bundled editor instance and dispatches every worker language locally', () => {
  expect(config).toHaveBeenCalledWith({ monaco });
  expect((globalThis as any).__ZCC_MONACO__).toBe(monaco);
  const worker = (self as any).MonacoEnvironment.getWorker;
  for (const [label, name] of Object.entries({ json: 'Json', css: 'Css', scss: 'Css', less: 'Css', html: 'Html', handlebars: 'Html', razor: 'Html', typescript: 'Ts', javascript: 'Ts', plaintext: 'Editor' })) {
    expect(worker('', label).constructor.name).toBe(name);
  }
});
