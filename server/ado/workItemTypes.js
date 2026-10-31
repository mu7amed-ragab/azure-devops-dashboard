/**
 * Which work item types this project's process template actually uses, and
 * which lifecycle role each plays — discovered, never hardcoded.
 *
 * Type NAMES are process-specific in exactly the way state names are
 * (see server/compute/workflow.js): the "requirement" type is 'User Story' on
 * Agile, 'Product Backlog Item' on Scrum, 'Issue' on Basic and 'Requirement'
 * on CMMI, and an inherited process can rename all of them. What IS stable
 * across every template — stock and custom — is ADO's work item type
 * *categories*, so that is what this reads.
 *
 * `GET /wit/workitemtypecategories` is project-scoped by construction (it goes
 * through AdoClient.projectUrl), so the answer belongs to the caller's chosen
 * project and to nothing else.
 */

const REQUIREMENT_CATEGORY = 'Microsoft.RequirementCategory';
const TASK_CATEGORY = 'Microsoft.TaskCategory';
const BUG_CATEGORY = 'Microsoft.BugCategory';

/**
 * Last-resort names, used only when the categories call itself fails (a
 * transient 5xx, or a PAT without Work Items read on this project). Keeping
 * the app's previous behavior on that path is strictly better than showing
 * nothing — but it is a fallback, flagged as such on the result so callers
 * and the /api/states response can say so.
 */
const FALLBACK = {
  requirementTypes: ['User Story'],
  taskTypes: ['Task'],
  bugTypes: ['Bug'],
};

function typeNamesOf(categories, referenceName) {
  const category = categories.find((c) => c.referenceName === referenceName);
  if (!category) return [];
  return (category.workItemTypes || []).map((t) => t.name).filter(Boolean);
}

function dedupe(names) {
  return [...new Set(names)];
}

/** Shapes the three raw name lists into the two roles the rest of the app
 * reasons about, matching the pre-existing (hardcoded) semantics exactly:
 *   - a "story" is a requirement-category item OR a top-level bug
 *   - a "leaf" is a task-category item OR a bug
 * Bugs are deliberately in both: a bug can be a story's child or stand on its
 * own, which is why the old STORY_TYPES and the old leaf-item query both
 * listed it. */
function shape({ requirementTypes, taskTypes, bugTypes }, source) {
  const storyTypes = dedupe([...requirementTypes, ...bugTypes]);
  const leafTypes = dedupe([...taskTypes, ...bugTypes]);
  return {
    source, // 'categories' | 'fallback'
    requirementTypes: dedupe(requirementTypes),
    taskTypes: dedupe(taskTypes),
    bugTypes: dedupe(bugTypes),
    storyTypes,
    leafTypes,
    // Every type the dashboard reads or writes — the set whose workflows
    // server/ado/states.js is asked for.
    allTypes: dedupe([...requirementTypes, ...taskTypes, ...bugTypes]),
  };
}

const COMPLETED_WORK_FIELD = 'Microsoft.VSTS.Scheduling.CompletedWork';

/**
 * Every work item type this project has — not just the three families above —
 * with its workflow states and whether it carries Completed Work
 * (007-all-assigned-types). The dashboard shows every item assigned to the
 * person whatever its type, so every type needs its workflow (visibility and
 * state writes are decided by category) and its hours capability (an hours
 * write to a type without the field is refused, not sent).
 *
 * `GET /wit/workitemtypes` is project-scoped by construction (AdoClient's
 * projectUrl, the same call scopes.js uses as its project-access probe). One
 * list call replaces a per-type states call for every type.
 *
 * `states: null` means the entry carried no states array (left to the
 * per-type fallback in ado/states.js); `tracksHours: null` means the entry
 * carried no fields list (unknown — treated as permissive by
 * typeTracksHours). A failed call yields `{}`: discovery of the extra types
 * is never allowed to stop the dashboard loading.
 *
 * LIVE VERIFICATION of the response shape (states-with-category, fields) is
 * still pending: the only PAT available at implementation time returned 403
 * (the original design notes R4). Both shapes are handled.
 */
async function fetchEveryType(client) {
  try {
    const res = await client.get('/wit/workitemtypes');
    const out = {};
    for (const t of res.value || []) {
      if (!t || !t.name) continue;
      out[t.name] = {
        states: Array.isArray(t.states)
          ? t.states.map((s) => ({ name: s.name, category: s.category, color: s.color || null }))
          : null,
        tracksHours: Array.isArray(t.fields) ? t.fields.some((f) => f && f.referenceName === COMPLETED_WORK_FIELD) : null,
      };
    }
    return out;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[types] ${client.project}: work item type list unavailable (${err.message}); only the requirement/task/bug types are known`);
    return {};
  }
}

function fallbackEveryType(names) {
  return Object.fromEntries(names.map((name) => [name, { states: null, tracksHours: null }]));
}

async function fetchWorkItemTypes(client) {
  const [shaped, everyType] = await Promise.all([fetchCategoryTypes(client), fetchEveryType(client)]);
  return {
    ...shaped,
    everyType: shaped.source === 'fallback' ? fallbackEveryType(shaped.allTypes) : everyType,
  };
}

/**
 * 'story' or 'item' — how an assigned work item that is not already part of a
 * story tree is placed (007-all-assigned-types, research.md R3/R6). Decided
 * by the type's discovered CATEGORY, never its name (Principle II): a
 * requirement-category type is a story (a childless one, when it reaches this
 * question); everything else — bugs, tasks, and every other type — is an
 * item. Bugs stay items because a top-level bug has always rendered that way.
 */
function classifyByCategory(type, types) {
  const requirementTypes = (types && types.requirementTypes) || [];
  const bugTypes = (types && types.bugTypes) || [];
  return requirementTypes.includes(type) && !bugTypes.includes(type) ? 'story' : 'item';
}

/** False only when this project positively reported that `type` has no
 * Completed Work field. Unknown (discovery failed, or the list carried no
 * fields) is permissive, so a failed discovery never blocks the Task/Bug
 * hours writes that worked before 007-all-assigned-types. */
function typeTracksHours(type, types) {
  const entry = types && types.everyType && types.everyType[type];
  return !(entry && entry.tracksHours === false);
}

async function fetchCategoryTypes(client) {
  try {
    const res = await client.get('/wit/workitemtypecategories');
    const categories = res.value || [];
    const raw = {
      requirementTypes: typeNamesOf(categories, REQUIREMENT_CATEGORY),
      taskTypes: typeNamesOf(categories, TASK_CATEGORY),
      bugTypes: typeNamesOf(categories, BUG_CATEGORY),
    };
    // A project that returned categories but none of the three we need is
    // not a project this dashboard can read — fall back rather than ship
    // empty type lists, which would make every WIQL query match nothing.
    if (raw.requirementTypes.length + raw.taskTypes.length + raw.bugTypes.length === 0) {
      return shape(FALLBACK, 'fallback');
    }
    return shape(raw, 'categories');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[types] ${client.project}: work item type categories unavailable (${err.message}); using stock Agile names`);
    return shape(FALLBACK, 'fallback');
  }
}

module.exports = {
  fetchWorkItemTypes,
  fetchEveryType,
  classifyByCategory,
  typeTracksHours,
  shape,
  FALLBACK,
  REQUIREMENT_CATEGORY,
  TASK_CATEGORY,
  BUG_CATEGORY,
};
