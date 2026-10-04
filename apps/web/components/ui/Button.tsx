import type { ButtonHTMLAttributes } from 'react';

import { cn } from '@/lib/ui/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANT_CLASSES: Record<Variant, string> = {
  primary: 'bg-slate-800 text-slate-100 border border-slate-700 hover:bg-slate-700',
  secondary: 'bg-transparent text-slate-300 border border-slate-700 hover:bg-slate-800',
  ghost: 'bg-transparent text-slate-300 hover:bg-slate-800',
  danger: 'bg-status-critical/10 text-status-critical border border-status-critical/40 hover:bg-status-critical/20',
};

export function Button({
  variant = 'primary',
  className,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        'rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        VARIANT_CLASSES[variant],
        className
      )}
      {...props}
    />
  );
}
