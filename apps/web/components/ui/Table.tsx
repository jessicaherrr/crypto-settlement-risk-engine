import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';

import { cn } from '@/lib/ui/cn';

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto">
      <table className={cn('w-full text-left text-sm', className)} {...props} />
    </div>
  );
}

export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn('border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500', className)}
      {...props}
    />
  );
}

export function TBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('divide-y divide-slate-800/60', className)} {...props} />;
}

export function TR({
  className,
  highlighted,
  ...props
}: HTMLAttributes<HTMLTableRowElement> & { highlighted?: boolean }) {
  return <tr className={cn(highlighted && 'bg-slate-800/40', className)} {...props} />;
}

export function TH({
  className,
  numeric,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return <th className={cn('px-4 py-2 font-medium', numeric && 'text-right', className)} {...props} />;
}

export function TD({
  className,
  numeric,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td
      className={cn('px-4 py-2.5 text-slate-200', numeric && 'text-right font-mono tabular-nums', className)}
      {...props}
    />
  );
}
