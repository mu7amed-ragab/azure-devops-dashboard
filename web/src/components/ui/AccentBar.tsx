export type AccentBarTone = 'story' | 'task' | 'bug' | 'sprint' | 'neutral';

/** Complete literal strings — see Pill.tsx for why this can't interpolate a
 * variable into the class name. */
const TONE_CLASSES: Record<AccentBarTone, string> = {
  story: 'bg-type-story',
  task: 'bg-type-task',
  bug: 'bg-type-bug',
  sprint: 'bg-type-sprint',
  neutral: 'bg-border',
};

/** The Ledger's signature spine — a 4px full-hue strip down the left edge
 * of every story/task/sprint card, deliberately kept above the 1px the
 * floor otherwise defaults to (see DESIGN.md's Spine Rule). Card nesting
 * (sprint -> story -> task) means these stack visually by design, not by
 * accident. */
export function AccentBar({ tone }: { tone: AccentBarTone }) {
  return <div className={`absolute inset-y-0 start-0 w-1 rounded-s-card ${TONE_CLASSES[tone]}`} />;
}
