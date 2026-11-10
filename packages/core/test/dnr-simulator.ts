/**
 * Executable model of Chromium's declarativeNetRequest behaviour, shared by
 * the unit tests and the e2e suite (which checks it against real Chromium).
 */
import { domainMatches, type DnrRule } from '../src/index.js';

export function applyRedirect(rule: DnrRule, url: string): string {
  if (rule.action.type !== 'redirect') return url;
  const redirect = rule.action.redirect;
  if ('regexSubstitution' in redirect) {
    const re = new RegExp(rule.condition.regexFilter!, rule.condition.isUrlFilterCaseSensitive === false ? 'i' : '');
    // RE2 substitutes an unmatched group with the empty string, like JS does.
    return url.replace(re, redirect.regexSubstitution.replace(/\\(\d)/g, '$$$1'));
  }
  const remove = new Set(redirect.transform.queryTransform.removeParams);
  const hashIdx = url.indexOf('#');
  const fragment = hashIdx === -1 ? '' : url.slice(hashIdx);
  const base = hashIdx === -1 ? url : url.slice(0, hashIdx);
  const qIdx = base.indexOf('?');
  if (qIdx === -1) return url;
  const segments = base.slice(qIdx + 1).split('&');
  // Chromium's query parser ignores the empty segment after a trailing '&'.
  if (segments.length > 1 && segments[segments.length - 1] === '') segments.pop();
  const kept = segments.filter((seg) => !remove.has(seg.split('=')[0]!));
  if (kept.length === segments.length) return url; // no-op (Chromium skips it)
  // Chromium re-serialises the query: valueless keys gain '=', empty segments become '='.
  const reserialised = kept.map((seg) => (seg.includes('=') ? seg : `${seg}=`));
  return base.slice(0, qIdx) + (reserialised.length ? `?${reserialised.join('&')}` : '') + fragment;
}

/**
 * Model of Chromium's DNR evaluation for main_frame requests (verified
 * against Chromium 153 in the e2e suite and with testMatchOutcome):
 * - URL-pattern rules and regex rules are matched separately; each kind
 *   contributes only its highest-priority matching rule (`allow` beats
 *   `redirect` at equal priority);
 * - the higher-priority candidate is applied first; a redirect whose result
 *   equals the request URL is skipped and the other kind's candidate is tried;
 * - an `allow` stops evaluation; every redirect starts a new request (max 20);
 * - the URL matched by rules includes the fragment.
 */
export function simulate(rules: DnrRule[], input: string): string {
  const best = (rs: DnrRule[]) => rs.sort((a, b) => b.priority - a.priority || (a.action.type === 'allow' ? -1 : 1))[0];
  let url = input;
  for (let hop = 0; hop < 20; hop++) {
    const host = new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
    const matching = rules.filter((r) => {
      const c = r.condition;
      if (c.requestDomains && !c.requestDomains.some((d) => domainMatches(host, d))) return false;
      if (c.regexFilter && !new RegExp(c.regexFilter, c.isUrlFilterCaseSensitive === false ? 'i' : '').test(url))
        return false;
      return true;
    });
    const candidates = [
      best(matching.filter((r) => r.condition.regexFilter === undefined)),
      best(matching.filter((r) => r.condition.regexFilter !== undefined)),
    ]
      .filter((r): r is DnrRule => r !== undefined)
      .sort((a, b) => b.priority - a.priority || (a.action.type === 'allow' ? -1 : 1));
    let next = url;
    for (const rule of candidates) {
      if (rule.action.type === 'allow') break;
      next = applyRedirect(rule, url);
      if (next !== url) break;
    }
    if (next === url) return url;
    url = next;
  }
  throw new Error('redirect limit exceeded');
}
