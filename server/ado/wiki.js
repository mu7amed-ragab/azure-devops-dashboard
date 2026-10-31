/**
 * Reads and writes a single page from an Azure DevOps project wiki. Used to
 * source (and, now, durably persist) the org chart that backs the Team
 * page's roles and roster — a roster that can't live in the repo (anyone
 * with the source could edit their way into a role) but also can't be an
 * ADO team (that needs Project Administrator rights, which not everyone
 * running this app will have). A wiki page is writable by any Contributor,
 * and every edit is versioned and attributed in ADO's own history — tamper-
 * evident even though it isn't a hard permission boundary. It's also the
 * only piece of durable storage available on a host with no persistent disk
 * (e.g. Render's free tier) — see server/orgStore.js.
 */

const WIKI_PAGES_API = '7.1-preview.1';

function pageUrl(client, wikiName, pagePath) {
  return (
    `https://dev.azure.com/${client.org}/${encodeURIComponent(client.project)}` +
    `/_apis/wiki/wikis/${encodeURIComponent(wikiName)}/pages` +
    `?path=${encodeURIComponent(pagePath)}&includeContent=true&api-version=${WIKI_PAGES_API}`
  );
}

/** Raw markdown content of a wiki page, or null if the wiki or the page
 * doesn't exist yet (feature simply stays off — never throws for a 404). */
async function fetchWikiPage(client, wikiName, pagePath) {
  try {
    const page = await client.request(pageUrl(client, wikiName, pagePath), { method: 'GET' });
    return typeof page.content === 'string' ? page.content : null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** Same as fetchWikiPage, but also returns the page's ETag — required as
 * If-Match on the next write so a concurrent edit (in the ADO web UI, or
 * another instance of this app) is detected as a conflict (409) instead of
 * silently overwritten. `eTag: null` means the page doesn't exist yet, so
 * the next write should create it rather than update it. */
async function fetchWikiPageWithMeta(client, wikiName, pagePath, { priority = false } = {}) {
  try {
    const res = await client.request(pageUrl(client, wikiName, pagePath), { method: 'GET', rawResponse: true, priority });
    const content = res.data && typeof res.data.content === 'string' ? res.data.content : null;
    return { content, eTag: res.headers.etag || res.headers.ETag || null };
  } catch (err) {
    if (err.status === 404) return { content: null, eTag: null };
    throw err;
  }
}

/** Creates or updates a wiki page's content. `eTag` from the last read —
 * pass null to create a new page. Azure DevOps returns 409 if `eTag` no
 * longer matches the page's current version (someone else edited it since);
 * that propagates as an AdoClient error with `.status === 409`, exactly like
 * a work-item write conflict, and the caller should treat it the same way:
 * re-read and retry, or surface it as a conflict. Returns the new ETag. */
async function putWikiPage(client, wikiName, pagePath, content, eTag, { priority = false } = {}) {
  const url =
    `https://dev.azure.com/${client.org}/${encodeURIComponent(client.project)}` +
    `/_apis/wiki/wikis/${encodeURIComponent(wikiName)}/pages` +
    `?path=${encodeURIComponent(pagePath)}&api-version=${WIKI_PAGES_API}`;
  const res = await client.request(url, {
    method: 'PUT',
    body: { content },
    headers: eTag ? { 'If-Match': eTag } : undefined,
    rawResponse: true,
    priority,
  });
  return res.headers.etag || res.headers.ETag || null;
}

/** True when a wiki named `wikiName` exists in this client's project.
 *
 * Reading the roles page 404s identically whether the PAGE hasn't been created
 * yet (normal, and the next write creates it) or the whole WIKI is missing
 * (nothing can ever be saved until someone creates it in ADO) — this is what
 * tells those two apart, so the Team page can explain the second instead of
 * showing an empty roster and failing on the first save. One extra request,
 * made only when the page came back empty. */
async function wikiExists(client, wikiName) {
  try {
    const res = await client.get('/wiki/wikis');
    const wikis = (res && res.value) || [];
    const target = String(wikiName).toLowerCase();
    return wikis.some((w) => String(w.name).toLowerCase() === target);
  } catch (err) {
    // Can't tell — assume it's there rather than claiming a project is
    // misconfigured on the strength of one failed request.
    return true;
  }
}

module.exports = { fetchWikiPage, fetchWikiPageWithMeta, putWikiPage, wikiExists };
