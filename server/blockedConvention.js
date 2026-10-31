/**
 * The blocked convention (FR-035a through FR-035e): per-project, per-type
 * configuration of which states, tags, and/or field mean "blocked" — the
 * one deliberate exception to "never assume a name" (Constitution Principle
 * II), because Azure DevOps has no Blocked *category* to discover. See
 * data-model.md §7 and plan.md's Complexity Tracking.
 */

/** @returns {{version: 1, byType: {}}} the default when a project has none
 * configured yet — never guessed (FR-035d-i). */
function emptyConvention() {
  return { version: 1, byType: {} };
}

/** `options.statesByType[type]` comes straight from `ado/states.js`
 * (`fetchStatesForTypes`), which is an array of `{name, category, color}`
 * objects, not plain strings — while a convention's `rule.states` (and
 * everything compared against it here) is always a list of state NAME
 * strings. Every comparison below must go through this. */
function stateNamesFor(options, type) {
  const states = (options.statesByType && options.statesByType[type]) || [];
  return states.map((s) => (typeof s === 'string' ? s : s.name));
}

/** Validates a convention against the project's REAL states/tags/fields
 * (FR-035c-iii) — a convention naming something the project doesn't have
 * cannot be saved. Throws a plain Error with a human message; the caller
 * (server/index.js) maps that to 400. */
function validateConvention(convention, options) {
  if (!convention || typeof convention !== 'object') throw new Error('Convention is required.');
  if (convention.version !== 1) throw new Error('Unsupported convention version.');
  const byType = convention.byType || {};
  for (const [type, rule] of Object.entries(byType)) {
    if (!options.types.includes(type)) throw new Error(`"${type}" is not a work item type in this project.`);
    const stateNames = stateNamesFor(options, type);
    for (const s of rule.states || []) {
      if (!stateNames.includes(s)) throw new Error(`"${s}" is not a real state of ${type} in this project.`);
    }
    for (const t of rule.tags || []) {
      if (!options.tags.includes(t)) throw new Error(`"${t}" is not a tag seen in this project.`);
    }
    if (rule.field && !options.fields.includes(rule.field)) {
      throw new Error(`"${rule.field}" is not an eligible field in this project.`);
    }
    // A14: a field with no configured "means blocked" value can't be
    // matched by equality at all — reject rather than silently falling back
    // to a guess. A convention with no `field` at all is unaffected; one
    // saved before this key existed is handled by matchBlocked's own
    // `true`-default, not by relaxing validation on a NEW save.
    if (rule.field && (rule.fieldBlockedValue === undefined || rule.fieldBlockedValue === null || rule.fieldBlockedValue === '')) {
      throw new Error(`A "means blocked" value is required for field "${rule.field}".`);
    }
  }
  return { version: 1, byType };
}

/** True/how `item` (a SprintItem, data-model.md §2a) matches its type's
 * blocked convention — states, tags, and field combine as OR (FR-035a). A
 * type with no configured rule is never blocked. Tag matching is
 * case-insensitive (FR-035a-i, consistent with compute/rollup.js). */
function matchBlocked(item, convention) {
  const rule = convention && convention.byType && convention.byType[item.type];
  if (!rule) return { blocked: false, matchedOn: null };
  if (item.state && rule.states && rule.states.includes(item.state)) return { blocked: true, matchedOn: 'state' };
  const tags = item.tags || [];
  if (rule.tags && rule.tags.length > 0 && tags.some((t) => rule.tags.some((rt) => rt.toLowerCase() === t.toLowerCase()))) {
    return { blocked: true, matchedOn: 'tag' };
  }
  if (rule.field) {
    // A14: match by EQUALITY against the configured "means blocked" value,
    // never by truthiness — the old `!= null && !== false && !== 'No'` test
    // treated every OTHER value (including a picklist's own "Not Blocked"
    // option, or a numeric 0/1 field's `0`) as blocked, which is exactly
    // backwards. `fieldBlockedValue` names the one value that means blocked,
    // chosen from the field's real allowed values (a picklist) or defaulted
    // to boolean `true` (a boolean field). A convention saved before this
    // key existed has none at all — read as `true`, the old rule's only
    // actually-correct case, so nothing needs migrating by hand.
    const blockedValue = 'fieldBlockedValue' in rule ? rule.fieldBlockedValue : true;
    if (item.blockedField === blockedValue) return { blocked: true, matchedOn: 'field' };
  }
  return { blocked: false, matchedOn: null };
}

/** Names configured in `convention` that no longer exist in `options`
 * (FR-035e) — surfaced to the view rather than silently dropped. */
function missingConfigRefs(convention, options) {
  const missing = [];
  for (const [type, rule] of Object.entries((convention && convention.byType) || {})) {
    const stateNames = stateNamesFor(options, type);
    for (const s of rule.states || []) if (!stateNames.includes(s)) missing.push(`${type}: state "${s}"`);
    for (const t of rule.tags || []) if (!options.tags.includes(t)) missing.push(`${type}: tag "${t}"`);
    if (rule.field && !options.fields.includes(rule.field)) missing.push(`${type}: field "${rule.field}"`);
  }
  return missing;
}

module.exports = { emptyConvention, validateConvention, matchBlocked, missingConfigRefs };
