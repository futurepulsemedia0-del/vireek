// scripts/compliance/collect-github.mjs
//
// GitHub evidence collectors. Read-only REST calls using a fine-grained token.
//
// Honesty rules enforced here:
//  - HTTP 401/403/404 that mean "I may not look" => result "blocked" (never "pass").
//  - Unexpected errors => result "error".
//  - Secret-scanning alerts are reduced to counts by type; the secret value is never read into evidence.
//  - Only whitelisted fields are copied from API responses (no object spreading).

import { PROPOSED_VULN_SLA_DAYS, blockedEnvelope, daysBetween, errorEnvelope, makeEnvelope } from './lib.mjs';

const API = 'https://api.github.com';

/**
 * @param {{ token?: string, fetchImpl?: typeof fetch, apiBase?: string, timeoutMs?: number }} o
 */
export function createGithubClient({ token, fetchImpl = globalThis.fetch, apiBase = API, timeoutMs = 20_000 } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'vireek-compliance-evidence',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  async function once(url) {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const remaining = res.headers?.get?.('x-ratelimit-remaining');
    return {
      ok: res.ok,
      status: res.status,
      body,
      message: res.ok ? '' : String(body?.message ?? res.statusText ?? ''),
      rateLimited: !res.ok && (res.status === 429 || (res.status === 403 && remaining === '0')),
      next: /<([^>]+)>;\s*rel="next"/.exec(res.headers?.get?.('link') ?? '')?.[1] ?? null,
    };
  }

  /**
   * GET a path. With `paginate`, follows rel="next" up to `maxPages` and concatenates
   * either the array body or `body[key]`. Never throws on HTTP errors.
   * @returns {Promise<{ok:boolean,status:number,data:any,message:string,rateLimited:boolean,truncated:boolean}>}
   */
  async function request(path, { query, paginate = false, maxPages = 5, key } = {}) {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    let url = `${apiBase}${path}${qs}`;
    if (!paginate) {
      const r = await once(url);
      return { ok: r.ok, status: r.status, data: r.body, message: r.message, rateLimited: r.rateLimited, truncated: false };
    }
    const out = [];
    let pages = 0;
    let last = null;
    while (url && pages < maxPages) {
      last = await once(url);
      pages++;
      if (!last.ok) return { ok: false, status: last.status, data: null, message: last.message, rateLimited: last.rateLimited, truncated: false };
      const chunk = key ? last.body?.[key] : last.body;
      if (Array.isArray(chunk)) out.push(...chunk);
      url = last.next;
    }
    return { ok: true, status: 200, data: out, message: '', rateLimited: false, truncated: Boolean(url) };
  }

  return { request, hasToken: Boolean(token) };
}

/** Run `fn` over `items` with bounded concurrency, preserving order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** 401/403/404 mean "not permitted / not enabled" — not evidence of anything. */
const isBlocked = (r) => !r.ok && !r.rateLimited && [401, 403, 404].includes(r.status);

// ---------------------------------------------------------------- branch protection

export async function collectBranchProtection({ client, repo, branch, now, runRef }) {
  const prot = await client.request(`/repos/${repo}/branches/${branch}/protection`);
  const rules = await client.request(`/repos/${repo}/rules/branches/${branch}`);
  if (prot.rateLimited || rules.rateLimited) throw new Error('GitHub API rate limit reached');

  const notProtected = prot.status === 404 && /branch not protected/i.test(prot.message);
  const protectionKnown = prot.ok || notProtected;
  const rulesOk = rules.ok && Array.isArray(rules.data);
  const rulePr = rulesOk ? rules.data.find((r) => r.type === 'pull_request') : undefined;

  if (!protectionKnown && !(rulesOk && rulePr)) {
    return blockedEnvelope('github.branch_protection', 'Token cannot read branch protection (needs repository Administration: read) and no readable ruleset requires pull requests.', {
      protectionStatus: prot.status,
      rulesStatus: rules.status,
      collectedAt: now,
      runRef,
    });
  }

  const p = prot.ok ? prot.data : {};
  const protApprovals = p?.required_pull_request_reviews?.required_approving_review_count ?? 0;
  const ruleApprovals = rulePr?.parameters?.required_approving_review_count ?? 0;
  const requiresPr = Boolean(p?.required_pull_request_reviews) || Boolean(rulePr);
  const approvals = Math.max(protApprovals, ruleApprovals);
  const blocksForcePush = (prot.ok && p?.allow_force_pushes?.enabled === false) || (rulesOk && rules.data.some((r) => r.type === 'non_fast_forward'));
  const statusChecks = Boolean(p?.required_status_checks) || (rulesOk && rules.data.some((r) => r.type === 'required_status_checks'));
  const ok = requiresPr && approvals >= 1 && blocksForcePush;

  return makeEnvelope({
    collector: 'github.branch_protection',
    result: 'collected',
    outcome: ok ? 'pass' : 'fail',
    summary: {
      branch,
      branchProtected: prot.ok || rulesOk,
      requiresPullRequest: requiresPr,
      requiredApprovals: approvals,
      blocksForcePush,
      requiresStatusChecks: statusChecks,
      enforceAdmins: p?.enforce_admins?.enabled ?? null,
      requiresCodeOwnerReview: p?.required_pull_request_reviews?.require_code_owner_reviews ?? null,
      protectionReadable: protectionKnown,
      rulesetsReadable: rulesOk,
    },
    data: {},
    collectedAt: now,
    runRef,
  });
}

