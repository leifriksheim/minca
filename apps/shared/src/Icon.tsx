import { createElement } from 'react';
import { ICONS, ICON_SVG, type IconName } from '@minca/ui/icons';

export type { IconName };

/** An action icon (@minca/ui/icons), in the colour of the text around it */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg {...ICON_SVG} width={size} height={size}>
      {ICONS[name].map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}
