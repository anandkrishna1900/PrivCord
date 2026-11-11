import appIcon from '../assets/app-icon.png';
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

/** The app's icon, wherever the app shows its mark. */
export function BrandMark({ size = 32 }: { size?: number }) {
  return <img className="brand-mark" src={appIcon} alt="" aria-hidden="true" width={size} height={size} style={{ width: size, height: size }} draggable={false} />;
}