// ---------------------------------------------------------------- pull requests

/** Latest decisive review per reviewer; approvals by the author do not count. */
export function independentApprovers(reviews, authorLogin) {
  const latest = new Map();
  for (const r of reviews) {
    const login = r.user?.login;
    if (!login) continue;
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) latest.set(login.toLowerCase(), r.state);
  }
  const author = String(authorLogin ?? '').toLowerCase();
  return [...latest].filter(([login, state]) => state === 'APPROVED' && login !== author).map(([login]) => login);
}

export async function collectPullRequests({ client, repo, branch, now, windowDays = 30, maxCommitChecks = 100, runRef }) {
  const since = new Date(now.getTime() - windowDays * 86_400_000);
  const prsRes = await client.request(`/repos/${repo}/pulls`, {
    paginate: true,
    maxPages: 5,
    query: { state: 'closed', base: branch, sort: 'updated', direction: 'desc', per_page: '100' },
  });
  if (prsRes.rateLimited) throw new Error('GitHub API rate limit reached');
  if (isBlocked(prsRes)) return blockedEnvelope('github.pull_requests', `Cannot list pull requests (HTTP ${prsRes.status}).`, { collectedAt: now, runRef });
  if (!prsRes.ok) throw new Error(`list pulls failed: HTTP ${prsRes.status} ${prsRes.message}`);

  const merged = prsRes.data.filter((pr) => pr.merged_at && new Date(pr.merged_at) >= since);
  const reviewResults = await mapLimit(merged, 5, async (pr) => {
    const r = await client.request(`/repos/${repo}/pulls/${pr.number}/reviews`, { paginate: true, maxPages: 3 });
    return { pr, r };
  });
  const failed = reviewResults.find(({ r }) => !r.ok);
  if (failed) {
    if (failed.r.rateLimited) throw new Error('GitHub API rate limit reached');
    if (isBlocked(failed.r)) return blockedEnvelope('github.pull_requests', `Cannot read PR reviews (HTTP ${failed.r.status}).`, { collectedAt: now, runRef });
    throw new Error(`reviews failed: HTTP ${failed.r.status}`);
  }

  const rows = reviewResults.map(({ pr, r }) => {
    const approvers = independentApprovers(r.data, pr.user?.login);
    return { number: pr.number, author: pr.user?.login ?? null, mergedAt: pr.merged_at, independentApprovals: approvers.length, approvers };
  });
  const withoutApproval = rows.filter((x) => x.independentApprovals === 0);

  // Commits on the branch that are not associated with any PR (direct pushes).
  const commitsRes = await client.request(`/repos/${repo}/commits`, {
    paginate: true,
    maxPages: 3,
    query: { sha: branch, since: since.toISOString(), per_page: '100' },
  });
  let direct = [];
  let checked = 0;
  let commitsTruncated = false;
  if (commitsRes.ok) {
    const commits = commitsRes.data.slice(0, maxCommitChecks);
    commitsTruncated = commitsRes.data.length > maxCommitChecks || commitsRes.truncated;
    const checks = await mapLimit(commits, 5, async (c) => ({ c, r: await client.request(`/repos/${repo}/commits/${c.sha}/pulls`) }));
    for (const { c, r } of checks) {
      if (!r.ok) continue;
      checked++;
      if (Array.isArray(r.data) && r.data.length === 0) direct.push({ sha: String(c.sha).slice(0, 12), author: c.author?.login ?? null, date: c.commit?.author?.date ?? null });
    }
  }
  const directKnown = commitsRes.ok;
  const outcome = merged.length === 0 && direct.length === 0 ? 'info' : withoutApproval.length === 0 && direct.length === 0 ? 'pass' : 'fail';

  return makeEnvelope({
    collector: 'github.pull_requests',
    result: 'collected',
    outcome,
    summary: {
      windowDays,
      mergedPullRequests: merged.length,
      withIndependentApproval: merged.length - withoutApproval.length,
      withoutIndependentApproval: withoutApproval.length,
      commitsCheckedForDirectPush: checked,
      commitsWithoutPullRequest: direct.length,
      directPushCheckAvailable: directKnown,
      truncated: Boolean(prsRes.truncated || commitsTruncated),
    },
    data: { mergedWithoutApproval: withoutApproval.slice(0, 100), commitsWithoutPullRequest: direct.slice(0, 100), pullRequests: rows.slice(0, 200) },
    collectedAt: now,
    runRef,
  });
}

