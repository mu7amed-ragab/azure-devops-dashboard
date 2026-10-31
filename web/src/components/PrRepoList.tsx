import { useEffect, useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ChevronRight, ExternalLink } from 'lucide-react';
import { useTranslation } from '../lib/i18n';
import { DirectionalIcon } from './ui/DirectionalIcon';
import { fetchPrPage, fetchPrRepoMatches } from '../lib/api';
import { PRRow } from './PRRow';
import { StateChip } from './StateChip';
import { EmptyView, InlineSpinner } from './StatusView';
import { SyncProgressNotice } from './SyncProgressNotice';
import { AccentBar } from './ui/AccentBar';
import { Pill } from './ui/Pill';
import { LoadMore } from './ui/LoadMore';
import { Foreign } from './ui/Foreign';
import { workItemUrl } from '../lib/adoLinks';
import { usePersistedState } from '../lib/persistedState';
import { projectQueryKey } from '../lib/activeProject';
import { PR_PAGE_SIZE, mergePrPages } from '../lib/prPaging';
import type { PrRepoMatch, PrRepoSummary, PrStoryBlock } from '../lib/types';
import { typeTheme } from '../lib/typeTheme';

const DEFAULT_AUTO_EXPAND_CAP = 6;

function StoryBlock({ story, org }: { story: PrStoryBlock; org: string }) {
  const theme = typeTheme(story.type);
  return (
    <div className={`relative space-y-2 rounded-card border ${theme.border} ${theme.tint} ps-4 pe-3 py-3`} title={story.type}>
      <AccentBar tone={theme.accentTone} />
      <div className="flex items-center gap-2 text-xs text-ink-subtle">
        <a
          href={workItemUrl(org, null, story.id)}
          target="_blank"
          rel="noreferrer"
          className="focus-ring flex items-center gap-1 rounded tabular-nums underline decoration-dotted transition-colors hover:text-accent"
        >
          #{story.id}
          <ExternalLink size={12} />
        </a>
        <StateChip state={story.state} />
      </div>
      <Foreign
        as="a"
        href={workItemUrl(org, null, story.id)}
        target="_blank"
        rel="noreferrer"
        className="focus-ring block truncate rounded text-start text-sm font-semibold text-ink transition-colors hover:text-accent"
      >
        {story.title}
      </Foreign>
      <div className="space-y-2">
        {story.pullRequests.map((pr) => (
          <PRRow key={pr.id} pr={pr} />
        ))}
      </div>
    </div>
  );
}

