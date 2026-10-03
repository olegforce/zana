let loading: Promise<typeof import('monaco-editor')> | undefined;

/** Share the host editor instance without putting it in the shell's startup graph. */
export function loadHostMonaco(): Promise<typeof import('monaco-editor')> {
  loading ??= import('./monacoSetup.js').then(module => module.monaco).catch(error => {
    loading = undefined;
    throw error;
  });
  return loading;
}

(globalThis as { __ZCC_LOAD_MONACO__?: typeof loadHostMonaco }).__ZCC_LOAD_MONACO__ = loadHostMonaco;