// ---------------------------------------------------------------- workflow runs

export const DEFAULT_WORKFLOWS = ['ci.yml', 'security.yml', 'quality-gates.yml', 'edge-functions.yml', 'migrations.yml', 'database-tests.yml'];

export async function collectWorkflowRuns({ client, repo, branch, now, windowDays = 30, workflows = DEFAULT_WORKFLOWS, securityMaxAgeDays = 8, runRef }) {
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString().slice(0, 10);
  const by = {};
  for (const file of workflows) {
    const res = await client.request(`/repos/${repo}/actions/workflows/${file}/runs`, {
      paginate: true,
      key: 'workflow_runs',
      maxPages: 3,
      query: { branch, status: 'completed', per_page: '100', created: `>=${since}` },
    });
    if (res.rateLimited) throw new Error('GitHub API rate limit reached');
    if (res.status === 404) {
      by[file] = { exists: false };
      continue;
    }
    if (isBlocked(res)) return blockedEnvelope('github.workflow_runs', `Cannot read workflow runs (HTTP ${res.status}).`, { collectedAt: now, runRef });
    if (!res.ok) throw new Error(`workflow runs failed for ${file}: HTTP ${res.status}`);
    const runs = [...res.data].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const decisive = runs.find((r) => r.conclusion === 'success' || r.conclusion === 'failure');
    const lastSuccess = runs.find((r) => r.conclusion === 'success');
    by[file] = {
      exists: true,
      total: runs.length,
      success: runs.filter((r) => r.conclusion === 'success').length,
      failure: runs.filter((r) => r.conclusion === 'failure').length,
      cancelled: runs.filter((r) => r.conclusion === 'cancelled').length,
      lastConclusion: decisive?.conclusion ?? null,
      lastRunAt: runs[0]?.created_at ?? null,
      lastSuccessAt: lastSuccess?.created_at ?? null,
      truncated: res.truncated,
    };
  }
  const sec = by['security.yml'];
  const securityFresh = Boolean(sec?.exists && sec.lastSuccessAt && daysBetween(sec.lastSuccessAt, now) <= securityMaxAgeDays);
  const anyLatestFailed = Object.entries(by).filter(([, v]) => v.exists).filter(([, v]) => v.lastConclusion === 'failure').map(([k]) => k);
  const outcome = securityFresh && anyLatestFailed.length === 0 ? 'pass' : 'fail';
  return makeEnvelope({
    collector: 'github.workflow_runs',
    result: 'collected',
    outcome,
    summary: { branch, windowDays, securityWorkflowSucceededWithinDays: securityFresh ? securityMaxAgeDays : null, latestRunFailed: anyLatestFailed },
    data: { workflows: by },
    collectedAt: now,
    runRef,
  });
}

// ---------------------------------------------------------------- alerts

function summariseAlerts(alerts, severityOf, now) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  const pastSla = { critical: 0, high: 0, medium: 0, low: 0 };
  let oldestDays = 0;
  for (const a of alerts) {
    const sev = severityOf(a);
    const key = sev in counts ? sev : 'unknown';
    counts[key]++;
    const age = daysBetween(a.created_at, now);
    oldestDays = Math.max(oldestDays, age);
    if (key !== 'unknown' && age > PROPOSED_VULN_SLA_DAYS[key]) pastSla[key]++;
  }
  return { counts, pastSla, oldestOpenDays: oldestDays };
}

