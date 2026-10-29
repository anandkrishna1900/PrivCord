export function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

export function formatDay(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  }).format(date);
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function formatLastSeen(timestamp: number | null): string {
  if (!timestamp) return 'Last seen unavailable';
  const delta = Date.now() - timestamp;
  if (delta < 90_000) return 'Active recently';
  if (delta < 3_600_000) {
    const minutes = Math.max(1, Math.round(delta / 60_000));
    return `Last seen ${minutes}m ago`;
  }
  if (delta < 86_400_000) {
    const hours = Math.max(1, Math.round(delta / 3_600_000));
    return `Last seen ${hours}h ago`;
  }
  return `Last seen ${new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(new Date(timestamp))}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return Array.from(parts[0] ?? '?').slice(0, 2).join('').toUpperCase();
  return `${Array.from(parts[0] ?? '')[0] ?? ''}${Array.from(parts[parts.length - 1] ?? '')[0] ?? ''}`.toUpperCase();
}

export function avatarHue(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

export function truncateMiddle(value: string, limit = 24): string {
  if (value.length <= limit) return value;
  const head = Math.ceil((limit - 1) / 2);
  const tail = Math.floor((limit - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
