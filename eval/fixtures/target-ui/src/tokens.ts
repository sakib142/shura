/**
 * Design tokens.
 *
 * Components read from here rather than hard-coding values, so a change in the
 * design system is one edit. An agent that writes a raw hex or pixel value into
 * a component has gone around this, and the reviewer is told to say so.
 */

export const tokens = {
  color: {
    text: '#1a1a1a',
    textMuted: '#6b6b6b',
    surface: '#ffffff',
    border: '#e4e4e7',
    accent: '#2563eb',
    danger: '#dc2626',
  },
  space: { xs: '4px', sm: '8px', md: '16px', lg: '24px', xl: '32px' },
  radius: { sm: '4px', md: '8px' },
  font: {
    body: '14px',
    heading: '20px',
    weightRegular: 400,
    weightBold: 600,
  },
} as const;
