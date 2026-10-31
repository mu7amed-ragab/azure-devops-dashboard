import type { PullRequest } from './types';

export type PrStatusId = 'active' | 'draft' | 'completed' | 'abandoned';

/** No `label` here on purpose — callers translate each id via
 * `t('pr.status.' + id)` so the chip text stays in the active language. */
export const PR_STATUS_OPTIONS: { id: PrStatusId }[] = [
  { id: 'active' },
  { id: 'draft' },
  { id: 'completed' },
  { id: 'abandoned' },
];

/** Exactly one bucket per PR, so chip counts partition the total instead of
 * overlapping. `isDraft` is checked first because Azure DevOps has no
 * separate "draft" status — a draft PR is always also `status: 'active'`,
 * so without this a draft would double-count under Active too. There is no
 * "merged" bucket: verified against live data that every `completed` PR
 * has a merge commit and no non-completed PR does, so "merged" would just
 * be a duplicate of "completed". */
export function prStatusId(pr: PullRequest): PrStatusId {
  if (pr.isDraft) return 'draft';
  if (pr.status === 'completed') return 'completed';
  if (pr.status === 'abandoned') return 'abandoned';
  return 'active';
}
