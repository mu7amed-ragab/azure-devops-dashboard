import { en } from './en';
import { ar } from './ar';
import { useLang } from './useLang';

// Plural rules for each language
const pluralRules = {
  en: new Intl.PluralRules('en-US'),
  ar: new Intl.PluralRules('ar'),
};

type CatalogKey = keyof typeof en;
type InterpolationValues = Record<string, string | number>;

// Translate a key with optional plural/interpolation support
export function t(key: CatalogKey, values?: InterpolationValues): string {
  const { lang } = useLang.getState?.();
  const activeLanguage = lang === 'ar' ? 'ar' : 'en';
  const catalog = activeLanguage === 'ar' ? ar : en;

  let entry = catalog[key];

  // Fallback to English if the entry is empty
  if (!entry) {
    entry = en[key];
  }

  if (!entry) {
    // Fallback: return the key itself as a last resort
    return String(key);
  }

  // Handle plural forms if the entry is an object with plural categories
  if (values && typeof entry === 'object' && 'other' in entry) {
    const pluralEntry = entry as Record<string, string>;
    const count = values.count as number;
    const pluralRules_lang = pluralRules[activeLanguage as keyof typeof pluralRules];
    const category = pluralRules_lang.select(count);
    const pluralString = pluralEntry[category] || pluralEntry.other;
    entry = pluralString;
  }

  // Handle interpolation
  if (values && typeof entry === 'string') {
    let result = entry;
    for (const [key, value] of Object.entries(values)) {
      const placeholder = new RegExp(`\\{${key}\\}`, 'g');
      result = result.replace(placeholder, String(value));
    }
    return result;
  }

  return String(entry);
}

// Re-export the language store
export { useLang } from './useLang';

/** Call once per component that renders translated text. Subscribing to the
 * `lang` slice (even though the returned `t` is the same plain function)
 * is what makes React re-render that component when the language switches —
 * `t()` itself stays a plain function so it can still be called from loops,
 * callbacks, and conditionals without violating the Rules of Hooks. */
export function useTranslation() {
  useLang((s) => s.lang);
  return t;
}
