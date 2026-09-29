import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useProfiles } from './state';
import { notificationRoute } from './lib/notification-route';
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: AppState.currentState !== 'active',
    shouldShowList: true,
    shouldPlaySound: AppState.currentState !== 'active',
    shouldSetBadge: true
  })
});
export function NotificationsHost() {
  const { state, ready } = useProfiles();
  const router = useRouter();
  useEffect(() => {
    if (!ready) return;
    let active = true;
    const open = (response: Notifications.NotificationResponse | null) => {
      if (!response || !active) return;
      const route = notificationRoute(response.notification.request.content.data, state.profiles);
      if (route) {
        router.push(route as '/');
        void Notifications.clearLastNotificationResponseAsync();
      }
    };
    void Notifications.getLastNotificationResponseAsync().then(open);
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    return () => {
      active = false;
      subscription.remove();
    };
  }, [ready, state.profiles]);
  return null;
}
