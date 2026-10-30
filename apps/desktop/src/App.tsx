import { useChatEngine } from './hooks/useChatEngine';
import { useSettings } from './hooks/useSettings';
import { ChatLayout } from './components/ChatLayout';

export default function App() {
  const { settings, update } = useSettings();
  const { state, engine, fatal } = useChatEngine(settings.peerNickname);
  return (
    <ChatLayout
      state={state}
      engine={engine}
      settings={settings}
      updateSettings={update}
      fatal={fatal}
    />
  );
}
