import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { sprintLabel } from '../lib/sprintMismatch';
import { usePopover } from '../lib/usePopover';
import { PopoverPanel } from './ui/Popover';
import { PrimaryButton } from './ui/PrimaryButton';
import { InlineMessage } from './ui/InlineMessage';
import { useTranslation } from '../lib/i18n';
import { describeError, type ErrorDisplay } from '../lib/errorDisplay';
import { Foreign } from './ui/Foreign';

interface SprintMismatchChipProps {
  taskIterationPath: string | null;
  parentIterationPath: string | null;
  /** Read-only on a teammate's dashboard, same rule as StateChip/the pencil. */
  editable: boolean;
  pending?: boolean;
  onMove: () => Promise<void>;
}

/** A full-width warning line in the card's meta row — moved out of the
 * title row's control cluster (where a long sprint name used to crowd the
 * item title) and given the same treatment as StoryMismatchAction, the
 * story-level counterpart: plain warning-toned text/link, no pill
 * background, confirmed via a popover before writing. */
export function SprintMismatchChip({ taskIterationPath, parentIterationPath, editable, pending, onMove }: SprintMismatchChipProps) {
  const t = useTranslation();
  const { open, setOpen, rootRef } = usePopover<HTMLDivElement>();
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<ErrorDisplay | null>(null);

  const taskLabel = sprintLabel(taskIterationPath);
  const parentLabel = sprintLabel(parentIterationPath);

  async function handleMove() {
    if (moving) return;
    setMoving(true);
    setError(null);
    try {
      await onMove();
      setOpen(false);
    } catch (err) {
      setError(describeError(err, t('sprintMismatch.networkError')));
    } finally {
      setMoving(false);
    }
  }

  if (!editable) {
    return (
      <span className="flex items-center gap-1.5 text-warning" title={t('sprintMismatch.stillOnTitle', { task: taskLabel, parent: parentLabel })}>
        <CalendarClock size={12} className="shrink-0" />
        {/* Visible text splits the translated label from the ADO-sourced
         * sprint name (FR-021) — the `title` attribute above can't carry
         * <Foreign>'s dir/lang markup, so it stays a plain interpolated
         * string; that's a native-attribute limitation, not an oversight. */}
        {t('sprintMismatch.stillOnPrefix')} <Foreign as="span">{taskLabel}</Foreign>
      </span>
    );
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        disabled={pending}
        aria-label={t('sprintMismatch.moveAriaLabel', { task: taskLabel, parent: parentLabel })}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="focus-ring flex cursor-pointer items-center gap-1.5 rounded text-warning underline decoration-dotted transition-colors hover:text-warning/80 disabled:cursor-default disabled:opacity-40"
      >
        <CalendarClock size={12} className="shrink-0" />
        {t('sprintMismatch.stillOnPrefix')} <Foreign as="span">{taskLabel}</Foreign> ·{' '}
        {t('sprintMismatch.moveToPrefix')} <Foreign as="span">{parentLabel}</Foreign>
      </button>

      {open && (
        <PopoverPanel align="left" role="dialog" className="w-56 space-y-2 p-2.5" onClick={(e) => e.stopPropagation()}>
          <p className="text-xs text-ink">
            {t('sprintMismatch.stillOnPrefix')} <Foreign as="span">{taskLabel}</Foreign>
          </p>
          <PrimaryButton onClick={handleMove} disabled={moving} className="w-full">
            {moving ? t('common.moving') : (
              <>
                {t('sprintMismatch.moveToPrefix')} <Foreign as="span">{parentLabel}</Foreign>
              </>
            )}
          </PrimaryButton>
          {error && <InlineMessage tone="error" detail={error.detail}>{error.message}</InlineMessage>}
        </PopoverPanel>
      )}
    </div>
  );
}
