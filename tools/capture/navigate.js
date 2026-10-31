/**
 * Where the capture tool may go: every URL it opens carries presentation=1
 * (hides the demo badge), it refuses the real app's origins outright, and
 * the browser may fetch nothing from any host but the demo app's.
 */

const REAL_ORIGINS = ['http://127.0.0.1:5174', 'http://localhost:5174', 'http://azure-dashboard.local'];

function withPresentation(url) {
  const u = new URL(url);
  u.searchParams.set('presentation', '1');
  return u.toString();
}

function assertNotRealOrigin(baseUrl) {
  const origin = new URL(baseUrl).origin.toLowerCase();
  if (REAL_ORIGINS.includes(origin)) {
    throw new Error(`Refusing to capture: ${origin} is the real app, not the demo.`);
  }
}

function isAllowedRequest(url, appOrigin) {
  if (/^(data|blob):/i.test(url)) return true;
  try {
    return new URL(url).origin.toLowerCase() === new URL(appOrigin).origin.toLowerCase();
  } catch (err) {
    return false;
  }
}

module.exports = { REAL_ORIGINS, withPresentation, assertNotRealOrigin, isAllowedRequest };
