import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { Search, X } from 'lucide-react';
import { t } from '../../lib/i18n';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Absorbs the only real difference between the two previous byte-identical
   * copies (220px on Work Items, 280px on Pull Requests). */
  maxWidth?: number;
  inputMode?: 'text' | 'numeric';
  id?: string;
  /** Spread onto the <input> — combobox callers (AddPersonForm's directory
   * search) need aria-expanded/aria-controls/aria-activedescendant here. */
  inputProps?: InputHTMLAttributes<HTMLInputElement>;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { value, onChange, placeholder, maxWidth = 220, inputMode = 'text', id, inputProps },
  ref
) {
  return (
    <div className="relative w-full" style={{ maxWidth }}>
      <Search size={14} className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
      <input
        ref={ref}
        id={id}
        type="text"
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className="focus-ring w-full rounded-full border border-border bg-surface-sunken py-1.5 ps-8 pe-7 text-xs text-ink focus-visible:border-accent"
        {...inputProps}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="focus-ring absolute end-2 top-1/2 -translate-y-1/2 cursor-pointer rounded text-ink-subtle transition-colors hover:text-ink"
          aria-label={t('common.clearSearchAriaLabel')}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
});
