import { ChevronDown } from 'lucide-react';
import { useStates } from '../lib/useStates';
import { usePopover } from '../lib/usePopover';
import { Pill, type PillTone } from './ui/Pill';
import { PopoverPanel } from './ui/Popover';
import { useTranslation } from '../lib/i18n';

// Mapped to a semantic or workflow-stage token, keyed by state name (not the
// server's stateCategory — that would be a logic change, out of scope here).
// New = neutral, PO/EA Approved = intake/approved stages, Active = info,
// OnHold = warning, the two Ready-For-Test states = review/staging stages,
// Deployed/Closed = success, Resolved = review, Blocked = danger.
const STATE_TONES: Record<string, PillTone> = {
  New: 'neutral',
  'PO Approved': 'intake',
  'EA Approved': 'approved',
  Active: 'info',
  OnHold: 'warning',
  'Ready For Test (Demo)': 'review',
  'Ready For Test (Stage)': 'staging',
  'Deployed To Production': 'success',
  Resolved: 'review',
  Closed: 'success',
  Blocked: 'danger',
};

// Case-insensitive lookup — this project's real "blocked" workflow state is
// lowercase (unlike this table's Title Case keys), and state names otherwise
// come straight from ADO with whatever casing that process template used.
const STATE_TONES_LOWER: Record<string, PillTone> = Object.fromEntries(
  Object.entries(STATE_TONES).map(([k, v]) => [k.toLowerCase(), v])
);

function stateTone(state: string): PillTone {
  return STATE_TONES_LOWER[state.toLowerCase()] ?? 'neutral';
}

interface StateChipProps {
  state: string;
  /** Work item type — required to look up the real state list and enable
   * the dropdown. Omitted (or editable=false) renders the plain read-only
   * chip, same as before. */
  type?: string;
  editable?: boolean;
  pending?: boolean;
  onChange?: (newState: string) => void;
}

export function StateChip({ state, type, editable, pending, onChange }: StateChipProps) {
  const t = useTranslation();
  const { open, setOpen, rootRef } = usePopover<HTMLDivElement>();
  const { data: states } = useStates();

  const tone = stateTone(state);
  const options = type ? states?.[type] ?? [] : [];

  if (!editable || !type) {
    return <Pill tone={tone}>{state}</Pill>;
  }

  return (
    <div className="relative shrink-0" ref={rootRef}>
      {/* interactive (py-1 vs. the read-only chip's py-0.5) brings the tap
       * target to ~24px tall, the WCAG 2.2 AA floor for pointer targets on
       * desktop web — the icon/text stay the same visual size. */}
      <button
        type="button"
        disabled={pending}
        aria-label={t('stateChip.changeStateAriaLabel', { state })}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="focus-ring shrink-0 cursor-pointer rounded-full disabled:cursor-default disabled:opacity-40"
      >
        <Pill tone={tone} interactive className="gap-0.5">
          {state}
          <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </Pill>
      </button>

      {open && options.length > 0 && (
        <PopoverPanel
          className="max-h-64 w-52 overflow-y-auto p-1"
          role="listbox"
          onClick={(e) => e.stopPropagation()}
        >
          {options.map((s) => (
            <button
              key={s.name}
              type="button"
              role="option"
              aria-selected={s.name === state}
              onClick={() => {
                setOpen(false);
                if (s.name !== state) onChange?.(s.name);
              }}
              className={`focus-ring flex w-full cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-start text-xs ${
                s.name === state ? 'bg-accent/15 text-accent font-medium' : 'text-ink hover:bg-surface-sunken'
              }`}
            >
              <span>{s.name}</span>
              <span className="text-xs text-ink-subtle">{s.category}</span>
            </button>
          ))}
        </PopoverPanel>
      )}
    </div>
  );
}

