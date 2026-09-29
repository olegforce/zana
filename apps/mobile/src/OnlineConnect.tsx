import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useProfiles } from './state';
import { Action, Heading, Label, Screen, useColors } from './ui';
import { discoverAccountServers, pollPhoneLogin, startPhoneLogin, type AccountServer } from './lib/client';
import { CONNECT_ACCOUNT_URL, saveProfile, isOnlineProfile } from './lib/profiles';

export function OnlineConnect() {
  const { state, ready, update } = useProfiles();
  const router = useRouter();
  const colors = useColors();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [servers, setServers] = useState<AccountServer[] | null>(null);
  const [refresh, setRefresh] = useState(0);
  const operation = useRef(false);
  const login = state.phoneLogin;
  const account = state.account;
  // Persist before opening Safari: iOS may suspend or terminate the native app.
  async function signIn() {
    if (operation.current || !ready) return;
    operation.current = true; setBusy(true); setError('');
    try {
      const pending = await startPhoneLogin(Platform.OS === 'ios' ? 'Zana on iPhone' : 'Zana on Android');
      await update(current => ({ ...current, phoneLogin: pending }));
      await Linking.openURL(pending.verificationUrl);
    } catch (err) { setError((err as Error).message); }
    finally { operation.current = false; setBusy(false); }
  }
  useEffect(() => {
    if (!ready || !login) return;
    let active = true, polling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!active || polling || AppState.currentState === 'background') return;
      polling = true; clearTimeout(timer);
      try {
        const granted = await pollPhoneLogin(login);
        if (!active) return;
        if (granted) {
          // A cancelled/replaced request must never restore access on a late response.
          await update(current => current.phoneLogin?.deviceCode === login.deviceCode
            ? { ...current, phoneLogin: undefined, account: granted } : current);
        } else timer = setTimeout(() => void poll(), 3000);
      } catch (err) { if (active) setError((err as Error).message); }
      finally { polling = false; }
    };
    void poll();
    const subscription = AppState.addEventListener('change', value => { if (value === 'active') void poll(); });
    return () => { active = false; clearTimeout(timer); subscription.remove(); };
  }, [ready, login, update, refresh]);
  useEffect(() => {
    if (!ready || !account || login) return;
    let active = true;
    setBusy(true); setError(''); setServers(null);
    void discoverAccountServers(account).then(value => { if (active) setServers(value); })
      .catch(err => { if (active) setError((err as Error).message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [ready, account, login, refresh]);
  async function choose(server: AccountServer) {
    if (operation.current || !account || !server.live) return;
    operation.current = true; setBusy(true); setError('');
    try {
      await update(current => saveProfile(current, { ...account, id: server.id, label: server.name, serverUrl: server.serverUrl }));
      router.replace('/');
    } catch (err) { setError((err as Error).message); }
    finally { operation.current = false; setBusy(false); }
  }
  const run = (job: Promise<unknown>) => { void job.catch(err => setError((err as Error).message)); };
  return <Screen>
    <Heading>{account && !login ? 'Choose your computer' : 'Your agents, anywhere.'}</Heading>
    <Label muted>Sign in with the same GitHub account as Zana on your computer. Connect securely over Wi-Fi or cellular internet.</Label>
    {state.profiles.some(profile => !isOnlineProfile(profile)) ? <Label muted>Local and direct connections have been retired. Sign in with GitHub to reconnect through Zana Connect. Your saved computers have been kept.</Label> : null}
    {login ? <>
      <Label>Approve your phone in the browser, then return here. Your computers will appear automatically.</Label>
      <Action title="Continue in browser" onPress={() => run(Linking.openURL(login.verificationUrl))} />
      <Action secondary title="Check sign-in" onPress={() => { setError(''); setRefresh(value => value + 1); }} />
      <Action secondary title="Cancel sign-in" onPress={() => run(update(current => ({ ...current, phoneLogin: undefined })))} />
    </> : account ? <>
      {servers?.map(server => <View key={server.id} style={{ gap: 8 }}>
        <Action title={`${server.name} · ${server.live ? 'Connect' : 'Offline'}`} disabled={busy || !server.live} onPress={() => void choose(server)} />
        {server.browserUrl ? <Label muted>{server.browserUrl.replace('https://', '')}</Label> : null}
        {!server.live ? <Label muted>Open Zana on this computer and keep it awake.</Label> : null}
      </View>)}
      {servers?.length === 0 ? <Label>No computers yet. On your computer, open Zana → Settings → Remote access and connect the same GitHub account.</Label> : null}
      <Action secondary title="Refresh computers" disabled={busy} onPress={() => setRefresh(value => value + 1)} />
      <Action secondary title="Sign in again" disabled={busy} onPress={() => void signIn()} />
    </> : <>
      <Action testID="github-sign-in" title="Continue with GitHub" disabled={busy || !ready} onPress={() => void signIn()} />
      <Label muted>On your computer: Settings → Remote access → connect your GitHub account. Keep Zana running while you use your phone.</Label>
    </>}
    {error ? <Label>{error}</Label> : null}
    {busy ? <ActivityIndicator color={colors.accent} /> : null}
    <Action secondary title="Manage account and devices" onPress={() => run(Linking.openURL(`${CONNECT_ACCOUNT_URL}/connect/`))} />
    {state.profiles.length ? <Action secondary title="Back to saved computers" onPress={() => router.replace('/settings')} /> : null}
    <Action secondary title="Try a demo without connecting" disabled={busy} onPress={() => router.push('/demo')} />
  </Screen>;
}
