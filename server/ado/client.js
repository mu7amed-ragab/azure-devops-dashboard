const { request } = require('undici');

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 500;

// Azure DevOps throttles per identity (the PAT), and every call in this app
// goes out under the one PAT — so all load from every sync, every write, and
// every background poll shares a single budget. These are module-level
// (not per-AdoClient-instance) so that budget is actually shared.
const MAX_IN_FLIGHT = Number(process.env.ADO_MAX_CONCURRENCY) || 6;
// Below this fraction of X-RateLimit-Limit remaining, proactively slow down
// before ADO starts delaying responses itself.
const PROACTIVE_THRESHOLD = 0.2;
const PROACTIVE_PAUSE_MS = 300;

let inFlight = 0;
const waiters = [];

// Most callers are background dashboard syncs — the user isn't watching a
// spinner for them. A `priority` request (e.g. the Manage Team modal's
// wiki reload) jumps straight to the front of the wait line instead of
// queuing behind however many sync calls got there first, so an admin
// screen someone is actively staring at doesn't starve behind a stack of
// background revalidation work sharing the same per-PAT budget.
function acquireSlot(priority = false) {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    if (priority) waiters.unshift(resolve);
    else waiters.push(resolve);
  });
}

function releaseSlot() {
  const next = waiters.shift();
  if (next) {
    next();
  } else {
    inFlight -= 1;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Demo mode answers every Azure DevOps call in-process (server/demo/transport.js)
// instead of over the network. It is installed once for the whole process, not
// chosen per client, so no client built later — from any config, on any error
// path — can quietly fall back to the network. Every real network call is
// counted, and a demo process expects that count to stay at zero.
let demoTransport = null;
let realRequestCount = 0;

function installDemoTransport(fn) {
  if (demoTransport === fn) return;
  if (demoTransport) throw new Error('A different demo transport is already installed');
  demoTransport = fn;
}

/** Only the offline test fixtures call this, so demo suites can't leave the
 * transport installed for the suites that run after them in the same process. */
function resetTransportForTests() {
  demoTransport = null;
}

function getRealRequestCount() {
  return realRequestCount;
}

// Shared rate-limit gate: every request awaits this before its first
// attempt. ADO's pre-429 stage returns 200 but sets X-RateLimit-Delay to say
// it already slowed this request down — that's the signal we're missing if
// we only react to a hard 429. Pausing here means every in-flight and
// queued caller backs off together, not just whichever one got the header.
let gateUntil = 0;
let gatePromise = Promise.resolve();
let warnedThisPause = false;

function pauseFor(ms, reason) {
  const until = Date.now() + ms;
  if (until <= gateUntil) return; // never shorten an existing longer pause
  gateUntil = until;
  if (!warnedThisPause) {
    warnedThisPause = true;
    // eslint-disable-next-line no-console
    console.warn(`[ado] throttled by Azure DevOps (${reason}), pausing ${Math.ceil(ms / 1000)}s`);
  }
  gatePromise = (async () => {
    while (Date.now() < gateUntil) {
      await sleep(gateUntil - Date.now());
    }
    warnedThisPause = false;
  })();
}

async function awaitGate() {
  // Loop because a new, longer pause can be scheduled by a concurrent
  // response while we were already waiting on the previous one.
  while (Date.now() < gateUntil) {
    await gatePromise;
  }
}

function inspectRateLimitHeaders(headers) {
  const delay = Number(headers['x-ratelimit-delay']);
  if (Number.isFinite(delay) && delay > 0) {
    pauseFor(delay * 1000, 'X-RateLimit-Delay');
    return;
  }
  const remaining = Number(headers['x-ratelimit-remaining']);
  const limit = Number(headers['x-ratelimit-limit']);
  if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0 && remaining / limit < PROACTIVE_THRESHOLD) {
    pauseFor(PROACTIVE_PAUSE_MS, 'low X-RateLimit-Remaining');
  }
}

/** Error with an HTTP status attached so callers can branch on it (e.g. 409
 * conflict on a concurrent write vs. a generic failure). */
function adoError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Thin wrapper around undici for Azure DevOps REST calls:
 * - Basic auth from the PAT (never logged, never sent to the browser)
 * - 429 / 5xx retry with exponential backoff, honoring Retry-After
 * - A shared rate-limit gate across ALL AdoClient instances/calls, driven by
 *   ADO's X-RateLimit-Delay/Remaining headers, not just hard 429s
 * - A shared in-flight semaphore (ADO_MAX_CONCURRENCY, default 6) so no
 *   burst of concurrent syncs/writes can overwhelm the per-identity budget
 * - JSON in/out; also supports JSON Patch (application/json-patch+json) for writes
 */
class AdoClient {
  constructor(config) {
    this.org = config.org;
    this.project = config.project;
    this.apiVersion = config.apiVersion;
    this.authHeader = 'Basic ' + Buffer.from(':' + config.pat).toString('base64');
    if (config.demo === true && !demoTransport) throw new Error('Demo config without a demo transport');
    if (demoTransport && config.demo !== true) throw new Error('Real AdoClient constructed in a demo process');
    this.transport = demoTransport || request;
  }

  /**
   * @param {string} url - absolute URL or path starting with '/'
   * @param {object} opts - { method, body, contentType, headers, rawResponse }
   *   `headers` are merged in as-is (e.g. If-Match for optimistic concurrency
   *   on wiki page writes). `rawResponse: true` resolves with
   *   `{ data, headers, status }` instead of just the parsed body — needed
   *   by callers that must read a response header (e.g. the wiki page's
   *   ETag) rather than only its JSON.
   */
  async request(url, opts = {}) {
    const { method = 'GET', body, contentType = 'application/json', headers: extraHeaders, rawResponse = false, priority = false } = opts;
    let attempt = 0;

    await acquireSlot(priority);
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        attempt += 1;
        await awaitGate();

        let res;
        try {
          if (this.transport === request) realRequestCount += 1;
          res = await this.transport(url, {
            method,
            headers: {
              authorization: this.authHeader,
              accept: 'application/json',
              ...(body ? { 'content-type': contentType } : {}),
              ...extraHeaders,
            },
            body: body ? JSON.stringify(body) : undefined,
          });
        } catch (err) {
          if (attempt > MAX_RETRIES) throw err;
          await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
          continue;
        }

        inspectRateLimitHeaders(res.headers);

        if (res.statusCode === 429 || res.statusCode >= 500) {
          if (attempt > MAX_RETRIES) {
            const text = await res.body.text();
            throw adoError(`ADO request failed after ${attempt} attempts: ${res.statusCode} ${text}`.slice(0, 500), res.statusCode);
          }
          const retryAfter = Number(res.headers['retry-after']);
          const delay = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : BASE_DELAY_MS * 2 ** (attempt - 1);
          if (res.statusCode === 429) pauseFor(delay, '429');
          await res.body.text(); // drain
          await sleep(delay);
          continue;
        }

        if (res.statusCode === 401 || res.statusCode === 403) {
          const text = await res.body.text();
          throw adoError(
            `Azure DevOps rejected the request (${res.statusCode}). The token in use may be expired or missing scopes. ${text}`.slice(0, 500),
            res.statusCode
          );
        }

        if (res.statusCode === 409) {
          const text = await res.body.text();
          throw adoError(
            `Azure DevOps rejected the write because the item changed since it was last read (409 conflict). ${text}`.slice(0, 500),
            409
          );
        }

        if (res.statusCode >= 400) {
          const text = await res.body.text();
          throw adoError(`ADO request failed: ${res.statusCode} ${method} ${url} — ${text}`.slice(0, 800), res.statusCode);
        }

        const text = await res.body.text();
        let data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (err) {
            // A 2xx that isn't JSON usually means ADO_ORG/ADO_PROJECT is wrong
            // and dev.azure.com served an HTML page instead of the API response.
            throw adoError(
              `Azure DevOps returned a non-JSON response for ${method} ${url}. ` +
                `This usually means the configured organization or project name is wrong.`,
              res.statusCode
            );
          }
        }
        if (rawResponse) return { data, headers: res.headers, status: res.statusCode };
        return data;
      }
    } finally {
      releaseSlot();
    }
  }

  /** Build a project-scoped API URL: /_apis/{path}. The project name is
   * encoded (as server/ado/wiki.js has always done) because it no longer comes
   * from a hand-typed .env value — it's whatever the sign-in project list
   * returned, and ADO project names may contain spaces. */
  projectUrl(apiPath, query = {}) {
    return this._buildUrl(`https://dev.azure.com/${this.org}/${encodeURIComponent(this.project)}/_apis${apiPath}`, query);
  }

  /** Build an org-scoped API URL (e.g. pull requests across all repos) */
  orgUrl(apiPath, query = {}) {
    return this._buildUrl(`https://dev.azure.com/${this.org}/_apis${apiPath}`, query);
  }

  _buildUrl(base, query) {
    const url = new URL(base);
    url.searchParams.set('api-version', this.apiVersion);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    }
    return url.toString();
  }

  get(apiPath, { query, org = false, priority = false } = {}) {
    const url = org ? this.orgUrl(apiPath, query) : this.projectUrl(apiPath, query);
    return this.request(url, { method: 'GET', priority });
  }

  post(apiPath, body, { query, org = false, priority = false } = {}) {
    const url = org ? this.orgUrl(apiPath, query) : this.projectUrl(apiPath, query);
    return this.request(url, { method: 'POST', body, priority });
  }

  /** JSON Patch write (work item updates use this content type, not plain JSON). */
  patch(apiPath, patchDocument, { query, org = false } = {}) {
    const url = org ? this.orgUrl(apiPath, query) : this.projectUrl(apiPath, query);
    return this.request(url, { method: 'PATCH', body: patchDocument, contentType: 'application/json-patch+json' });
  }
}

module.exports = { AdoClient, installDemoTransport, resetTransportForTests, getRealRequestCount };
