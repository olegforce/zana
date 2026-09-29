import { URL } from 'whatwg-url-minimum';
import { normalizeServerUrl } from './urls';
import { isConnectServer } from './connect-discovery';
export interface ServerProfile {
  id: string;
  label: string;
  serverUrl: string;
  credential?: string;
  deviceId?: string;
  pushEnabled?: boolean;
  connectDomain?: string;
  accountUrl?: string;
}
export const CONNECT_ACCOUNT_URL = 'https://zana-ide.com';
export interface AccountAccess {
  credential: string;
  deviceId: string;
  connectDomain: string;
  accountUrl: string;
}
export interface PhoneLogin {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
}
export function validAccount(value: unknown): value is AccountAccess {
  const a = value as AccountAccess | undefined;
  try {
    return !!a && typeof a.credential === 'string' && /^[\w-]{43}$/.test(a.credential)
      && typeof a.deviceId === 'string' && /^[\w-]{1,64}$/.test(a.deviceId)
      && typeof a.connectDomain === 'string' && isConnectServer(`https://s-${'a'.repeat(24)}.${a.connectDomain}`, a.connectDomain)
      && typeof a.accountUrl === 'string' && a.accountUrl.startsWith('https://') && normalizeServerUrl(a.accountUrl) === a.accountUrl;
  } catch { return false; }
}
export function validPhoneLogin(value: unknown): value is PhoneLogin {
  const p = value as PhoneLogin | undefined;
  return !!p && typeof p.deviceCode === 'string' && /^[\w-]{43}$/.test(p.deviceCode)
    && typeof p.userCode === 'string' && /^[\w-]{22}$/.test(p.userCode)
    && p.verificationUrl === `${CONNECT_ACCOUNT_URL}/connect/?phone=${p.userCode}`
    && Number.isFinite(p.expiresAt) && p.expiresAt > 0;
}
/** Legacy profiles remain readable for migration, but must never make requests. */
export function isOnlineProfile(profile: ServerProfile): boolean {
  return validAccount(profile) && isConnectServer(profile.serverUrl, profile.connectDomain!);
}
export interface MobileState {
  account?: AccountAccess;
  phoneLogin?: PhoneLogin;
  profiles: ServerProfile[];
  activeId: string | null;
  haptics: boolean;
  appearance: 'system' | 'light' | 'dark';
}
export const EMPTY_STATE: MobileState = {
  profiles: [],
  activeId: null,
  haptics: true,
  appearance: 'system'
};
export interface SecureStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
}
const KEY = 'zana.mobile.profiles.v1';
export function parseMobileState(raw: string | null): MobileState {
  if (!raw) return { ...EMPTY_STATE, profiles: [] };
  if (raw.length > 16_384) throw new Error('Saved servers are invalid.');
  const state = JSON.parse(raw) as MobileState;
  if (
    !Array.isArray(state.profiles) ||
    state.profiles.length > 12 ||
    typeof state.haptics !== 'boolean' ||
    !['system', 'light', 'dark'].includes(state.appearance)
  )
    throw new Error('Saved servers are invalid.');
  if ((state.account !== undefined && !validAccount(state.account)) ||
      (state.phoneLogin !== undefined && !validPhoneLogin(state.phoneLogin))) throw new Error('Saved account is invalid.');
  for (const p of state.profiles) {
    if (
      typeof p.id !== 'string' ||
      !/^[\w-]{1,64}$/.test(p.id) ||
      typeof p.label !== 'string' ||
      p.label.length > 80 ||
      normalizeServerUrl(p.serverUrl) !== p.serverUrl ||
      (p.credential !== undefined && !/^[\w-]{43}$/.test(p.credential)) ||
      (p.connectDomain !== undefined && (!p.credential || !isConnectServer(p.serverUrl, p.connectDomain) || typeof p.accountUrl !== 'string' || !p.accountUrl.startsWith('https://') || normalizeServerUrl(p.accountUrl) !== p.accountUrl))
    )
      throw new Error('Saved server is invalid.');
  }
  if (
    new Set(state.profiles.map((p) => p.id)).size !== state.profiles.length ||
    (state.activeId !== null && !state.profiles.some((p) => p.id === state.activeId))
  )
    throw new Error('Saved server selection is invalid.');
  return state;
}
export class ProfileStore {
  private queue: Promise<unknown> = Promise.resolve();
  private state: MobileState = { ...EMPTY_STATE, profiles: [] };
  constructor(private readonly storage: SecureStorage) {}
  async load() {
    this.state = parseMobileState(await this.storage.getItemAsync(KEY));
    return this.state;
  }
  update(change: (state: MobileState) => MobileState): Promise<MobileState> {
    const job = this.queue.then(async () => {
      const next = change(this.state);
      const raw = JSON.stringify(next);
      parseMobileState(raw);
      await this.storage.setItemAsync(KEY, raw);
      this.state = next;
      return next;
    });
    this.queue = job.catch(() => {});
    return job;
  }
}
export function saveProfile(state: MobileState, profile: ServerProfile): MobileState {
  const existing = state.profiles.find((p) => p.serverUrl === profile.serverUrl);
  const next = {
    ...profile,
    id: existing?.id ?? profile.id,
    label: profile.label.trim().slice(0, 80) || new URL(profile.serverUrl).hostname
  };
  return {
    ...state,
    activeId: next.id,
    profiles: existing
      ? state.profiles.map((p) => (p.id === existing.id ? next : p))
      : [...state.profiles, next]
  };
}
export function removeProfile(state: MobileState, id: string): MobileState {
  const profiles = state.profiles.filter((p) => p.id !== id);
  return {
    ...state,
    profiles,
    activeId: state.activeId === id ? (profiles[0]?.id ?? null) : state.activeId
  };
}
