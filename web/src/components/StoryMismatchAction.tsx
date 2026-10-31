import { useState } from 'react';
import type { BulkIterationWriteResult } from '../lib/types';
import { sprintLabel } from '../lib/sprintMismatch';
import { usePopover } from '../lib/usePopover';
import { PopoverPanel } from './ui/Popover';
import { PrimaryButton } from './ui/PrimaryButton';
import { InlineMessage } from './ui/InlineMessage';
import { useTranslation } from '../lib/i18n';
import { describeError, type ErrorDisplay } from '../lib/errorDisplay';
import { Foreign } from './ui/Foreign';

interface StoryMismatchActionProps {
  mismatchCount: number;
  targetIterationPath: string | null;
  /** Read-only on a teammate's dashboard, same rule as the per-task chip. */
  editable: boolean;
  onMoveAll: () => Promise<BulkIterationWriteResult>;
}

/** The story-metadata-row counterpart to SprintMismatchChip — moves every
 * one of the story's mismatched children (that the caller owns) in one
 * request instead of clicking each task's chip individually. Unmounts
 * itself naturally once the caller's `mismatchCount > 0` gate goes false
 * (every child moved successfully); on a partial failure it stays mounted
 * and lists what didn't move. */
export function StoryMismatchAction({ mismatchCount, targetIterationPath, editable, onMoveAll }: StoryMismatchActionProps) {
  const t = useTranslation();
  const { open, setOpen, rootRef } = usePopover<HTMLDivElement>();
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [failed, setFailed] = useState<BulkIterationWriteResult['failed']>([]);

  const targetLabel = sprintLabel(targetIterationPath);
  const label = t('storyMismatch.onAnotherSprint', { count: mismatchCount });

  if (!editable) {
    return <span className="text-warning">{label}</span>;
  }

  async function handleMoveAll() {
    if (moving) return;
    setMoving(true);
    setError(null);
    setFailed([]);
    try {
      const result = await onMoveAll();
      if (result.failed.length > 0) {
        setFailed(result.failed);
      } else {
        setOpen(false);
      }
    } catch (err) {
      setError(describeError(err, t('storyMismatch.networkError')));
    } finally {
      setMoving(false);
    }
  }

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="focus-ring cursor-pointer text-warning underline decoration-dotted transition-colors hover:text-warning/80"
      >
        {label}
      </button>

      {open && (
        <PopoverPanel align="left" role="dialog" className="w-64 space-y-2 p-2.5" onClick={(e) => e.stopPropagation()}>
          <p className="text-xs text-ink">
            {t('storyMismatch.tasksOnEarlierSprint', { count: mismatchCount })}
          </p>
          <PrimaryButton onClick={handleMoveAll} disabled={moving} className="w-full">
            {moving ? t('common.moving') : (
              <>
                {t('storyMismatch.moveAllToPrefix', { count: mismatchCount })} <Foreign as="span">{targetLabel}</Foreign>
              </>
            )}
          </PrimaryButton>
          {error && <InlineMessage tone="error" detail={error.detail}>{error.message}</InlineMessage>}
          {failed.length > 0 && (
            <InlineMessage tone="error">
              {t('storyMismatch.didNotMove', { count: failed.length, ids: failed.map((f) => `#${f.id}`).join(', ') })}
            </InlineMessage>
          )}
        </PopoverPanel>
      )}
    </div>
  );
}
