import { format, formatDistanceToNow, isValid, parseISO } from 'date-fns';
import { enUS, ar } from 'date-fns/locale';
import { useLang } from './i18n/useLang';
import { en } from './i18n/en';
import { ar as arCatalog } from './i18n/ar';

const dateLocales = { en: enUS, ar };

// 'ar-u-nu-latn' (not bare 'ar') pins Western/Latin digits under Arabic —
// spec Assumptions require Latin digits in both languages; the bare 'ar'
// locale's default numbering system is Arabic-Indic (١٬٢٣٤), which is wrong
// here and was the FR-020 regression this comment replaces.
const NUMBER_LOCALES = { en: 'en-US', ar: 'ar-u-nu-latn' } as const;

// A local, tiny catalog lookup rather than i18n's own t() — t() always reads
// the GLOBAL active language, which would disagree with an explicit `lang`
// argument passed to formatHours (e.g. a component rendering another
// person's preference). Keying off the already-resolved `language` here
// keeps the unit suffix consistent with the digits next to it.
const HOURS_UNIT = { en: en['common.hoursUnit'], ar: arCatalog['common.hoursUnit'] } as const;

function getLocale(lang?: 'en' | 'ar') {
  const language = lang || useLang.getState?.().lang || 'en';
  return dateLocales[language as keyof typeof dateLocales];
}

export function formatDate(value: string | null, lang?: 'en' | 'ar'): string {
  if (!value) return '—';
  const d = parseISO(value);
  if (!isValid(d)) return '—';
  const locale = getLocale(lang);
  return format(d, 'MMM d, yyyy', { locale });
}

export function formatRelative(value: string | null, lang?: 'en' | 'ar'): string {
  if (!value) return '—';
  const d = parseISO(value);
  if (!isValid(d)) return '—';
  const locale = getLocale(lang);
  return formatDistanceToNow(d, { addSuffix: true, locale });
}

export function formatNumber(value: number, lang?: 'en' | 'ar'): string {
  const language = lang || useLang.getState?.().lang || 'en';
  // Use Latin digits in Arabic per spec Assumptions
  const formatter = new Intl.NumberFormat(NUMBER_LOCALES[language as keyof typeof NUMBER_LOCALES] || NUMBER_LOCALES.en, {
    useGrouping: true,
  });
  return formatter.format(value);
}

export function formatPercent(value: number, lang?: 'en' | 'ar'): string {
  const language = lang || useLang.getState?.().lang || 'en';
  const formatter = new Intl.NumberFormat(NUMBER_LOCALES[language as keyof typeof NUMBER_LOCALES] || NUMBER_LOCALES.en, {
    style: 'percent',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return formatter.format(value / 100);
}

export function formatHours(value: number, lang?: 'en' | 'ar'): string {
  const language = lang || useLang.getState?.().lang || 'en';
  const rounded = Math.round(value * 10) / 10;
  const formatter = new Intl.NumberFormat(NUMBER_LOCALES[language as keyof typeof NUMBER_LOCALES] || NUMBER_LOCALES.en);
  const formatted = formatter.format(rounded);
  const unit = HOURS_UNIT[language as keyof typeof HOURS_UNIT] || HOURS_UNIT.en;
  return `${formatted}${unit}`;
}

export function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}
