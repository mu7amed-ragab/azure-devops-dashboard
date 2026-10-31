/**
 * Pure functions distributing a story's estimate across the sprints it
 * spanned, and rolling that up into per-sprint and windowed team velocity.
 * See data-model.md §3 and spec FR-008/FR-009/FR-011/FR-012/FR-013.
 *
 * Nothing here calls Azure DevOps or reads a cache — server/scrum.js
 * gathers each story's per-sprint `{ deltaCompleted, totalAtEnd,
 * estimateAtEnd }` from the revision index (aggregated across the story and
 * its descendants) and this module does the arithmetic.
 *
 * IMMUTABILITY (FR-008c) is enforced by server/scrum.js's caching, not
 * here: this module is a pure, deterministic function of its inputs and
 * will recompute a different answer if asked again with different history —
 * what keeps a CLOSED sprint's already-shown share from changing is that
 * scrum.js never re-invokes this for a sprint once cached (data-model.md
 * §9). Read that cache contract before assuming this file enforces
 * immutability itself.
 */

/**
 * One story's contribution across every sprint it appears in.
 *
 * @param {object} story
 * @param {number} story.id
 * @param {string|null} story.title
 * @param {Array<{sprintPath:string, deltaCompleted:number, totalAtEnd:number|null, estimateAtEnd:number|null}>} story.perSprint
 *   ascending chronological order — every sprint this story had any
 *   revision activity in, in or out of the current window (a story capped
 *   or completed outside the window still needs its full history to get
 *   the in-window shares right).
 * @param {string|null} story.completingSprintPath the sprint whose dates
 *   contain the moment this story's state first reached the Completed
 *   category, or null if it never has (still in flight).
 * @param {number|null} story.finalEstimate the story's own estimate as of
 *   its completing sprint (or its latest known value, if still open).
 * @returns {Array} SprintShare records (data-model.md §3)
 */
function distributeStory(story) {
  const shares = [];
  let cumulative = 0;
  const everMeasurable = story.perSprint.some((sp) => sp.totalAtEnd != null && sp.totalAtEnd > 0);

  for (const sp of story.perSprint) {
    const isCompleting = sp.sprintPath === story.completingSprintPath;
    let basis = 'measured';
    let fraction = null;
    let points = 0;
    let capped = false;
    let overDistributedBy = null;

    if (sp.totalAtEnd != null && sp.totalAtEnd > 0) {
      // FR-008a-i: a downward correction to completed work must never
      // contribute a negative share.
      fraction = Math.max(0, sp.deltaCompleted) / sp.totalAtEnd;
      points = fraction * (sp.estimateAtEnd || 0);
      // FR-008b-i: cumulative shares are capped at the estimate as at THIS
      // sprint — never let an overrun distribute more than the story is
      // actually worth.
      if (sp.estimateAtEnd != null && cumulative + points > sp.estimateAtEnd) {
        points = Math.max(0, sp.estimateAtEnd - cumulative);
        capped = true;
      }
    }

    if (isCompleting) {
      // A4: the completing-sprint branch below REPLACES `points` outright
      // (whole-credit or the prospective remainder) — a cap the proportional
      // branch just set above never actually constrained the number that
      // ships, so it must not be disclosed as if it had.
      capped = false;
      if (!everMeasurable) {
        // FR-008e: no sprint ever had measurable child work for this story
        // — credit it whole, entirely at the completing sprint (FR-008e-ii:
        // decided across the whole story's history, not just this sprint,
        // so a story measurable elsewhere is never diverted into this path).
        basis = 'whole-credit';
        fraction = null;
        points = story.finalEstimate || 0;
      } else {
        // FR-008b / FR-008c-ii: conservation is enforced PROSPECTIVELY here
        // — the completing sprint gets whatever remains of the final
        // estimate, not its own fraction*estimate figure. A closed sprint's
        // already-credited shares are never revisited to make room.
        const remainder = (story.finalEstimate || 0) - cumulative;
        if (remainder < 0) {
          // FR-008c-iii: a downward re-estimate fell below what earlier
          // sprints already hold. Credit zero here, claw back nothing, and
          // disclose the excess rather than hide it.
          points = 0;
          overDistributedBy = -remainder;
        } else {
          points = remainder;
        }
      }
    }

    cumulative += points;
    shares.push({
      storyId: story.id,
      storyTitle: story.title,
      sprintPath: sp.sprintPath,
      basis,
      fraction,
      points,
      estimateAtSprintEnd: sp.estimateAtEnd,
      capped,
      remainder: isCompleting,
      overDistributedBy,
    });
  }
  return shares;
}

/** Rolls every story's shares into one sprint's SprintVelocity (data-model.md
 * §3). `sprintPath` selects which sprint's shares to fold; `allShares` is the
 * flat array across every story (each already tagged with its own
 * sprintPath by distributeStory). */
function rollupSprint(sprintPath, allShares, { isProvisional, exclusions, offRoster, unit }) {
  const shares = allShares.filter((s) => s.sprintPath === sprintPath);
  const sum = (pred) => shares.filter(pred).reduce((acc, s) => acc + s.points, 0);
  const total = shares.reduce((acc, s) => acc + s.points, 0);
  // A9: every disclosure figure above is computed from the FULL `shares`
  // set, before this trim — dropping a zero-point share that nothing
  // discloses (not capped, not over-distributed, not whole-credit, not a
  // completing remainder) never changes a total, only shrinks a payload/
  // cache entry that used to carry one entry per project story regardless
  // of whether any view ever reads it.
  const disclosureWorthy = shares.filter(
    (s) => s.points !== 0 || s.capped || s.overDistributedBy != null || s.basis === 'whole-credit' || s.remainder
  );
  return {
    sprintPath,
    total,
    completedPortion: sum((s) => s.remainder),
    partialPortion: sum((s) => !s.remainder),
    measuredPortion: sum((s) => s.basis === 'measured'),
    wholeCreditPortion: sum((s) => s.basis === 'whole-credit'),
    isProvisional: !!isProvisional,
    cappedStoryIds: [...new Set(shares.filter((s) => s.capped).map((s) => s.storyId))],
    overDistributedStoryIds: [...new Set(shares.filter((s) => s.overDistributedBy != null).map((s) => s.storyId))],
    offRoster: offRoster || [],
    shares: disclosureWorthy,
    exclusions: exclusions || { noEstimate: 0, noMeasurableWork: 0 },
    unit,
  };
}

/** The team's average velocity across the window's non-provisional sprints
 * (FR-011, FR-012). Returns null when there are none to average. */
function averageOf(sprintVelocities) {
  const final = sprintVelocities.filter((s) => !s.isProvisional);
  if (final.length === 0) return null;
  return final.reduce((acc, s) => acc + s.total, 0) / final.length;
}

module.exports = { distributeStory, rollupSprint, averageOf };
