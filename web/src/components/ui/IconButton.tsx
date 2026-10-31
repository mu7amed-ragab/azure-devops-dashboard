import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  'aria-label': string;
  children: ReactNode;
}

/** 24px (h-6 w-6) square icon-only button — the WCAG 2.2 AA pointer-target
 * floor — with one shared hover idiom, replacing 9 divergent icon-only
 * buttons that each invented their own size/hover. `aria-label` is required
 * on the type, not just by convention. */
export function IconButton({ className = '', children, ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`focus-ring flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-sunken hover:text-ink disabled:cursor-default disabled:opacity-40 ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
