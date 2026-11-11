import { avatarHue, initials } from '../lib/format';

/** A soft tonal circle (a rounded square for groups) with the initials in a deeper shade of the same hue. */
export function Avatar({
  name,
  size = 40,
  online,
  group,
}: {
  name: string;
  size?: number;
  online?: boolean;
  group?: boolean;
}) {
  const hue = avatarHue((name || 'duochat').replace(/^# /, ''));
  return (
    <span
      className={`avatar ${group ? 'group' : ''}`}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(11, Math.round(size * 0.36)),
        borderRadius: group ? Math.round(size * 0.32) : '50%',
        ['--hue' as string]: String(hue),
      }}
    >
      {initials(name.replace(/^# /, ''))}
      {online ? <span className="avatar-online" /> : null}
    </span>
  );
}

/** The mark: a plum tile with an apricot seal in its corner. */
export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <span className="brand-mark" aria-hidden="true" style={{ width: size, height: size }}>
      <svg viewBox="0 0 32 32" width={size} height={size}>
        <rect x="0" y="0" width="27.5" height="27.5" rx="8" fill="var(--accent-fill)" />
        <path
          d="M10.2 13v-2.2a3.55 3.55 0 0 1 7.1 0V13M9 13h9.5a1 1 0 0 1 1 1v5.6a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V14a1 1 0 0 1 1-1z"
          fill="none"
          stroke="#fff"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <circle cx="26.5" cy="26.5" r="5.5" fill="var(--bg)" />
        <circle cx="26.5" cy="26.5" r="3.9" fill="var(--apricot)" />
      </svg>
    </span>
  );
}
