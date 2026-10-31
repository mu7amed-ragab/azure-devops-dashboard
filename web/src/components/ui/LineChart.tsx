/**
 * Two line series (actual vs. ideal) — inline SVG, the burndown counterpart
 * to BarChart.tsx (research.md R6, FR-030). Same token set: `--chart-axis`
 * for the baseline, `--chart-series-1` for the actual line, `--chart-series-2`
 * for the ideal reference line (visually distinct — a solid vs. a dashed
 * stroke of a different hue, never colour alone). Theme-aware via the same
 * CSS custom properties BarChart uses, defined for both themes in index.css.
 *
 * FR-018: time reads left-to-right in both languages, so the whole chart is
 * an explicit `dir="ltr"` island regardless of the page's own direction —
 * mirroring it under Arabic would make x still read chronologically but
 * visually backwards. The caption beneath states this rather than leaving
 * it as a silent design decision (contracts/i18n-catalog.md).
 */
import { t } from '../../lib/i18n';

interface LineChartPoint {
  label: string;
  /** null renders as a gap — the actual line stops rather than dropping to
   * the axis (FR-031). */
  actual: number | null;
  ideal: number;
}

interface LineChartProps {
  points: LineChartPoint[];
  height?: number;
  formatValue?: (value: number) => string;
}

const DEFAULT_HEIGHT = 160;

function pathFor(values: (number | null)[], max: number, chartHeight: number): string {
  const step = values.length > 1 ? 100 / (values.length - 1) : 0;
  const segments: string[] = [];
  let drawing = false;
  values.forEach((v, i) => {
    const x = i * step;
    if (v == null) {
      drawing = false;
      return;
    }
    const y = chartHeight - (v / max) * chartHeight;
    segments.push(`${drawing ? 'L' : 'M'} ${x} ${y}`);
    drawing = true;
  });
  return segments.join(' ');
}

export function LineChart({ points, height = DEFAULT_HEIGHT, formatValue = (v) => String(Math.round(v * 10) / 10) }: LineChartProps) {
  if (points.length === 0) return null;
  const max = Math.max(...points.map((p) => Math.max(p.actual ?? 0, p.ideal)), 1);
  const chartHeight = height - 28;

  const actualPath = pathFor(points.map((p) => p.actual), max, chartHeight);
  const idealPath = pathFor(points.map((p) => p.ideal), max, chartHeight);

  const labelEvery = Math.max(1, Math.ceil(points.length / 8)); // avoid a dense unreadable axis on a long sprint

  const ariaLabel = t('chart.lineChartAriaLabel', {
    points: points
      .map((p) => `${p.label} ${p.actual == null ? t('chart.notYetKnown') : formatValue(p.actual)}`)
      .join(', '),
  });

  return (
    <div dir="ltr" className="w-full overflow-x-auto">
      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        className="h-40 w-full min-w-[24rem]"
      >
        <title>{t('chart.burndownTitle')}</title>
        <line x1={0} y1={chartHeight} x2={100} y2={chartHeight} stroke="var(--chart-axis)" strokeWidth={0.5} />
        <path d={idealPath} fill="none" stroke="var(--chart-series-2)" strokeWidth={0.6} strokeDasharray="2,2" vectorEffect="non-scaling-stroke" />
        <path d={actualPath} fill="none" stroke="var(--chart-series-1)" strokeWidth={0.9} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1 flex w-full min-w-[24rem]">
        {points.map((p, i) => (
          <div key={`${p.label}-${i}`} className="flex-1 truncate text-center text-[9px] text-ink-subtle">
            {i % labelEvery === 0 ? p.label : ''}
          </div>
        ))}
      </div>
      <p className="mt-1.5 flex items-center gap-3 text-[11px] text-ink-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 bg-[var(--chart-series-1)]" aria-hidden="true" /> {t('chart.actualLabel')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0 w-3 border-t border-dashed" style={{ borderColor: 'var(--chart-series-2)' }} aria-hidden="true" /> {t('chart.idealLabel')}
        </span>
      </p>
      <p className="mt-1 text-[10px] text-ink-subtle">{t('chart.timeDirectionCaption')}</p>
    </div>
  );
}
