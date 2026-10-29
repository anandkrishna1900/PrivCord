import { avatarHue, initials } from '../lib/format';

export function Avatar({
  name,
  size = 40,
  online,
}: {
  name: string;
  size?: number;
  online?: boolean;
}) {
  const hue = avatarHue(name || 'duochat');
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(11, Math.round(size * 0.34)),
        background: `linear-gradient(145deg, hsl(${hue} 58% 46%), hsl(${(hue + 44) % 360} 62% 35%))`,
      }}
    >
      {initials(name)}
      {online ? <span className="avatar-online" /> : null}
    </span>
  );
}
