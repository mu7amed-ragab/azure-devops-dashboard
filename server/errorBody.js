/** Every error-body literal in server/index.js goes through here: `err.details`
 * (the additive, optional field a few refusals attach — see
 * orgStore.js's codedValidationError) has to reach the client for the client
 * to render FR-012's two-part message and interpolate real numbers/names into
 * TEAM_NOT_EMPTY and REPORTS_REASSIGN_REQUIRED. Building the body inline at
 * each catch block is how that field was silently dropped before — pulled
 * into its own module so test/orgErrorDetails.test.js can exercise the exact
 * function the routes use, not a copy of it. */
function errorBody(err, code) {
  const body = { error: err.message, code };
  if (err.details) body.details = err.details;
  return body;
}

module.exports = { errorBody };
