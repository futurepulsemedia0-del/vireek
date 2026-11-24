// Run: node --test scripts/dark-patterns.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCancelObstruction, checkConfirmshaming, checkFalseUrgency, checkPreChecked, checkStructure, isFlowFile, scanFiles } from './lib/darkPatterns.mjs';

const f = (path, text) => ({ path, text });
const rules = (xs) => xs.map((x) => x.rule);

test('DP-01 pre-checked: flags defaultChecked, checked={true} and checked bound to useState(true) in flow files', () => {
  assert.deepEqual(rules(checkPreChecked(f('src/pages/SignupPage.tsx', '<input type="checkbox" defaultChecked />'))), ['DP-01']);
  assert.deepEqual(rules(checkPreChecked(f('src/pages/SignupPage.tsx', '<Checkbox label="x" checked={true} />'))), ['DP-01']);
  const bound = `const [addon, setAddon] = useState(true);\n<input type="checkbox" checked={addon} onChange={() => {}} />`;
  assert.deepEqual(rules(checkPreChecked(f('src/components/billing/X.tsx', bound))), ['DP-01']);
});
test('DP-01: unchecked, and ordinary settings toggles outside flows, are fine', () => {
  assert.deepEqual(checkPreChecked(f('src/pages/SignupPage.tsx', 'const [agree, setAgree] = useState(false);\n<input type="checkbox" checked={agree} />')), []);
  assert.deepEqual(checkPreChecked(f('src/pages/SomeSettingsPage.tsx', 'const [enabled, setEnabled] = useState(true);\n<Switch checked={enabled} />')), []);
});
test('DP-01: sensitive option names are flagged even outside flow files', () => {
  const t = 'const [marketingOptIn, setM] = useState(true);\n<Checkbox checked={marketingOptIn} />';
  assert.deepEqual(rules(checkPreChecked(f('src/pages/SomePage.tsx', t))), ['DP-01']);
});
test('DP-01: test files are ignored', () => {
  assert.deepEqual(checkPreChecked(f('src/pages/SignupPage.test.tsx', '<input type="checkbox" defaultChecked />')), []);
});

test('DP-02 confirmshaming: catches guilt-trip decline labels, allows neutral ones', () => {
  for (const bad of ["No thanks, I don't want to save money", 'I would rather pay full price', "I'll miss out", 'No, I do not care', 'No thanks, I hate growing my business']) {
    assert.equal(checkConfirmshaming(f('src/locales/x/en.json', `"decline": "${bad}"`)).length > 0, true, bad);
  }
  for (const ok of ['No thanks', 'Not now', 'No, I do not want this', 'No thanks, continue to cancel', 'Skip and cancel now', 'Keep my subscription']) {
    assert.deepEqual(checkConfirmshaming(f('src/pages/P.tsx', `<Button>${ok}</Button>`)), [], ok);
  }
});

test('DP-03 cancel obstruction: "contact support to cancel" is flagged, self-serve wording is not', () => {
  for (const bad of ['To cancel a paid subscription, contact support.', 'Please email support to cancel your plan', 'Call us during business hours to cancel', 'Cancellation is only available by phone']) {
    assert.equal(checkCancelObstruction(f('src/pages/BillingPlansPage.tsx', bad)).length > 0, true, bad);
  }
  assert.deepEqual(checkCancelObstruction(f('src/pages/BillingPage.tsx', 'Cancel subscription. Questions? Contact support.')), []);
});

test('DP-04 false urgency: only in flow files, and real dated deadlines are fine', () => {
  assert.equal(checkFalseUrgency(f('src/components/UpgradeBanner.tsx', 'Limited time offer! Only 3 spots left')).length, 2);
  assert.deepEqual(checkFalseUrgency(f('src/components/UpgradeBanner.tsx', 'Your trial ends on 12 December')), []);
  assert.deepEqual(checkFalseUrgency(f('src/pages/ManifestoPage.tsx', 'Hurry up and read')), []);
});

test('DP-03/05/06 structure: cancel reachable, survey optional, at most 3 steps, terms unchecked', () => {
  const ok = [
    f('src/pages/BillingPage.tsx', "navigate('/dashboard/billing/cancel')"),
    f('src/pages/BillingPlansPage.tsx', '<Link to="/dashboard/billing/cancel">'),
    f('src/pages/CancelSubscriptionPage.tsx', "type Step = 'survey' | 'alternatives' | 'confirm';\n(optional) Skip and cancel now"),
    f('src/pages/SignupPage.tsx', 'const [agreeTerms, setAgreeTerms] = useState(false);'),
  ];
  assert.deepEqual(checkStructure(ok), []);
  const bad = [
    f('src/pages/BillingPage.tsx', 'no link'),
    f('src/pages/BillingPlansPage.tsx', 'no link'),
    f('src/pages/CancelSubscriptionPage.tsx', "type Step = 'a' | 'b' | 'c' | 'd';\n<span className=\"ml-0.5 text-danger\">*</span> reasonError"),
    f('src/pages/SignupPage.tsx', 'const [agreeTerms, setAgreeTerms] = useState(true);'),
  ];
  const got = rules(checkStructure(bad)).sort();
  assert.deepEqual(got, ['DP-01', 'DP-03', 'DP-03', 'DP-05', 'DP-05', 'DP-05', 'DP-06']);
});

test('allowlist suppresses only the matching finding', () => {
  const file = f('src/components/billing/X.tsx', 'const [addon, setAddon] = useState(true);\n<Checkbox checked={addon} />');
  assert.equal(scanFiles([file]).findings.length, 1);
  const allow = [{ rule: 'DP-01', path: 'src/components/billing/X.tsx', match: 'addon', reason: 'x'.repeat(30) }];
  assert.equal(scanFiles([file], allow).findings.length, 0);
  assert.equal(scanFiles([file], [{ ...allow[0], path: 'src/other.tsx' }]).findings.length, 1);
});

test('flow file matcher covers the intended surfaces', () => {
  for (const p of ['src/pages/SignupPage.tsx', 'src/pages/CancelSubscriptionPage.tsx', 'src/components/billing/SaveOffersStep.tsx', 'src/components/TrialBanner.tsx', 'src/i18n/churnSaveNamespace.ts']) assert.equal(isFlowFile(p), true, p);
  assert.equal(isFlowFile('src/pages/JobsPage.tsx'), false);
});
