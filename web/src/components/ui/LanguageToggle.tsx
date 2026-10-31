import { useLang } from '@/lib/i18n/useLang';
import { useTranslation } from '@/lib/i18n';

export function LanguageToggle() {
  const { lang, setLang } = useLang();
  const t = useTranslation();

  return (
    <button
      onClick={() => setLang(lang === 'en' ? 'ar' : 'en')}
      className="rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-surface-raised focus-ring"
      title={lang === 'en' ? t('common.switchToArabic') : t('common.switchToEnglish')}
      aria-label={lang === 'en' ? t('common.switchToArabic') : t('common.switchToEnglish')}
    >
      {lang === 'en' ? 'العربية' : 'English'}
    </button>
  );
}
