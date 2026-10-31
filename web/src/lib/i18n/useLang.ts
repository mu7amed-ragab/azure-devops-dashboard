import { create } from 'zustand';

export type Language = 'en' | 'ar';

interface LangState {
  lang: Language;
  dir: 'ltr' | 'rtl';
  setLang: (lang: Language) => void;
}

function getInitialLanguage(): Language {
  if (typeof document !== 'undefined') {
    const stored = localStorage.getItem('lang');
    if (stored === 'en' || stored === 'ar') {
      return stored;
    }
  }

  // Check browser's preferred languages
  if (typeof navigator !== 'undefined') {
    const languages = navigator.languages || [navigator.language];
    for (const lang of languages) {
      if (lang.startsWith('ar')) {
        return 'ar';
      }
    }
  }

  return 'en';
}

function getDir(lang: Language): 'ltr' | 'rtl' {
  return lang === 'ar' ? 'rtl' : 'ltr';
}

const initialLang = getInitialLanguage();
const initialDir = getDir(initialLang);

export const useLang = create<LangState>((set, get) => ({
  lang: initialLang,
  dir: initialDir,
  setLang: (lang: Language) => {
    localStorage.setItem('lang', lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = getDir(lang);
    set({ lang, dir: getDir(lang) });
  },
}));
