import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import vireekA11y from './scripts/eslint/vireek-a11y-plugin.mjs'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import vireekImg from './eslint-rules/vireek-img.mjs'

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
  {
    files: ['src/**/*.{jsx,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', 'src/components/ui/Img.tsx'],
    plugins: { 'jsx-a11y': jsxA11y, 'vireek-img': vireekImg },
    rules: {
      'jsx-a11y/alt-text': ['error', { img: ['Img', 'RevealImage'] }],
      'jsx-a11y/img-redundant-alt': 'error',
      'vireek-img/policy': 'error',
    },
  },
    // Formatting policy: use @/lib/format (or useFormat()). CI enforces a ratchet via
    // `npm run lint:locale`; this rule gives immediate editor feedback.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/lib/format.ts', 'src/lib/regional.ts', 'src/lib/timezone.ts', 'src/styles/tokens.generated.ts', '**/*.test.{ts,tsx}'],
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
        // Colour tokens only. WARN while legacy literals (canvas/PDF/email/tenant data) are retired; the hard gate is
        // `npm run lint:colors` (ratchet baseline). Flip 'warn' to 'error' once scripts/color/color-baseline.json is {}.
        {
          selector: 'Literal[value=/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\\b/]',
          message: 'Use a colour token (rgb(var(--…)) or a semantic Tailwind class), not a hex literal. See docs/design/COLOR_TOKENS.md.',
        },
        {
          selector: 'Literal[value=/\\b(?:rgba?|hsla?)\\(\\s*[0-9]/]',
          message: 'Use rgb(var(--token)) instead of rgb()/hsl() literals.',
        },
        // Alpha on text colour is banned (WCAG 1.4.3). WARN while legacy usages are migrated; the hard gate is `npm run lint:design`
        // (ratchet baseline). Flip to 'error' once scripts/color/text-alpha-baseline.json is {}. Slash is written as \\x2f (esquery has no escape).
        {
          selector: 'Literal[value=/(^|[\\s:!])text-(?!(?:xs|sm|base|lg|xl|[2-9]xl|eyebrow)\\x2f)[a-z][a-z0-9-]*\\x2f[0-9\\[]/]',
          message: 'No alpha on text colour. Use text-text-secondary / text-text-muted / text-text-placeholder / text-graphic-muted (or `// contrast-ok: reason`).',
        },
        {
          selector: 'TemplateElement[value.raw=/(^|[\\s:!])text-(?!(?:xs|sm|base|lg|xl|[2-9]xl|eyebrow)\\x2f)[a-z][a-z0-9-]*\\x2f[0-9\\[]/]',
          message: 'No alpha on text colour. Use text-text-secondary / text-text-muted / text-text-placeholder / text-graphic-muted (or `// contrast-ok: reason`).',
        },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    plugins: { 'vireek-a11y': vireekA11y },
    rules: {
      'vireek-a11y/no-raw-icon-size': 'error',
      'vireek-a11y/icon-only-name': 'warn', // به 'error' تغییر دهید وقتی ۵۲ مورد اصلاح شد
    },
  },
  {
    // Dashboard guardrails — see docs/design/dashboard-principles.md
    files: [
      'src/pages/DashboardPage.tsx',
      'src/components/overview/**/*.{ts,tsx}',
      'src/pages/{Calls,LiveCalls,Jobs,Customers,Analytics,Billing,Settings}Page.tsx',
    ],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{
          name: 'lucide-react',
          importNames: ['Sparkles', 'Sparkle', 'Bot', 'Brain', 'BrainCircuit', 'Wand2', 'WandSparkles'],
          message: 'No decorative AI icons in the dashboard. Show provenance as text ("Drafted by Sarah").',
        }],
      }],
      'no-restricted-syntax': [
        'warn',
        { selector: "CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/]", message: 'Use formatDate/formatTime/formatDateTime/formatNumber/formatCurrency from @/lib/format (or useFormat()).' },
        { selector: "NewExpression[callee.object.name='Intl'][callee.property.name=/^(NumberFormat|DateTimeFormat|RelativeTimeFormat|ListFormat)$/]", message: 'Do not construct Intl formatters directly. Use the helpers in @/lib/format.' },
        { selector: 'Literal[value=/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\\b/]', message: 'Use a colour token, not a hex literal.' },
        { selector: 'Literal[value=/\\b(?:rgba?|hsla?)\\(\\s*[0-9]/]', message: 'Use rgb(var(--token)) instead of rgb()/hsl() literals.' },
        { selector: 'Literal[value=/bg-gradient-|linear-gradient|radial-gradient|backdrop-blur/]', message: 'No gradients or glass in the dashboard.' },
        { selector: 'TemplateElement[value.raw=/bg-gradient-|linear-gradient|radial-gradient|backdrop-blur/]', message: 'No gradients or glass in the dashboard.' },
        { selector: 'Literal[value=/\\brounded-(2xl|3xl)\\b/]', message: '
Large radii are for modals only (rounded-overlay). Use rounded-control, rounded-inset, rounded-chip or rounded-surface.' },
        { selector: 'TemplateElement[value.raw=/\\brounded-(2xl|3xl)\\b/]', message: '
Large radii are for modals only (rounded-overlay). Use rounded-control, rounded-inset, rounded-chip or rounded-surface.' },
      ],
    },
  },
)
