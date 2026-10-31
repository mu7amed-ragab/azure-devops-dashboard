import { Check, ChevronDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { usePopover } from '../lib/usePopover';
import { PopoverPanel } from './ui/Popover';
import { useTranslation } from '../lib/i18n';

export interface MenuOption {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onToggle: () => void;
}

/** A labeled group of options with its own "Select all" toggle — e.g. one
 * team's roster on the Team page's "Show members" menu, so a Scrum account
 * can pick a whole team in one click alongside individual people. */
export interface MenuSection {
  id: string;
  label: string;
  options: MenuOption[];
  allSelected: boolean;
  onSelectAll: () => void;
}

interface MenuProps {
  label: string;
  icon?: LucideIcon;
  options?: MenuOption[];
  sections?: MenuSection[];
}

/** Minimal dropdown for a list of togglable options — built for the Stories
 * page's View menu. Deliberately small: no Escape handling, no roving
 * focus, no arrow/Home/End navigation. Options are plain buttons with
 * `aria-pressed` (the same toggle convention the status chips already use)
 * rather than `role="menu"`/`menuitemcheckbox`, since those roles promise
 * arrow-key navigation this version doesn't implement — add both together
 * later if a menu grows enough to need it. Pass either a flat `options`
 * list or `sections` (grouped options plus a per-group "Select all") —
 * never both. */
export function Menu({ label, icon: Icon, options, sections }: MenuProps) {
  const t = useTranslation();
  const { open, setOpen, rootRef } = usePopover<HTMLDivElement>();

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="focus-ring flex cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:text-ink"
      >
        {Icon && <Icon size={14} />}
        {label}
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <PopoverPanel className="w-64 p-1">
          {sections
            ? sections.map((section, i) => (
                <div key={section.id} className={i > 0 ? 'mt-1 border-t border-border pt-1' : undefined}>
                  <div className="flex items-center justify-between px-2 py-1">
                    <span className="text-xs font-semibold text-ink-subtle">{section.label}</span>
                    <button
                      type="button"
                      onClick={section.onSelectAll}
                      className="focus-ring cursor-pointer rounded px-1.5 py-0.5 text-[11px] font-medium text-accent hover:underline"
                    >
                      {section.allSelected ? t('common.clear') : t('workitems.selectAll')}
                    </button>
                  </div>
                  {section.options.map((option) => (
                    <MenuOptionButton key={option.id} option={option} />
                  ))}
                </div>
              ))
            : (options ?? []).map((option) => <MenuOptionButton key={option.id} option={option} />)}
        </PopoverPanel>
      )}
    </div>
  );
}

function MenuOptionButton({ option }: { option: MenuOption }) {
  return (
    <button
      type="button"
      aria-pressed={option.checked}
      onClick={option.onToggle}
      className="focus-ring flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-start text-xs text-ink transition-colors hover:bg-surface-sunken"
    >
      <span className="mt-0.5 flex w-3.5 shrink-0 items-center justify-center">
        {option.checked && <Check size={14} className="text-accent" />}
      </span>
      <span>
        <span className="block font-medium">{option.label}</span>
        {option.description && <span className="block text-xs text-ink-subtle">{option.description}</span>}
      </span>
    </button>
  );
}