function RepoGroupSection({
  repo,
  matchCount,
  personId,
  org,
  project,
  status,
  q,
  isFilteredView,
  defaultOpen,
  expandSignal,
  collapseSignal,
}: {
  repo: { repository: string; repositoryId: string | null; projectName: string | null };
  /** The exact filtered count for this repo — from `prRepos` when
   * unfiltered, or GET /api/pullrequests/repos's `matchCount` otherwise.
   * Always exact, never a stale fallback, so a collapsed repo's header
   * never disagrees with what expanding it shows. */
  matchCount: number;
  personId: string | null;
  org: string;
  project: string;
  status: string | null;
  q: string;
  isFilteredView: boolean;
  defaultOpen: boolean;
  expandSignal?: number;
  collapseSignal?: number;
}) {
  const t = useTranslation();
  const repositoryId = repo.repositoryId ?? repo.repository;
  const [open, setOpen] = usePersistedState(`pullrequests:repo:${personId ?? 'self'}:${repositoryId}`, defaultOpen);
  useEffect(() => {
    if (defaultOpen) setOpen(true);
    // A repo that no longer defaults open (its filter cleared away) should
    // fall back to collapsed rather than staying open from a prior search.
    else setOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultOpen]);
  useEffect(() => { if (expandSignal) setOpen(true); }, [expandSignal]);
  useEffect(() => { if (collapseSignal) setOpen(false); }, [collapseSignal]);

  // A new queryKey (status/q change) naturally starts the infinite query
  // fresh from page 0 — no manual "reset the page" bookkeeping needed here.
  const query = useInfiniteQuery(
    projectQueryKey('pe-page', personId, repositoryId, status, q),
    ({ pageParam = 0 }) =>
      fetchPrPage({ personId, repositoryId, offset: pageParam, limit: PR_PAGE_SIZE, status, q }),
    {
      enabled: open,
      getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.offset + lastPage.limit : undefined),
      // A repo whose PR index hasn't synced yet answers 202; a burst of
      // opened sections can also hit the rate limiter (429) — both retry
      // rather than surfacing an error.
      retry: (failureCount, error) =>
        error instanceof Error && (error.message === 'SYNCING' || error.message === 'RATE_LIMITED') && failureCount < 30,
      retryDelay: (attempt) => Math.min(2000 * 2 ** attempt, 15000),
    }
  );

  const pages = useMemo(() => query.data?.pages ?? [], [query.data]);
  const { stories, unattributed } = useMemo(() => mergePrPages(pages), [pages]);
  const lastPage = pages[pages.length - 1];
  const shown = stories.reduce((n, s) => n + s.pullRequests.length, 0) + unattributed.length;
  const isSyncing = query.isError && query.error instanceof Error && query.error.message === 'SYNCING';
  const isRealError = query.isError && !isSyncing;

  return (
    <div className="relative rounded-card border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="focus-ring flex w-full cursor-pointer items-center justify-between gap-3 rounded-card bg-surface-raised px-4 py-3 text-start"
        aria-expanded={open}
      >
        <div className="flex min-w-0 items-center gap-2">
          <DirectionalIcon>
            <ChevronRight size={16} className={`shrink-0 text-ink-subtle transition-transform ${open ? 'rotate-90' : ''}`} />
          </DirectionalIcon>
          <span className="truncate text-sm font-semibold text-ink">{repo.repository}</span>
          {/* Pull requests are the one org-wide view in an otherwise
           * project-scoped app (deliberately — see server/ado/pullrequests.js),
           * so a repo can belong to a project other than the one you signed in
           * to. Naming that project is what keeps the list honest; without it a
           * cross-project repo just looks like an unexplained extra row. Shown
           * only when it differs, so the common case stays quiet. */}
          {repo.projectName && repo.projectName !== project && (
            <Pill tone="neutral" className="shrink-0" title={t('prList.repoLivesIn', { project: repo.projectName })}>
              {repo.projectName}
            </Pill>
          )}
        </div>
        <span className="shrink-0 text-xs text-ink-muted tabular-nums">
          {t('pr.countLabel', { count: matchCount })}
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-border p-3">
          {/* A genuine first sync (202 SYNCING) gets the real phase/percent
           * progress bar; an ordinary fetch — including every search or
           * filter change — just gets a plain "still working" spinner, since
           * there's no meaningful percentage for that. */}
          {isSyncing && <SyncProgressNotice personId={personId} enabled fallbackLabel={t('prList.syncingFallback')} />}
          {query.isLoading && !isSyncing && <InlineSpinner label={t('pr.syncingLabel')} />}
          {isRealError && (
            <div className="flex items-center justify-between gap-2 py-2">
              <p className="text-xs text-danger">{t('prList.couldNotLoadRepo')}</p>
              <button
                type="button"
                onClick={() => query.refetch()}
                className="focus-ring shrink-0 cursor-pointer rounded px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10"
              >
                {t('common.retry')}
              </button>
            </div>
          )}
          {stories.map((story) => (
            <StoryBlock key={story.id} story={story} org={org} />
          ))}
          {unattributed.length > 0 && (
            <div className="space-y-2 rounded-card border border-dashed border-border p-3">
              <p className="text-xs font-medium text-ink-subtle">{t('prList.notLinkedToStory', { count: unattributed.length })}</p>
              <div className="space-y-2">
                {unattributed.map((pr) => (
                  <PRRow key={pr.id} pr={pr} linkedItems={pr.linkedItems} />
                ))}
              </div>
            </div>
          )}
          {!query.isLoading && !isSyncing && !isRealError && shown === 0 && (
            <p className="py-2 text-xs text-ink-subtle">
              {isFilteredView ? t('prList.noMatchInRepo') : t('prList.noneInRepo')}
            </p>
          )}
          {query.hasNextPage && (
            <LoadMore
              shown={shown}
              total={lastPage?.total ?? matchCount}
              onClick={() => query.fetchNextPage()}
              isLoading={query.isFetchingNextPage}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface PrRepoListProps {
  /** null for the signed-in person's own PRs. */
  personId: string | null;
  org: string;
  project: string;
  /** The dashboard's zero-cost per-repo summaries — used directly when
   * `isFilteredView` is false; otherwise only the baseline for header
   * fallbacks while the filtered match-count query is loading. */
  prRepos: PrRepoSummary[];
  /** Comma-joined `PrStatusId` list, `null` for every status, or
   * `'__none__'` for a contradictory combination the caller has already
   * decided matches nothing (renders empty without a request). */
  status: string | null;
  q: string;
  isFilteredView: boolean;
  emptyMessage: string;
  autoExpandCap?: number;
  expandSignal?: number;
  collapseSignal?: number;
}

/** The repo-accordion body of the Pull Requests page — which repos actually
 * have a match under the current status/search filter, and each one's own
 * independently-paged PR list. Shared by the Pull Requests page itself
 * (personId: null) and a Team member's "Open pull requests" drill-down
 * (personId: that teammate's id, status fixed to 'active'). */
export function PrRepoList({
  personId,
  org,
  project,
  prRepos,
  status,
  q,
  isFilteredView,
  emptyMessage,
  autoExpandCap = DEFAULT_AUTO_EXPAND_CAP,
  expandSignal,
  collapseSignal,
}: PrRepoListProps) {
  const t = useTranslation();
  const noStatusAllowed = status === '__none__';

  const repoMatchesQuery = useQuery({
    queryKey: projectQueryKey('pr-repo-matches', personId, status, q),
    queryFn: () => fetchPrRepoMatches({ personId, status, q }),
    enabled: isFilteredView && !noStatusAllowed,
    retry: (failureCount, error) =>
      error instanceof Error && (error.message === 'SYNCING' || error.message === 'RATE_LIMITED') && failureCount < 15,
    retryDelay: (attempt) => Math.min(2000 * 2 ** attempt, 15000),
  });

  const visibleRepos: { repo: { repository: string; repositoryId: string | null; projectName: string | null }; matchCount: number }[] =
    useMemo(() => {
      if (!isFilteredView) return prRepos.map((r) => ({ repo: r, matchCount: r.prCount }));
      if (noStatusAllowed) return [];
      const matches: PrRepoMatch[] = repoMatchesQuery.data?.repos ?? [];
      return matches.map((r) => ({ repo: r, matchCount: r.matchCount }));
    }, [isFilteredView, noStatusAllowed, prRepos, repoMatchesQuery.data]);

  const isSyncing =
    isFilteredView && !noStatusAllowed && repoMatchesQuery.isError && repoMatchesQuery.error instanceof Error &&
    repoMatchesQuery.error.message === 'SYNCING';
  const isLoadingMatches = isFilteredView && !noStatusAllowed && repoMatchesQuery.isLoading;
  const isRealError = isFilteredView && !noStatusAllowed && repoMatchesQuery.isError && !isSyncing;

  if (noStatusAllowed) {
    return <EmptyView>{t('prList.contradictoryFilters')}</EmptyView>;
  }
  // Same split as RepoGroupSection: a genuine first sync gets the real
  // progress bar, an ordinary search/filter fetch gets a plain spinner.
  if (isSyncing) {
    return <SyncProgressNotice personId={personId} enabled fallbackLabel={t('prList.syncingFallback')} />;
  }
  if (isLoadingMatches && visibleRepos.length === 0) {
    return <InlineSpinner label={t('prList.searching')} />;
  }
  if (isRealError) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-card border border-border p-4">
        <p className="text-xs text-danger">{t('prList.couldNotSearch')}</p>
        <button
          type="button"
          onClick={() => repoMatchesQuery.refetch()}
          className="focus-ring shrink-0 cursor-pointer rounded px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10"
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }
  if (visibleRepos.length === 0) {
    return <EmptyView>{emptyMessage}</EmptyView>;
  }

  return (
    <div className="space-y-2">
      {visibleRepos.map(({ repo, matchCount }, i) => (
        <RepoGroupSection
          key={repo.repositoryId ?? repo.repository}
          repo={repo}
          matchCount={matchCount}
          personId={personId}
          org={org}
          project={project}
          status={status}
          q={q}
          isFilteredView={isFilteredView}
          defaultOpen={isFilteredView ? i < autoExpandCap : i === 0}
          expandSignal={expandSignal}
          collapseSignal={collapseSignal}
        />
      ))}
    </div>
  );
}


