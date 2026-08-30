/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // ایندیگو پریمیوم (سبک Linear/Stripe) — حالا به CSS variable وصله، پس دارک‌مود واقعی داره
        accent: {
          DEFAULT: 'rgb(var(--accent-primary) / <alpha-value>)',
          hover: '#4338CA',
          light: '#EEF2FF',
          50: '#EEF2FF',
          100: '#E0E4FF',
          200: '#C7CCFB',
          300: '#A5ACF7',
          400: '#7C82F0',
          500: '#5B54EA',
          600: '#4F46E5',
          700: '#4338CA',
          800: '#362FA3',
          900: '#2A2483',
          950: '#171344',
        },
        // بنفش الکتریکی (سبک Stripe)
        cta: {
          DEFAULT: 'rgb(var(--accent-secondary) / <alpha-value>)',
          50: '#F6F4FF',
          100: '#ECE7FF',
          200: '#D9CFFF',
          300: '#BEA6FF',
          400: '#9D75FF',
          500: '#7C4DFF',
          600: '#6C2FF2',
          700: '#5A21C4',
          800: '#481A9C',
          900: '#38157A',
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
        sm: '0 1px 2px rgba(0,0,0,0.04)',
        md: '0 4px 12px rgba(0,0,0,0.08)',
        card: '0 1px 2px rgb(15 23 42 / 0.04), 0 10px 30px -24px rgb(15 23 42 / 0.28)',
        'card-hover': '0 18px 50px -28px rgb(15 23 42 / 0.32), 0 8px 18px -12px rgb(79 70 229 / 0.18)',
        'card-dark': '0 1px 2px rgb(0 0 0 / 0.35), 0 18px 44px -28px rgb(0 0 0 / 0.75)',
        'card-hover-dark': '0 22px 60px -30px rgb(0 0 0 / 0.85), 0 8px 22px -14px rgb(129 140 248 / 0.2)',
        'glow-accent': '0 18px 42px -20px rgb(var(--accent-primary) / 0.45)',
        'glow-cta': '0 18px 40px -18px rgb(var(--accent-secondary) / 0.45)',
      },
    },
  },
  plugins: [],
}
