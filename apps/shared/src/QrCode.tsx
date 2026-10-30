import qrcode from 'qrcode-generator';
import { palette } from './styles';

/** A QR code, drawn as one SVG path, dark on light whatever the theme so every camera reads it */
export function QrCode({ text, label, size = 148 }: { text: string; label: string; size?: number }) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  let path = '';
  for (let row = 0; row < count; row++)
    for (let col = 0; col < count; col++) if (qr.isDark(row, col)) path += `M${col + 2} ${row + 2}h1v1h-1z`;
  const side = count + 4;
  return (
    <svg viewBox={`0 0 ${side} ${side}`} width={size} height={size} role="img" aria-label={label}>
      {/* A camera wants the strongest contrast there is: white and navy. */}
      <rect width={side} height={side} fill={palette.ink.inverse} />
      <path d={path} fill={palette.ink.strong} shapeRendering="crispEdges" />
    </svg>
  );
}
