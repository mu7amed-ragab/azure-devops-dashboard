/**
 * Applies a work item JSON Patch the way Azure DevOps does: a `test /rev`
 * that doesn't match is a 409, a state the item's type doesn't have is a
 * 400, and a successful write appends a revision attributed to whoever made
 * it — so the revision index, hours and every view pick the change up just
 * as they would a real one.
 */

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function applyPatch(item, ops, person, now, typeStates) {
  if (!Array.isArray(ops)) throw fail(400, 'The request body must be a JSON Patch array.');
  const fields = { ...item.fields };
  const relations = item.relations.slice();

  for (const op of ops) {
    if (op.path === '/rev') {
      if (op.op === 'test' && Number(op.value) !== item.rev) {
        throw fail(409, `TF26071: This work item has been changed by someone else since you opened it (rev ${item.rev}, expected ${op.value}).`);
      }
      continue;
    }
    const fieldMatch = /^\/fields\/(.+)$/.exec(op.path || '');
    if (fieldMatch) {
      const name = fieldMatch[1];
      if (op.op === 'add' || op.op === 'replace') fields[name] = op.value;
      else if (op.op === 'remove') delete fields[name];
      else if (op.op !== 'test') throw fail(400, `Unsupported patch operation "${op.op}" on ${op.path}.`);
      continue;
    }
    if (op.path === '/relations/-' && op.op === 'add') {
      relations.push(op.value);
      continue;
    }
    throw fail(400, `Unsupported patch path "${op.path}".`);
  }

  const type = fields['System.WorkItemType'];
  if (fields['System.State'] !== item.fields['System.State']) {
    const allowed = (typeStates[type] || []).map((s) => s.name);
    if (!allowed.includes(fields['System.State'])) {
      throw fail(400, `TF401320: The field 'State' contains the value '${fields['System.State']}' that is not in the list of supported values for ${type}.`);
    }
  }

  const changedAt = new Date(Math.max(now.getTime(), Date.parse(item.fields['System.ChangedDate']) + 1)).toISOString();
  fields['System.ChangedDate'] = changedAt;
  fields['System.ChangedBy'] = person;
  item.fields = fields;
  item.relations = relations;
  item.rev += 1;
  fields['System.Rev'] = item.rev;
  item.revisions.push({ rev: item.rev, fields: { ...fields } });
  return { id: item.id, rev: item.rev, fields: item.fields, relations: item.relations };
}

module.exports = { applyPatch };
