import { useEffect, useId, useRef, useState } from 'react';
import { SearchInput } from '../../../components/ui/SearchInput';
import { searchPeople } from '../../../lib/api';
import type { Person } from '../../../lib/types';
import { labelClass } from './roleRules';
import { useTranslation } from '../../../lib/i18n';
import { Foreign } from '../../../components/ui/Foreign';

interface PersonComboboxProps {
  label: string;
  onPick: (person: Person) => void;
}

/** Directory search with real combobox semantics: role="combobox" on the
 * input, role="listbox"/"option" results, aria-activedescendant tracking,
 * and arrow-key navigation — the previous version was a plain input plus an
 * unstyled results list with no keyboard support. Debounced (250ms) with a
 * request-sequence guard so a fast typist can't have an earlier, slower
 * response overwrite a later one. */
export function PersonCombobox({ label, onPick }: PersonComboboxProps) {
  const t = useTranslation();
  const formId = useId();
  const listboxId = `${formId}-listbox`;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Person[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const requestSeq = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    const seq = ++requestSeq.current;
    debounceRef.current = setTimeout(async () => {
      try {
        const people = await searchPeople(query);
        if (seq !== requestSeq.current) return; // a newer keystroke already superseded this
        setResults(people);
        setOpen(people.length > 0);
        setActiveIndex(-1);
      } catch {
        if (seq !== requestSeq.current) return;
        setResults([]);
        setOpen(false);
      }
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  function pick(person: Person) {
    onPick(person);
    setQuery('');
    setResults([]);
    setOpen(false);
    setActiveIndex(-1);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      pick(results[activeIndex]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActiveIndex(-1);
    }
  }

  return (
    <div>
      <label htmlFor={`${formId}-search`} className={labelClass}>
        {label}
      </label>
      <div role="combobox" aria-expanded={open} aria-haspopup="listbox" aria-owns={listboxId} aria-controls={listboxId}>
        <SearchInput
          id={`${formId}-search`}
          value={query}
          onChange={setQuery}
          placeholder={t('team.searchDirectoryPlaceholder')}
          maxWidth={280}
          inputProps={{
            role: 'textbox',
            'aria-autocomplete': 'list',
            'aria-controls': listboxId,
            'aria-activedescendant': activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined,
            onKeyDown: handleKeyDown,
            onFocus: () => results.length > 0 && setOpen(true),
          }}
        />
      </div>
      {open && (
        <ul id={listboxId} role="listbox" aria-label={t('team.searchResultsAriaLabel')} className="mt-1 max-h-32 overflow-y-auto rounded-md border border-border bg-surface text-xs">
          {results.map((p, i) => (
            <li key={p.id} id={`${listboxId}-${i}`} role="option" aria-selected={i === activeIndex}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(p)}
                onMouseEnter={() => setActiveIndex(i)}
                className={`focus-ring block w-full cursor-pointer px-2 py-1.5 text-start ${i === activeIndex ? 'bg-surface-sunken' : 'hover:bg-surface-sunken'}`}
              >
                <Foreign as="span">{p.displayName}</Foreign>
                {p.uniqueName && <span className="ms-1 text-ink-subtle">(<Foreign as="span">{p.uniqueName}</Foreign>)</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

