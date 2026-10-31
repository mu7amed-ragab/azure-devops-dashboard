import { clampPct } from '../lib/format';

interface ProgressBarProps {
  pct: number;
  tone?: 'accent' | 'success' | 'warn';
  size?: 'sm' | 'md';
}

// warn measured 1.96:1 against the sunken track in light mode — the same
// amber-500-on-near-white problem as the type bar (typeTheme.ts). --warning
// already carries the darker light-mode shade with its dark-mode swap baked
// in, so this needs no separate dark: variant.
const TONE_CLASSES = {
  accent: 'bg-accent',
  success: 'bg-success-tint',
  warn: 'bg-warning',
};

export function ProgressBar({ pct, tone = 'accent', size = 'md' }: ProgressBarProps) {
  const clamped = clampPct(pct);
  return (
    <div
      className={`w-full overflow-hidden rounded-full bg-surface-sunken ${size === 'sm' ? 'h-1.5' : 'h-2'}`}
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-300 ${TONE_CLASSES[tone]}`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
