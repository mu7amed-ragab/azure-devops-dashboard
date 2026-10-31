import { useTranslation } from '../lib/i18n';

export interface FilterOption {
  id: string;
  label: string;
  count: number;
}

interface FilterChipsProps {
  options: FilterOption[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onClear: () => void;
  allCount: number;
  allLabel?: string;
}

/** Extracted from the Stories page's original inline chip row — same
 * classes, same `aria-pressed` convention, same "empty selection means
 * All" contract. Kept intentionally dumb: no keyboard nav beyond native Tab
 * order, no icons, one selection Set shared by every consumer. */
export function FilterChips({ options, selected, onToggle, onClear, allCount, allLabel }: FilterChipsProps) {
  const t = useTranslation();
  const resolvedAllLabel = allLabel ?? t('common.all');
  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        type="button"
        onClick={onClear}
        aria-pressed={selected.size === 0}
        className={`focus-ring cursor-pointer rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
          selected.size === 0 ? 'bg-accent/15 text-accent' : 'bg-surface-sunken text-ink-muted hover:text-ink'
        }`}
      >
        {resolvedAllLabel} ({allCount})
      </button>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onToggle(option.id)}
          aria-pressed={selected.has(option.id)}
          className={`focus-ring cursor-pointer rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
            selected.has(option.id) ? 'bg-accent/15 text-accent' : 'bg-surface-sunken text-ink-muted hover:text-ink'
          }`}
        >
          {option.label} ({option.count})
        </button>
      ))}
    </div>
  );
}
