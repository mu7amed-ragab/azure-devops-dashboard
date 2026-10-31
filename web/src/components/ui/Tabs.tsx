import { useRef } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface TabOption<T extends string> {
  id: T;
  label: string;
  icon?: LucideIcon;
}

interface TabsProps<T extends string> {
  options: TabOption<T>[];
  value: T;
  onChange: (id: T) => void;
  'aria-label': string;
  /** Centers the tablist within its container — the default, matching every
   * existing call site. Set false to left-align it inline alongside other
   * toolbar controls (see manage/TeamDetailView.tsx's List/Hierarchy switch). */
  centered?: boolean;
  className?: string;
}

/** The same pill-nav idiom as the app shell's own route nav (Layout.tsx) —
 * `rounded-full`, icon + label, active = `bg-accent/15 text-accent` — but
 * for switching between panels within a page instead of routes, with proper
 * `role="tablist"`/`aria-selected` semantics and arrow-key roving focus
 * (the nav gets that for free from being plain links; a tablist has to
 * implement it itself per the ARIA authoring practice). */
export function Tabs<T extends string>({ options, value, onChange, centered = true, className = '', ...rest }: TabsProps<T>) {
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const delta = e.key === 'ArrowRight' ? 1 : -1;
    const next = (index + delta + options.length) % options.length;
    buttonRefs.current[next]?.focus();
    onChange(options[next].id);
  }

  return (
    <div
      role="tablist"
      aria-label={rest['aria-label']}
      className={`flex w-fit max-w-full items-center gap-1 overflow-x-auto rounded-full border border-border bg-surface-sunken p-1 ${
        centered ? 'mx-auto' : ''
      } ${className}`}
    >
      {options.map((option, index) => {
        const Icon = option.icon;
        const isActive = value === option.id;
        return (
          <button
            key={option.id}
            ref={(el) => { buttonRefs.current[index] = el; }}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(option.id)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={`focus-ring flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              isActive ? 'bg-accent/15 text-accent' : 'text-ink-muted hover:bg-surface-raised hover:text-ink'
            }`}
          >
            {Icon && <Icon size={14} />}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
