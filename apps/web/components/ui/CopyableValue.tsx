'use client';

import { useState } from 'react';

/** A truncated hash/address with a click-to-copy affordance - the full
 * value is always in the title attribute and in the copied clipboard
 * text, never just the truncated display text. */
export function CopyableValue({ value, display }: { value: string; display?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard access denied - nothing to recover, value is still visible/selectable
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={value}
      className="inline-flex items-center gap-1 rounded font-mono text-xs text-slate-300 hover:text-slate-100"
    >
      {display ?? value}
      <span className="text-slate-500">{copied ? '✓' : '⎘'}</span>
    </button>
  );
}
