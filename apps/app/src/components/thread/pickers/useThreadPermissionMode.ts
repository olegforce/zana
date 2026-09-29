import { useCallback, useEffect, useState } from 'react';
import { permissionModeSchema, type PermissionMode } from '@zana-ai/zcc-domain/thread-runtime';
import { permissionModeOptionsFor } from './permission-mode-options.js';
import { useBooleanPreference } from '../../../lib/use-boolean-preference.js';
import { FULL_ACCESS_BY_DEFAULT, FULL_ACCESS_BY_DEFAULT_KEY } from '../../../lib/composer-permission-preference.js';

export function useThreadPermissionMode({
  threadId,
  initialPermissionMode,
  supportedModes
}: {
  threadId?: string;
  initialPermissionMode?: string | null;
  supportedModes?: readonly string[];
}) {
  const [fullAccessByDefault] = useBooleanPreference(FULL_ACCESS_BY_DEFAULT_KEY, FULL_ACCESS_BY_DEFAULT);
  const parsed = permissionModeSchema.safeParse(initialPermissionMode);
  // New agents prefer automatic review; saved threads keep their original policy.
  // Keep this preference while the catalog loads, then project onto offered modes below.
  const persisted = parsed.success ? parsed.data : threadId ? 'accept-edits' : fullAccessByDefault ? 'full' : 'auto';
  const [selected, setSelected] = useState<PermissionMode>(persisted);

  // Detail arrives asynchronously after creation/navigation. Repeated polls of
  // the same saved value must not overwrite a choice the user is still making.
  useEffect(() => {
    setSelected(persisted);
  }, [threadId, persisted]);

  const offered = permissionModeOptionsFor(supportedModes ?? []);
  const permissionMode = offered.length > 0 && !offered.some((row) => row.value === selected)
    ? offered[0]!.value
    : selected;
  const setPermissionMode = useCallback((value: string) => {
    const next = permissionModeSchema.safeParse(value);
    if (next.success) setSelected(next.data);
  }, []);
  return { permissionMode, setPermissionMode };
}
