import { ExternalLink, GitPullRequest } from 'lucide-react';
import type { LinkedItem, PullRequest } from '../lib/types';
import { formatDate } from '../lib/format';
import { useLang } from '../lib/i18n/useLang';
import { t } from '../lib/i18n';
import { prStatusId, type PrStatusId } from '../lib/prStatus';
import { Pill, type PillTone } from './ui/Pill';
import { Foreign } from './ui/Foreign';

// Keyed by the same PrStatusId the filter chips use — NOT the raw ADO
// `pr.status` string. A PR can be both a draft and abandoned at once
// (isDraft: true, status: 'abandoned'); prStatusId buckets that under
// "draft" for filtering, so the badge must follow the same rule or a PR
// shown under the Draft filter would display an "abandoned" pill instead.
// Same semantic tones as StateChip's Active/New/Closed/Blocked — resolves
// the -600-vs-StateChip's-700 split the audit flagged, since both now read
// from the same --info/--success/--danger tokens.
const STATUS_TONES: Record<PrStatusId, PillTone> = {
  active: 'info',
  draft: 'neutral',
  completed: 'success',
  abandoned: 'danger',
};

function voteLabel(vote: number): string {
  if (vote >= 10) return t('prRow.voteApproved');
  if (vote >= 5) return t('prRow.voteApprovedWithSuggestions');
  if (vote <= -10) return t('prRow.voteRejected');
  if (vote <= -5) return t('prRow.voteWaiting');
  return t('prRow.voteNone');
}

export function PRRow({ pr, linkedItems }: { pr: PullRequest; linkedItems?: LinkedItem[] }) {
  useLang((s) => s.lang); // subscribe so formatDate() below re-renders on language switch
  const statusId = prStatusId(pr);
  return (
    <a
      href={pr.url ?? undefined}
      target="_blank"
      rel="noreferrer"
      className="focus-ring flex flex-col gap-1.5 rounded-card border border-border bg-surface px-3 py-2.5 transition-colors hover:border-accent/50"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-ink">
          <GitPullRequest size={14} className="shrink-0 text-ink-subtle" />
          <span className="shrink-0 tabular-nums text-ink-subtle">#{pr.id}</span>
          <Foreign as="span" className="truncate text-start">{pr.title}</Foreign>
        </div>
        <Pill tone={STATUS_TONES[statusId]}>{t(`pr.status.${statusId}`)}</Pill>
      </div>
      {linkedItems && linkedItems.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {linkedItems.map((item) => (
            <span key={item.id} className="rounded bg-surface-sunken px-1.5 py-0.5 text-xs font-medium text-ink-muted">
              #{item.id} · <Foreign as="span" knownLang="en">{item.type}</Foreign>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
        <Foreign as="span">{pr.repository ?? t('prRow.unknownRepo')}</Foreign>
        <span>{t('prRow.created', { date: formatDate(pr.createdDate) })}</span>
        {pr.closedDate && statusId === 'completed' && <span>{t('prRow.merged', { date: formatDate(pr.closedDate) })}</span>}
        {pr.closedDate && statusId === 'abandoned' && <span>{t('prRow.abandoned', { date: formatDate(pr.closedDate) })}</span>}
        {pr.reviewers.length > 0 && (
          <span>
            {t('prRow.reviewers', { list: pr.reviewers.map((r) => `${r.name} (${voteLabel(r.vote)})`).join(', ') })}
          </span>
        )}
        <ExternalLink size={12} className="ms-auto shrink-0" />
      </div>
    </a>
  );
}

