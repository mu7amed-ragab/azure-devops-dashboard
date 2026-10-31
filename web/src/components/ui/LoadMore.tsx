import { ChevronDown, Loader2 } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';

interface LoadMoreProps {
  shown: number;
  total: number;
  onClick: () => void;
  /** True while the next page is already in flight — disables the button
   * and swaps the chevron for a spinner, so clicking doesn't look inert
   * (and can't be double-clicked into two overlapping requests) while the
   * next page's request (`PrRepoList`'s `query.isFetchingNextPage`) is
   * still pending. */
  isLoading?: boolean;
}

/** "N of M · Load more" button for a paged or truncated list. On the Pull
 * Requests page (`PrRepoList`'s `RepoGroupSection`) this fetches a real
 * next page from GET /api/pullrequests via `useInfiniteQuery`; on a
 * `StoryCard`'s PR list it just widens a render limit over PRs already in
 * hand — that call site never passes `isLoading`, since it has nothing to
 * wait on. */
export function LoadMore({ shown, total, onClick, isLoading }: LoadMoreProps) {
  const t = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isLoading}
      className="focus-ring flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-card border border-dashed border-border py-2 text-xs font-medium text-ink-subtle transition-colors hover:bg-surface-sunken hover:text-ink disabled:cursor-default disabled:opacity-60"
    >
      {isLoading ? <Loader2 size={14} className="animate-spin" /> : <ChevronDown size={14} />}
      <span>{isLoading ? t('common.loading') : t('common.loadMore', { shown, total })}</span>
    </button>
  );
}
