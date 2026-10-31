/**
 * A bar series against a reference line — inline SVG rather than a charting
 * dependency (research.md R6: Node 16 rules out anything needing ≥18, and a
 * library is a large tree for two simple charts). Theme-aware via existing
 * CSS custom properties (no color is defined only inside a media query —
 * see index.css's token definitions), so it needs no dark-mode branch of
 * its own.
 *
 * Tokens used (documented here, and in DESIGN.md, per Principle V so a
 * future chart doesn't reinvent them) — the `--chart-*` custom properties
 * already defined in index.css for both themes, kept apart from the
 * status/type/accent tokens because a data series isn't any of those:
 * `--chart-series-1` for each bar, `--chart-muted` for the reference
 * (average) line, `--chart-axis` for the baseline. Axis labels use the
 * ordinary `text-ink-subtle` Tailwind token, not a chart-specific one.
 *
 * FR-018: an explicit `dir="ltr"` island regardless of page direction, plus
 * a translated caption stating the direction — see LineChart.tsx's header
 * comment for the full reasoning; both charts share it.
 */
import { t } from '../../lib/i18n';

interface BarChartSeries {
  label: string;
  value: number;
  /** Rendered as a lighter cap on top of `value` — used by VelocityCard to
   * show the completed/partial split within one bar without a second chart
   * primitive. Omit for a plain single-tone bar. */
  secondaryValue?: number;
  /** True dims the bar slightly — used for a provisional (in-progress)
   * sprint, so "not final yet" reads visually, not just in a tooltip. */
  muted?: boolean;
}

interface BarChartProps {
  series: BarChartSeries[];
  /** A horizontal reference line (e.g. the average) — omitted when there's
   * nothing to compare against yet. */
  reference?: number | null;
  referenceLabel?: string;
  height?: number;
  /** Formats a value for the label above each bar and the reference line. */
  formatValue?: (value: number) => string;
}

const DEFAULT_HEIGHT = 160;
const BAR_GAP = 8;

export function BarChart({ series, reference, referenceLabel, height = DEFAULT_HEIGHT, formatValue = (v) => String(Math.round(v * 10) / 10) }: BarChartProps) {
  if (series.length === 0) return null;
  const max = Math.max(...series.map((s) => Math.max(s.value, s.secondaryValue ?? 0)), reference ?? 0, 1);
  const chartHeight = height - 28; // leaves room for axis labels below
  const barWidth = 100 / series.length;

  const yFor = (v: number) => chartHeight - (v / max) * chartHeight;

  const seriesSummary = series.map((s) => `${s.label}: ${formatValue(s.value)}`).join(', ');

  return (
    <div dir="ltr" className="w-full overflow-x-auto">
      <svg
        role="img"
        aria-label={t('chart.barChartAriaLabel', { series: seriesSummary })}
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        className="h-40 w-full min-w-[20rem]"
      >
        <title>{seriesSummary}</title>
        {/* Baseline */}
        <line x1={0} y1={chartHeight} x2={100} y2={chartHeight} stroke="var(--chart-axis)" strokeWidth={0.5} />

        {reference != null && (
          <line
            x1={0}
            y1={yFor(reference)}
            x2={100}
            y2={yFor(reference)}
            stroke="var(--chart-muted)"
            strokeWidth={0.6}
            strokeDasharray="2,2"
          />
        )}

        {series.map((s, i) => {
          const x = i * barWidth + BAR_GAP / 20;
          const w = barWidth - BAR_GAP / 10;
          const topY = yFor(s.value);
          const secondaryY = s.secondaryValue != null ? yFor(s.secondaryValue) : null;
          return (
            <g key={`${s.label}-${i}`}>
              <rect
                x={x}
                y={topY}
                width={w}
                height={Math.max(0, chartHeight - topY)}
                fill="var(--chart-series-1)"
                opacity={s.muted ? 0.45 : 0.85}
                rx={0.8}
              />
              {secondaryY != null && (
                <rect
                  x={x}
                  y={secondaryY}
                  width={w}
                  height={Math.max(0, topY - secondaryY)}
                  fill="var(--chart-series-1)"
                  opacity={s.muted ? 0.2 : 0.4}
                  rx={0.8}
                />
              )}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex w-full min-w-[20rem]" style={{ display: 'flex' }}>
        {series.map((s, i) => (
          <div key={`${s.label}-label-${i}`} className="flex-1 truncate text-center text-[10px] text-ink-subtle" title={s.label}>
            {s.label}
          </div>
        ))}
      </div>
      {reference != null && referenceLabel && (
        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-muted">
          <span className="inline-block h-0 w-3 border-t border-dashed border-ink-muted" aria-hidden="true" />
          {referenceLabel}: {formatValue(reference)}
        </p>
      )}
      <p className="mt-1 text-[10px] text-ink-subtle">{t('chart.timeDirectionCaption')}</p>
    </div>
  );
}
