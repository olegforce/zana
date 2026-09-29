import Constants from 'expo-constants';
import { useState } from 'react';
import { discoverServers, type AccountServer } from '../src/lib/client';
import type { ServerProfile } from '../src/lib/profiles';
import { clearNativeProfileSession } from '../src/lib/session-controller';
import CookieManager from '@react-native-cookies/cookies';
import { Alert, Platform, Switch, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useProfiles } from '../src/state';
import { Action, Heading, Label, Screen } from '../src/ui';
import { removeProfile, saveProfile, isOnlineProfile } from '../src/lib/profiles';
export default function Settings() {
  const { state, update } = useProfiles();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [discovery, setDiscovery] = useState<{ profile: ServerProfile; servers: AccountServer[] } | null>(null);
  const run = (job: Promise<unknown>) => {
    void job.catch((e: Error) => Alert.alert('Could not save settings', e.message));
  };
  return (
    <Screen>
      <Heading>This device</Heading>
      <Label muted>Server settings and plugins are available inside Zana.</Label>
      <Label>Saved servers</Label>
      {state.profiles.map((p) => (
        <View key={p.id} style={{ gap: 8 }}>
          <Action
            secondary
            title={`${state.activeId === p.id ? '✓ ' : ''}${p.label}`}
            disabled={!isOnlineProfile(p)}
            onPress={() => {
              run(update((s) => ({ ...s, activeId: p.id })).then(() => router.replace('/')));
            }}
          />
          <Label muted>{p.serverUrl}</Label>
          {p.connectDomain ? <Action secondary disabled={busy} title="Computers on this account" onPress={() => {
            setBusy(true);
            run(discoverServers(p).then(servers => setDiscovery({ profile: p, servers })).finally(() => setBusy(false)));
          }} /> : null}
          {discovery?.profile.id === p.id ? <View style={{ gap: 8 }}>
            {discovery.servers.map(server => <Action key={server.id} secondary title={`${server.name} · ${server.live ? 'Online' : 'Offline'}`} onPress={() => {
              run(update(s => saveProfile(s, { id: server.id, label: server.name, serverUrl: server.serverUrl, credential: p.credential, deviceId: p.deviceId, connectDomain: p.connectDomain, accountUrl: p.accountUrl })).then(() => router.replace('/')));
            }} />)}
            {!discovery.servers.length ? <Label muted>No connected computers.</Label> : null}
          </View> : null}
          {!isOnlineProfile(p) ? <Label muted>Retired direct connection. Sign in with GitHub to reconnect online.</Label> : null}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Action
              secondary
              title="Sign in with GitHub"
              onPress={() => router.push('/connect')}
            />
            <Action
              secondary
              title="Forget"
              onPress={() =>
                Alert.alert(
                  'Forget this server?',
                  'This removes the saved computer from this phone. Revoke phone access on your Zana account page to invalidate its account credential.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Forget',
                      style: 'destructive',
                      onPress: () =>
                        run(
                          (async () => {
                            await clearNativeProfileSession(p, {
                              cookies: CookieManager,
                              platform: Platform.OS === 'ios' ? 'ios' : 'android'
                            });
                            await update((s) => removeProfile(s, p.id));
                          })()
                        )
                    }
                  ]
                )
              }
            />
          </View>
        </View>
      ))}
      <Action title="Connect a computer" onPress={() => router.push('/connect')} />
      <Label>Appearance</Label>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {(['system', 'light', 'dark'] as const).map((value) => (
          <Action
            key={value}
            secondary={state.appearance !== value}
            title={value[0]!.toUpperCase() + value.slice(1)}
            onPress={() => run(update((s) => ({ ...s, appearance: value })))}
          />
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Label>Haptic feedback</Label>
        <Switch
          accessibilityLabel="Haptic feedback"
          value={state.haptics}
          onValueChange={(value) => run(update((s) => ({ ...s, haptics: value })))}
        />
      </View>
      <Label muted>Zana Mobile {Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? 'Unknown version'} · Agent execution stays on your computer.</Label>
    </Screen>
  );
}
