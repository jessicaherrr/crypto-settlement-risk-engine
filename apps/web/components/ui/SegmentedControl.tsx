'use client';

import { cn } from '@/lib/ui/cn';

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: ReadonlyArray<{ label: string; value: T }>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('inline-flex rounded-md border border-slate-800 bg-slate-900 p-0.5', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={cn(
            'rounded px-3 py-1 text-sm font-medium transition-colors',
            value === option.value ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
