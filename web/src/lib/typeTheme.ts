/**
 * Color-codes cards by work item type so it reads at a glance, not just
 * from the small text pill: User Story blue, Task amber, Bug rose, sprint
 * headers violet (kept apart from all three item colors).
 *
 * Applied as a low-alpha tint (never a saturated fill — that would wreck
 * text contrast, amber especially) plus a full-hue left accent bar, which
 * is what actually reads as "this is a Bug" from across the page even
 * though the tint itself is subtle. Classes are complete literal strings —
 * Tailwind's JIT scanner can't see classes assembled by interpolating a
 * hue name into a template, so nothing here may be built from a variable.
 */

import type { AccentBarTone } from '../components/ui/AccentBar';

export interface TypeTheme {
  /** Background tint — very low alpha so the underlying surface still shows through. */
  tint: string;
  /** Border color to match the tint. */
  border: string;
  /** Full-hue background for the left accent bar (a small absolutely
   * positioned strip, not the border — see StoryCard/TaskCard). */
  bar: string;
  /** Tone key for the AccentBar component. */
  accentTone: AccentBarTone;
}

const THEMES: Record<string, TypeTheme> = {
  'User Story': {
    tint: 'bg-type-story/[0.06] dark:bg-type-story/10',
    border: 'border-type-story/30',
    bar: 'bg-type-story',
    accentTone: 'story',
  },
  Task: {
    tint: 'bg-type-task/[0.06] dark:bg-type-task/10',
    border: 'border-type-task/30',
    bar: 'bg-type-task',
    accentTone: 'task',
  },
  Bug: {
    tint: 'bg-type-bug/[0.06] dark:bg-type-bug/10',
    border: 'border-type-bug/30',
    bar: 'bg-type-bug',
    accentTone: 'bug',
  },
};

const DEFAULT_THEME: TypeTheme = {
  tint: 'bg-surface-raised',
  border: 'border-border',
  bar: 'bg-border',
  accentTone: 'neutral',
};

/** The sprint/iteration header color — deliberately not reused by any item
 * type, so a sprint section never reads as "a story" or "a task". */
export const SPRINT_THEME: TypeTheme = {
  tint: 'bg-type-sprint/[0.06] dark:bg-type-sprint/10',
  border: 'border-type-sprint/30',
  bar: 'bg-type-sprint',
  accentTone: 'sprint',
};

export function typeTheme(type: string): TypeTheme {
  return THEMES[type] ?? DEFAULT_THEME;
}
