import 'react';

// A value computed from data reaches CSS as a custom property: style={{ '--size': '28px' }}.
declare module 'react' {
  interface CSSProperties {
    [property: `--${string}`]: string | number | undefined;
  }
}