async function collectAlerts({ collector, path, query, severityOf, pick, client, now, runRef, noAnalysisIsFail = false }) {
  const res = await client.request(path, { paginate: true, maxPages: 5, query: { state: 'open', per_page: '100', ...query } });
  if (res.rateLimited) throw new Error('GitHub API rate limit reached');
  if (noAnalysisIsFail && res.status === 404 && /no analysis found/i.test(res.message)) {
    return makeEnvelope({ collector, result: 'collected', outcome: 'fail', summary: { reason: 'no_analysis_found' }, collectedAt: now, runRef });
  }
  if (isBlocked(res)) return blockedEnvelope(collector, `Alerts unavailable (HTTP ${res.status}): ${res.message.slice(0, 160)}`, { collectedAt: now, runRef });
  if (!res.ok) throw new Error(`${collector}: HTTP ${res.status} ${res.message}`);
  const stats = summariseAlerts(res.data, severityOf, now);
  const bad = stats.pastSla.critical + stats.pastSla.high > 0;
  return makeEnvelope({
    collector,
    result: 'collected',
    outcome: bad ? 'fail' : 'pass',
    summary: { openAlerts: res.data.length, truncated: res.truncated, ...stats, slaDaysUsed: PROPOSED_VULN_SLA_DAYS, slaNote: 'DRAFT policy thresholds; only critical/high past SLA fail the control' },
    data: { alerts: res.data.slice(0, 200).map(pick) },
    collectedAt: now,
    runRef,
  });
}

export const collectCodeScanning = (o) =>
  collectAlerts({
    ...o,
    collector: 'github.code_scanning',
    path: `/repos/${o.repo}/code-scanning/alerts`,
    noAnalysisIsFail: true,
    severityOf: (a) => a.rule?.security_severity_level ?? ({ error: 'high', warning: 'medium', note: 'low' }[a.rule?.severity] ?? 'unknown'),
    pick: (a) => ({ number: a.number, createdAt: a.created_at, rule: a.rule?.id ?? null, severity: a.rule?.security_severity_level ?? a.rule?.severity ?? null }),
  });

export const collectDependabot = (o) =>
  collectAlerts({
    ...o,
    collector: 'github.dependabot',
    path: `/repos/${o.repo}/dependabot/alerts`,
    severityOf: (a) => a.security_advisory?.severity ?? 'unknown',
    pick: (a) => ({ number: a.number, createdAt: a.created_at, package: a.dependency?.package?.name ?? null, severity: a.security_advisory?.severity ?? null }),
  });

/** Never copies `secret`, `locations` or any value from the alert — only type, number, age. */
export const collectSecretScanning = async (o) => {
  const res = await o.client.request(`/repos/${o.repo}/secret-scanning/alerts`, { paginate: true, maxPages: 5, query: { state: 'open', per_page: '100' } });
  if (res.rateLimited) throw new Error('GitHub API rate limit reached');
  if (isBlocked(res)) {
    return blockedEnvelope('github.secret_scanning', `Secret scanning unavailable (HTTP ${res.status}): ${res.message.slice(0, 160)}`, { collectedAt: o.now, runRef: o.runRef });
  }
  if (!res.ok) throw new Error(`github.secret_scanning: HTTP ${res.status} ${res.message}`);
  const typeCounts = new Map();
  let oldest = 0;
  for (const a of res.data) {
    const t = String(a.secret_type ?? 'unknown');
    typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    oldest = Math.max(oldest, daysBetween(a.created_at, o.now));
  }
  // Array of {type,count}: secret TYPE names are values here, so credential-name scrubbing cannot drop them.
  const byType = [...typeCounts].map(([type, count]) => ({ type, count })).sort((x, y) => y.count - x.count);
  return makeEnvelope({
    collector: 'github.secret_scanning',
    result: 'collected',
    outcome: res.data.length === 0 ? 'pass' : 'fail',
    summary: { openAlerts: res.data.length, truncated: res.truncated, byType, oldestOpenDays: oldest },
    data: {},
    collectedAt: o.now,
    runRef: o.runRef,
  });
};

export const GITHUB_COLLECTORS = {
  'github.branch_protection': collectBranchProtection,
  'github.pull_requests': collectPullRequests,
  'github.workflow_runs': collectWorkflowRuns,
  'github.code_scanning': collectCodeScanning,
  'github.dependabot': collectDependabot,
  'github.secret_scanning': collectSecretScanning,
};

/**
 * Runs all GitHub collectors. Without a token every collector reports "blocked"
 * (never silently skipped, never a pass).
 */
export async function collectGithub({ client, repo, branch = 'main', now = new Date(), windowDays = 30, runRef, only } = {}) {
  const ids = Object.keys(GITHUB_COLLECTORS).filter((id) => !only || only.includes(id));
  const envelopes = [];
  for (const id of ids) {
    if (!client?.hasToken || !repo) {
      envelopes.push(blockedEnvelope(id, !repo ? 'GITHUB_REPOSITORY not set' : 'COMPLIANCE_GITHUB_TOKEN not set', { collectedAt: now, runRef }));
      continue;
    }
    try {
      envelopes.push(await GITHUB_COLLECTORS[id]({ client, repo, branch, now, windowDays, runRef }));
    } catch (e) {
      envelopes.push(errorEnvelope(id, e, { collectedAt: now, runRef }));
    }
  }
  return envelopes;
}
