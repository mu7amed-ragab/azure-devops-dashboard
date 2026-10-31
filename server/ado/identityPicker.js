/**
 * Live directory search, for finding someone who isn't in the cached people
 * list yet (no team, no recent assigned work — see server/ado/people.js).
 *
 * Unlike the WIQL/graph endpoints used elsewhere, IdentityPicker does its
 * own fuzzy matching server-side, so it can find someone by a partial name
 * or email without us pre-loading the whole org. Quirks verified live:
 *   - a query for "أحمد عيسى" (hamza on alef) returns zero results while
 *     "احمد عيسى" (bare alef) finds the exact same person — so hamza forms
 *     must be folded before calling ADO.
 *   - folding alef-maksura to ya ("عيسى" -> "عيسي") *breaks* an otherwise-
 *     matching query, so unlike the client-side matcher in
 *     web/src/lib/personSearch.ts (which compares two strings we control on
 *     both sides and can safely fold every variant), this normalization
 *     stays narrow: hamza + diacritics only.
 *   - many results have a null `mail` with the address only in
 *     `signInAddress`, and a null `localId` (identity not yet materialized
 *     in this org) with only `originId` usable as a fallback id.
 */

const IDENTITY_PICKER_API_VERSION = '5.0-preview.1';

function normalizeArabic(s) {
  return String(s)
    .normalize('NFKC')
    .replace(/[ً-ْـ]/g, '') // diacritics + tatweel
    .replace(/[أإآٱ]/g, 'ا');
}

/** @returns {Promise<Array<{id, displayName, uniqueName}>>} */
async function searchIdentities(client, rawQuery) {
  const query = normalizeArabic(rawQuery).trim();
  if (!query) return [];

  const emailLocalPart = query.includes('@') ? query.split('@')[0] : null;
  const queries = emailLocalPart && emailLocalPart !== query ? [query, emailLocalPart] : [query];

  const url = `https://dev.azure.com/${client.org}/_apis/IdentityPicker/Identities?api-version=${IDENTITY_PICKER_API_VERSION}`;

  const byUniqueName = new Map();
  for (const q of queries) {
    const res = await client.request(url, {
      method: 'POST',
      body: {
        query: q,
        identityTypes: ['user'],
        operationScopes: ['ims', 'source'],
        options: { MinResults: 5, MaxResults: 40 },
        properties: ['DisplayName', 'Mail', 'SignInAddress', 'SamAccountName', 'Active'],
      },
    });

    const identities = (res.results && res.results[0] && res.results[0].identities) || [];
    for (const identity of identities) {
      const uniqueName = identity.mail || identity.signInAddress || identity.samAccountName;
      if (!uniqueName) continue;
      const key = uniqueName.toLowerCase();
      if (byUniqueName.has(key)) continue;
      byUniqueName.set(key, {
        id: identity.localId || identity.originId,
        displayName: identity.displayName,
        uniqueName,
      });
    }
  }

  return [...byUniqueName.values()];
}

/** Everything before the first `@` in an address, lowercased. An address
 * with no `@` at all is its own local part — never throws, never returns
 * null, so callers can always compare two of these directly. */
function localPart(uniqueName) {
  const s = String(uniqueName || '');
  const at = s.indexOf('@');
  return (at === -1 ? s : s.slice(0, at)).toLowerCase();
}

/**
 * 006-linked-identity-aliases: every identity in the organization whose
 * username matches `part` exactly (case-insensitively) — the primary source
 * behind identity-set discovery (server/identitySet.js).
 *
 * `searchIdentities` is a FUZZY directory search: querying it for
 * "alex.k" is expected to also surface "alex.k2@…" or
 * "alex.kali@…", which is exactly why this function exists as a thin,
 * strict filter in front of it rather than trusting the raw result — linking
 * two different people's history together on a loose match would be the
 * feature's whole failure mode (see spec.md FR-004 and its Assumptions).
 *
 * Deliberately org-scoped, like `searchIdentities` itself (see the scoping
 * audit in server/scopes.js) — it confers no project read access, it only
 * names candidate identities.
 */
async function findIdentitiesByLocalPart(client, part) {
  const target = localPart(part);
  if (!target) return [];
  const results = await searchIdentities(client, target);
  return results.filter((identity) => localPart(identity.uniqueName) === target);
}

module.exports = { searchIdentities, normalizeArabic, localPart, findIdentitiesByLocalPart };
