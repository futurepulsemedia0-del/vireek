// Run: node --test eslint-rules/vireek-img.test.mjs   (needs eslint installed)
import { RuleTester } from 'eslint'
import { test } from 'node:test'
import plugin from './vireek-img.mjs'

const tester = new RuleTester({ languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } })
test('vireek-img/policy', () => {
  tester.run('policy', plugin.rules.policy, {
    valid: [
      '<img src="/a.png" alt="A" width={10} height={10} loading="lazy" decoding="async" />',
      '<img src="/a.png" alt="A" className="aspect-video" loading="lazy" decoding="async" />',
      '<img src="/a.png" alt="A" fetchPriority="high" loading="eager" decoding="async" width={1} height={1} />',
      '<div className="aspect-square"><img src={u} alt="" className="h-full w-full" loading="lazy" decoding="async" /></div>',
      '<img {...props} />',
    ],
    invalid: [
      { code: '<img src="/a.png" alt="A" width={1} height={1} decoding="async" />', errors: [{ messageId: 'loading' }] },
      { code: '<img src="/a.png" alt="A" loading="lazy" decoding="async" />', errors: [{ messageId: 'dims' }] },
      { code: '<img src="/a.png" alt="A" width={1} height={1} loading="lazy" />', errors: [{ messageId: 'decoding' }] },
      { code: '<img src="/a.png" alt="A" width={1} height={1} loading="lazy" fetchPriority="high" decoding="async" />', errors: [{ messageId: 'lcp' }] },
      { code: '<img src={u} alt="" className="h-full w-full" loading="lazy" decoding="async" />', errors: [{ messageId: 'dims' }] },
    ],
  })
})
