import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // Formatting policy: use @/lib/format (or useFormat()). CI enforces a ratchet via
    // `npm run lint:locale`; this rule gives immediate editor feedback.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/lib/format.ts', 'src/lib/regional.ts', 'src/lib/timezone.ts', '**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'warn',
        {
          selector: "CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/]",
          message: 'Use formatDate/formatTime/formatDateTime/formatNumber/formatCurrency from @/lib/format (or useFormat()).',
        },
        {
          selector: "NewExpression[callee.object.name='Intl'][callee.property.name=/^(NumberFormat|DateTimeFormat|RelativeTimeFormat|ListFormat)$/]",
          message: 'Do not construct Intl formatters directly. Use the helpers in @/lib/format.',
        },
      ],
    },
  },
)
