/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          raised: 'rgb(var(--surface-raised) / <alpha-value>)',
          sunken: 'rgb(var(--surface-sunken) / <alpha-value>)',
        },
        border: {
          DEFAULT: 'rgb(var(--border) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'rgb(var(--ink) / <alpha-value>)',
          muted: 'rgb(var(--ink-muted) / <alpha-value>)',
          subtle: 'rgb(var(--ink-subtle) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          hover: 'rgb(var(--accent-hover) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'rgb(var(--success) / <alpha-value>)',
          tint: 'rgb(var(--success-tint) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'rgb(var(--warning) / <alpha-value>)',
          tint: 'rgb(var(--warning-tint) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'rgb(var(--danger) / <alpha-value>)',
          tint: 'rgb(var(--danger-tint) / <alpha-value>)',
        },
        info: {
          DEFAULT: 'rgb(var(--info) / <alpha-value>)',
          tint: 'rgb(var(--info-tint) / <alpha-value>)',
        },
        type: {
          story: 'rgb(var(--type-story) / <alpha-value>)',
          task: 'rgb(var(--type-task) / <alpha-value>)',
          bug: 'rgb(var(--type-bug) / <alpha-value>)',
          sprint: 'rgb(var(--type-sprint) / <alpha-value>)',
        },
        stage: {
          approved: 'rgb(var(--stage-approved) / <alpha-value>)',
          review: 'rgb(var(--stage-review) / <alpha-value>)',
          staging: 'rgb(var(--stage-staging) / <alpha-value>)',
          intake: 'rgb(var(--stage-intake) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['InterVariable', 'Inter', 'Noto Sans Arabic Variable', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      borderRadius: {
        card: '10px',
      },
      zIndex: {
        header: '10',
        raised: '20',
        popover: '30',
        modal: '40',
        skip: '50',
      },
    },
  },
  plugins: [],
};
