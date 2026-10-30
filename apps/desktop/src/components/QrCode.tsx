import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/** Draws `value` as a QR code (SVG, no network). Falls back to nothing if it does not fit. */
export function QrCode({ value, label }: { value: string; label: string }) {
  const svg = useMemo(() => {
    try {
      const qr = qrcode(0, 'L');
      qr.addData(value);
      qr.make();
      return qr.createSvgTag({ scalable: true, margin: 2 });
    } catch {
      return null;
    }
  }, [value]);
  if (!svg) return null;
  return <div className="qr" role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} />;
}
