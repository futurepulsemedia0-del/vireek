/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: 'rgb(var(--accent-primary) / <alpha-value>)',
          50: 'rgb(var(--accent-primary) / 0.05)',
          100: 'rgb(var(--accent-primary) / 0.1)',
          200: 'rgb(var(--accent-primary) / 0.2)',
        },
        cta: {
          DEFAULT: '#F97316',
          50: '#FFF7ED',
          100: '#FFEDD5',
          200: '#FED7AA',
          300: '#FDBA74',
          400: '#FB923C',
          500: '#F97316',
          600: '#EA580C',
          700: '#C2410C',
          800: '#9A3412',
          900: '#7C2D12',
        },
        'bg-primary': 'rgb(var(--bg-primary) / <alpha-value>)',
        'bg-secondary': 'rgb(var(--bg-secondary) / <alpha-value>)',
        'bg-tertiary': 'rgb(var(--bg-tertiary) / <alpha-value>)',
        'text-primary': 'rgb(var(--text-primary) / <alpha-value>)',
        'text-secondary': 'rgb(var(--text-secondary) / <alpha-value>)',
        border: 'rgb(var(--border-default) / <alpha-value>)',
        'success-500': 'rgb(var(--success) / <alpha-value>)',
        'warning-500': '#F59E0B',
        danger: 'rgb(var(--danger) / <alpha-value>)',
      },
      boxShadow: {
        card: '0 1px 3px 0 rgb(0 0 0 / 0.04), 0 1px 2px 0 rgb(0 0 0 / 0.02)',
        'card-hover': '0 8px 24px -4px rgb(0 0 0 / 0.08), 0 2px 8px -2px rgb(0 0 0 / 0.04)',
        'card-dark': '0 1px 3px 0 rgb(0 0 0 / 0.2), 0 1px 2px 0 rgb(0 0 0 / 0.1)',
        'card-hover-dark': '0 8px 24px -4px rgb(0 0 0 / 0.3), 0 2px 8px -2px rgb(0 0 0 / 0.2)',
        'glow-cta': '0 0 24px -4px rgb(249 115 22 / 0.4)',
      },
    },
  },
  plugins: [],
}
