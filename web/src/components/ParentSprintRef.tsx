import { Link } from 'lucide-react';
import type { ParentRef } from '../lib/types';
import { sprintLabel } from '../lib/sprintMismatch';
import { workItemUrl } from '../lib/adoLinks';
import { useTranslation } from '../lib/i18n';
import { Foreign } from './ui/Foreign';

interface ParentSprintRefProps {
  parentRef: ParentRef;
  org: string;
  /** The parent's own project — always known here: a cross-sprint promotion
   * only ever names a parent hydrated within this same project's sync pass,
   * and a past-owned search result's parent was re-checked for
   * System.TeamProject before it reached the client (data-model.md §6.6). */
  project: string;
}

/** A meta-row line naming the parent a card isn't shown under — mirrors
 * SprintMismatchChip's read-only branch (Pill + Foreign + a 12px icon), used
 * on a cross-sprint-promoted card (contracts/dashboard-payload.md) and on a
 * past-owned search result (data-model.md §4). Read-only: no move action
 * lives here — SprintMismatchChip's move action on the NESTED rendering is
 * the only place scheduling can change. */
export function ParentSprintRef({ parentRef, org, project }: ParentSprintRefProps) {
  const t = useTranslation();
  return (
    <a
      href={workItemUrl(org, project, parentRef.id)}
      target="_blank"
      rel="noreferrer"
      className="focus-ring group flex min-w-0 items-center gap-1.5 text-xs text-ink-subtle transition-colors hover:text-accent"
    >
      <Link size={12} className="shrink-0" />
      {/* The translated "Parent:" label and the ADO-sourced id/title/sprint
       * are kept in separate spans on purpose (FR-021): only the latter is
       * ADO-verbatim, so only it gets dir="auto"/lang="en" via <Foreign>. */}
      <span className="shrink-0">{t('parentRef.prefix')}</span>
      <Foreign as="span" className="truncate">
        #{parentRef.id} {parentRef.title} · {sprintLabel(parentRef.iterationPath)}
      </Foreign>
    </a>
  );
}
