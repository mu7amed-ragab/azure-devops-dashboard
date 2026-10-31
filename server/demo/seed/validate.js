const { coverageReport } = require('./coverage');

/** Refuses to start the demo on a seed too thin to show every feature. */
function validate(state) {
  const { ok, missing } = coverageReport(state);
  if (!ok) throw new Error(`Demo seed is missing: ${missing.join('; ')}`);
}

module.exports = { validate };
