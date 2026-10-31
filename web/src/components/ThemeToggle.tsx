import { Moon, Sun } from 'lucide-react';
import { useThemeStore } from '../lib/theme';
import { t } from '../lib/i18n';

export function ThemeToggle() {
  const { theme, toggle } = useThemeStore();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={t('common.toggleColorTheme')}
      className="focus-ring flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-border text-ink-muted transition-colors hover:text-ink"
    >
      {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
