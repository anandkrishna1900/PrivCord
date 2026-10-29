import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import type { ChatMessage } from '@duochat/protocol';
import { isTauri } from '../config';
import { loadSettings } from './settings';

function preview(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > 140 ? `${single.slice(0, 137)}…` : single;
}

export async function ensureNotificationPermission(): Promise<boolean> {
  if (isTauri()) {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === 'granted';
  }
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

export async function notifyIncoming(
  message: ChatMessage,
  senderName: string,
): Promise<void> {
  const settings = loadSettings();
  if (!settings.notificationsEnabled) return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  const granted = await ensureNotificationPermission();
  if (!granted) return;
  const title = `New message from ${senderName || 'your friend'}`;
  const body = settings.notificationPreviews ? preview(message.text) : 'Open DuoChat to read it.';
  try {
    if (isTauri()) {
      sendNotification({ title, body });
    } else {
      new Notification(title, { body, tag: `duochat-${message.messageId}` });
    }
  } catch {
    // Notifications are best-effort.
  }
}
