import type { ButtonHTMLAttributes } from 'react';

/** The app's one filled-accent button — unifies 3 previously-identical
 * copies plus .sr-only-focusable, and adds the hover state all 3 lacked. */
export function PrimaryButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`focus-ring cursor-pointer rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-default disabled:opacity-40 ${className}`}
      {...props}
    />
  );
}
