/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        display: ['"Sora"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      letterSpacing: {
        tightest: '-0.045em',
      },
      fontSize: {
        // Was referenced sitewide via eyebrowClass()/sectionHeadingClass() but
        // never defined, so every section-label kicker silently fell back to
        // the browser default size instead of the intended small-caps label.
        eyebrow: ['0.75rem', { lineHeight: '1.4', letterSpacing: '0.02em' }],
      },
      colors: {
        // Signal cobalt — the one confident brand color. Wired to a CSS
        // variable so dark mode gets a real, separately-tuned value
        // instead of the same hex dimmed with opacity.
        accent: {
          DEFAULT: 'rgb(var(--accent-primary) / <alpha-value>)',
          hover: '#1A2FAE',
          light: '#EEF1FF',
          50: '#EEF1FF',
          100: '#DCE2FE',
          200: '#B9C5FD',
          300: '#8FA0FB',
          400: '#5E72F5',
          500: '#3448E8',
          600: '#203AD8',
          700: '#1A2FAE',
          800: '#172887',
          900: '#16256C',
          950: '#0D1440',
        },
        // Signal copper — reserved for live/urgent moments (active calls,
        // emergency detection). Deliberately never used as a CTA color so
        // it keeps its meaning as "something is happening right now".
        cta: {
          DEFAULT: 'rgb(var(--accent-secondary) / <alpha-value>)',
          50: '#FDF3EE',
          100: '#FBE3D7',
          200: '#F5C3AB',
          300: '#EE9C76',
          400: '#E57849',
          500: '#D6582A',
          600: '#B8451E',
          700: '#93361A',
          800: '#742C19',
          900: '#5E2417',
        },
        ai: 'rgb(var(--accent-secondary) / <alpha-value>)',
        'bg-primary': 'rgb(var(--bg-primary) / <alpha-value>)',
        'bg-secondary': 'rgb(var(--bg-secondary) / <alpha-value>)',
        'bg-tertiary': 'rgb(var(--bg-tertiary) / <alpha-value>)',
        text: {
          primary: 'rgb(var(--text-primary) / <alpha-value>)',
          secondary: 'rgb(var(--text-secondary) / <alpha-value>)',
        },
        'text-primary': 'rgb(var(--text-primary) / <alpha-value>)',
        'text-secondary': 'rgb(var(--text-secondary) / <alpha-value>)',
        border: {
          DEFAULT: 'rgb(var(--border-default) / <alpha-value>)',
        },
        success: 'rgb(var(--success) / <alpha-value>)',
        'success-500': 'rgb(var(--success) / <alpha-value>)',
        'warning-500': 'rgb(var(--warning) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
      },
      borderRadius: {
        full: '9999px',
        md: '12px',
      },
      boxShadow: {
        sm: '0 1px 2px rgba(15,15,18,0.04)',
        md: '0 2px 8px rgba(15,15,18,0.06)',
        card: '0 1px 1px rgb(15 15 18 / 0.03), 0 6px 20px -14px rgb(15 15 18 / 0.22)',
        'card-hover': '0 10px 32px -16px rgb(15 15 18 / 0.24), 0 4px 12px -8px rgb(32 58 216 / 0.14)',
        'card-dark': '0 1px 1px rgb(0 0 0 / 0.4), 0 10px 28px -16px rgb(0 0 0 / 0.7)',
        'card-hover-dark': '0 14px 38px -18px rgb(0 0 0 / 0.75), 0 4px 14px -8px rgb(108 130 255 / 0.18)',
        'glow-accent': '0 12px 28px -14px rgb(var(--accent-primary) / 0.4)',
        'glow-cta': '0 12px 26px -12px rgb(var(--accent-secondary) / 0.4)',
      },
      keyframes: {
        // نوار حرکتی راست‌به‌چپ و بی‌درز برای Live AI Activity Stream.
        // ترک، محتوا را دقیقاً دو بار پشت‌سرهم رندر می‌کند، پس ترنسلیت -50%
        // بدون هیچ پرش/درزی حلقه می‌شود.
        marquee: {
          '0%': { transform: 'translateX(0%)' },
          '100%': { transform: 'translateX(-50%)' },
        },
      },
      animation: {
        marquee: 'marquee 138s linear infinite',
      },
    },
  },
  plugins: [],
}
