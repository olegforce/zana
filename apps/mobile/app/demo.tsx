import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Action, Field, Heading, Label, Screen, useColors } from '../src/ui';

const WELCOME = 'This sample project is a small website. In a connected project, you can ask an agent to inspect files, make changes, and report its progress from your phone.';
const REPLY = 'This is a scripted demo reply. With your computer connected, your message would go to an agent working on that project. You could follow its progress here, answer questions, and review the result. No files or agents were changed by this demo.';

/** Local sample only: never creates a profile, calls a server, or starts work. */
export default function Demo() {
  const router = useRouter();
  const c = useColors();
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  return (
    <Screen>
      <Heading>Explore Zana</Heading>
      <Label muted>Demo · Sample data. Replies are scripted. Nothing runs on a computer, and messages are not saved or sent to a server.</Label>
      <View style={{ gap: 12, backgroundColor: c.panel, padding: 18, borderRadius: 14 }}>
        <Label>Sample project: My website</Label>
        <Label muted>Conversation: Plan a homepage update</Label>
        <Label>{WELCOME}</Label>
      </View>
      {sent !== null ? <>
        <View style={{ gap: 8, backgroundColor: c.panel, padding: 18, borderRadius: 14 }}>
          <Label muted>You</Label>
          <Label>{sent}</Label>
        </View>
        <View style={{ gap: 8, backgroundColor: c.panel, padding: 18, borderRadius: 14 }}>
          <Label muted>Demo assistant</Label>
          <Label>{REPLY}</Label>
        </View>
      </> : null}
      <Field
        label="Try a sample message"
        testID="demo-message"
        placeholder="Help me plan a clearer homepage"
        value={message}
        onChangeText={setMessage}
        maxLength={1000}
        multiline
      />
      <Action
        title="Send sample message"
        testID="demo-send"
        disabled={!message.trim()}
        onPress={() => {
          const value = message.trim().slice(0, 1000);
          if (!value) return;
          setSent(value);
          setMessage('');
        }}
      />
      <Action secondary title="Reset demo" onPress={() => { setSent(null); setMessage(''); }} />
      <Label muted>To work on your own projects, open Settings → Phone in Zana on your computer, then pair this phone.</Label>
      <Action title="Connect my computer" onPress={() => router.replace('/connect')} />
    </Screen>
  );
}
