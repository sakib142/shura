import type { CSSProperties, ReactNode } from 'react';
import { tokens } from '../tokens.js';

export interface ButtonProps {
  readonly children: ReactNode;
  readonly onClick?: () => void;
  readonly variant?: 'primary' | 'secondary';
  readonly disabled?: boolean;
}

export function Button({ children, onClick, variant = 'primary', disabled = false }: ButtonProps) {
  const style: CSSProperties = {
    padding: `${tokens.space.sm} ${tokens.space.md}`,
    borderRadius: tokens.radius.sm,
    fontSize: tokens.font.body,
    fontWeight: tokens.font.weightBold,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    border: variant === 'primary' ? 'none' : `1px solid ${tokens.color.border}`,
    background: variant === 'primary' ? tokens.color.accent : tokens.color.surface,
    color: variant === 'primary' ? tokens.color.surface : tokens.color.text,
  };
  return (
    <button type="button" style={style} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
