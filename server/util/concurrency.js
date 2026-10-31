/** Runs `fn` over `items` with at most `limit` in flight — an unbounded
 * Promise.all over one request per work item trips ADO's connection
 * limits (ECONNRESET) once the tree grows past ~50-100 items. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

module.exports = { mapWithConcurrency };
