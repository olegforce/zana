export const MACHINE_HOST_HEADER: 'x-zcc-connect-machine-host';
export const MACHINE_INSTANCE_HEADER: 'x-zcc-connect-machine-instance';
export const MACHINE_CREDENTIAL_HEADER: 'x-zcc-machine-credential';
export function isMachinePath(method: string | undefined, path: unknown, upgrade?: boolean): boolean;
export function machineIdentity(headers: Record<string, string | string[] | undefined>): { hostId: string; instanceId: string } | null;
