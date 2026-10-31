import type { PrPage, PrStoryBlock, PullRequest, UnattributedPr } from './types';

/** How many PRs a repo page (or a story's PR list) fetches/shows at a time.
 * PRs within a story/repo already arrive sorted by most-recent activity
 * (server/compute/prGroups.js), so "first N" always means "N most recent". */
export const PR_PAGE_SIZE = 10;

/** Merges consecutive pages from GET /api/pullrequests (see
 * PullRequestsPage's `useInfiniteQuery` per repo) into one story/unattributed
 * view. A story's PRs can legitimately be split across two pages — each
 * page only attributes the PRs it was given, so the same story id can
 * appear on more than one page — so stories are merged by id and their
 * pullRequests concatenated (deduped by PR id, since a page boundary can't
 * split an individual PR but the merge itself must still be safe to re-run
 * on every render). */
export function mergePrPages(pages: PrPage[]): { stories: PrStoryBlock[]; unattributed: UnattributedPr[] } {
  const storiesById = new Map<number, PrStoryBlock>();
  const unattributed: UnattributedPr[] = [];
  const seenUnattributedIds = new Set<number>();

  for (const page of pages) {
    for (const story of page.stories) {
      const existing = storiesById.get(story.id);
      if (!existing) {
        storiesById.set(story.id, { ...story, pullRequests: [...story.pullRequests] });
        continue;
      }
      const seenIds = new Set(existing.pullRequests.map((pr) => pr.id));
      existing.pullRequests.push(...story.pullRequests.filter((pr) => !seenIds.has(pr.id)));
    }
    for (const pr of page.unattributed) {
      if (seenUnattributedIds.has(pr.id)) continue;
      seenUnattributedIds.add(pr.id);
      unattributed.push(pr);
    }
  }

  return { stories: [...storiesById.values()], unattributed };
}

/** Truncates a flat PR list to `limit`, returning the slice plus counts —
 * used by StoryCard, which already holds a story's full (background-filled)
 * PR list client-side and only needs a render cap, not a server round trip. */
export function takePrs(prs: PullRequest[], limit: number): { prs: PullRequest[]; shown: number; total: number } {
  const total = prs.length;
  if (limit >= total) return { prs, shown: total, total };
  return { prs: prs.slice(0, limit), shown: limit, total };
}
