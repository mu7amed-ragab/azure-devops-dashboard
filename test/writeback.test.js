/**
 * (D) in the brief: a state that exists in the current project is ALLOWED, a
 * state that doesn't is REFUSED — and the automatic transitions that ride along
 * with an hours write pick the current project's own state names.
 *
 * Every case here would have written or compared the literal 'Closed' / 'Active'
 * / 'New' before, which is wrong on three of the five process templates tested.
 */

const { suite, test, run, assert } = require('./harness');
const { resolveWorkflow } = require('../server/compute/workflow');
const {
  resolveAutoClose,
  resolveAutoActivate,
  applyStateWrite,
  applyTaskWrite,
  ValidationError,
  ForbiddenError,
} = require('../server/ado/writeback');
const { createFakeClient, workItem } = require('./fixtures/fakeClient');
const { AGILE, SCRUM, BASIC, CMMI, CUSTOM, LIVE_A, LIVE_B, UNKNOWN_TYPE } = require('./fixtures/processes');

const ME = 'me-guid';

function statePatch(patches) {
  const ops = patches.flatMap((p) => p.patchDocument);
  const op = ops.find((o) => o.path === '/fields/System.State');
  return op ? op.value : null;
}

suite('auto-close target: resolved per process, never hardcoded');

for (const [proc, expected] of [
  [AGILE, 'Closed'],
  [SCRUM, 'Done'],
  [BASIC, 'Done'],
  [CMMI, 'Closed'],
  [CUSTOM, 'Deployed To Production'],
]) {
  test(`${proc.name}: hours reaching the estimate closes to "${expected}"`, () => {
    const wf = resolveWorkflow('Task', proc.states);
    const current = { estimated: 8, completed: 4, state: wf.inProgressState.name };
    assert.strictEqual(resolveAutoClose(current, 8, wf).name, expected);
  });
}

test('no auto-close when there is no estimate to reach', () => {
  const wf = resolveWorkflow('Task', AGILE.states);
  assert.strictEqual(resolveAutoClose({ estimated: 0, completed: 0, state: 'Active' }, 5, wf), null);
});

test('no auto-close below the estimate', () => {
  const wf = resolveWorkflow('Task', AGILE.states);
  assert.strictEqual(resolveAutoClose({ estimated: 8, completed: 2, state: 'Active' }, 7.9, wf), null);
});

test('an already-done item is never dragged backwards', () => {
  // The original bug this list of names existed to prevent: hitting 100% again
  // on an item that had already shipped rewrote its state to 'Closed'.
  const wf = resolveWorkflow('Delivery Item', CUSTOM.states);
  assert.strictEqual(
    resolveAutoClose({ estimated: 8, completed: 8, state: 'Deployed To Production' }, 8, wf),
    null,
    'a Completed-category state stays put'
  );
  assert.strictEqual(
    resolveAutoClose({ estimated: 8, completed: 8, state: 'Ready For Test (Demo)' }, 8, wf),
    null,
    'a Resolved-category state stays put too — this is the case a name list kept getting wrong'
  );
});

test('an unknown type produces no auto-close rather than a guessed state', () => {
  const wf = resolveWorkflow(UNKNOWN_TYPE, AGILE.states);
  assert.strictEqual(resolveAutoClose({ estimated: 8, completed: 0, state: 'Whatever' }, 8, wf), null);
});

test('a process with no Completed state at all produces no auto-close', () => {
  const wf = resolveWorkflow('Thing', { Thing: [{ name: 'Open', category: 'Proposed' }, { name: 'Working', category: 'InProgress' }] });
  assert.ok(wf.known);
  assert.strictEqual(resolveAutoClose({ estimated: 4, completed: 0, state: 'Open' }, 4, wf), null);
});

suite('auto-activate target: also per process');

for (const [proc, type, from, to] of [
  [AGILE, 'Task', 'New', 'Active'],
  [SCRUM, 'Task', 'To Do', 'In Progress'],
  [BASIC, 'Task', 'To Do', 'Doing'],
  [CMMI, 'Task', 'Proposed', 'Active'],
  [CUSTOM, 'Task', 'Intake', 'Building'],
]) {
  test(`${proc.name}: first hours move ${type} "${from}" -> "${to}"`, () => {
    const wf = resolveWorkflow(type, proc.states);
    const result = resolveAutoActivate({ state: from }, 2, wf, false);
    assert.strictEqual(result.name, to);
  });
}

test('only the INITIAL state activates, not every Proposed one', () => {
  // Scrum's 'Approved' is Proposed-category, but it is a state a person chose.
  const wf = resolveWorkflow('Product Backlog Item', SCRUM.states);
  assert.strictEqual(resolveAutoActivate({ state: 'New' }, 1, wf, false).name, 'Committed');
  assert.strictEqual(resolveAutoActivate({ state: 'Approved' }, 1, wf, false), null);
});

test('LIVE: an OnHold Task is NOT auto-advanced, though ADO calls it Proposed', () => {
  // The real reason resolveAutoActivate keys on the initial state rather than the
  // Proposed category. LiveProjectA's Task workflow is
  //   New [Proposed] -> OnHold [Proposed] -> Active [InProgress] -> ...
  // so a category test would drag a deliberately-parked task into Active.
  const wf = resolveWorkflow('Task', LIVE_A.states);
  assert.ok(wf.proposedNames.has('OnHold'), 'ADO really does categorize it Proposed');
  assert.strictEqual(wf.initialState.name, 'New');
  assert.strictEqual(resolveAutoActivate({ state: 'New' }, 1, wf, false).name, 'Active');
  assert.strictEqual(resolveAutoActivate({ state: 'OnHold' }, 1, wf, false), null);
});

test('LIVE: a story parked at "Ready For Development" is not auto-advanced either', () => {
  const wf = resolveWorkflow('User Story', LIVE_A.states);
  assert.strictEqual(wf.proposedNames.size, 4, 'four Proposed states on this type');
  assert.strictEqual(resolveAutoActivate({ state: 'New' }, 1, wf, false).name, 'Active');
  for (const parked of ['PO Approved', 'EA Approved', 'Ready For Development']) {
    assert.strictEqual(resolveAutoActivate({ state: parked }, 1, wf, false), null, parked);
  }
});

test('LIVE: "Resolved" on this User Story type is InProgress, so it is NOT done', () => {
  // The old hardcoded ALREADY_DONE_STATES listed 'Resolved' unconditionally,
  // which was wrong for this type in this project. Category resolution fixes it.
  const wf = resolveWorkflow('User Story', LIVE_A.states);
  assert.ok(!wf.doneNames.has('Resolved'), 'still in progress here');
  assert.ok(wf.doneNames.has('Deployed To Production'), 'Resolved category => done');
  assert.ok(wf.doneNames.has('Closed'));
});

test('LIVE: both real projects still auto-close to "Closed" — behavior preserved', () => {
  const a = resolveWorkflow('Task', LIVE_A.states);
  const b = resolveWorkflow('Task', LIVE_B.states);
  assert.strictEqual(a.completedState.name, 'Closed');
  assert.strictEqual(b.completedState.name, 'Closed');
  assert.strictEqual(a.inProgressState.name, 'Active');
  assert.strictEqual(b.inProgressState.name, 'Active');
  // ...but the state SETS differ, which is why they must not share a cache.
  assert.ok(a.allows('OnHold') && !b.allows('OnHold'));
  assert.ok(b.allows('Blocked') && !a.allows('Blocked'));
});

test('LIVE: the done-set matches the old hardcoded list on both real projects', () => {
  // The old ALREADY_DONE_STATES, intersected with each real Task workflow, is
  // exactly what category resolution now produces — so the auto-close guard
  // behaves identically on the projects this app actually runs against.
  const OLD_HARDCODED = new Set([
    'Closed', 'Deployed To Production', 'Resolved', 'Verified and Resolved',
    'Ready for Production', 'Invalid', 'Removed', 'Done',
  ]);
  for (const [label, proc] of [['LiveProjectA', LIVE_A], ['LiveProjectB', LIVE_B]]) {
    const wf = resolveWorkflow('Task', proc.states);
    const oldForThisType = new Set(wf.states.map((s) => s.name).filter((n) => OLD_HARDCODED.has(n)));
    assert.deepStrictEqual([...wf.doneNames].sort(), [...oldForThisType].sort(), label);
  }
});

test('auto-close wins over auto-activate in the same write', () => {
  const wf = resolveWorkflow('Task', AGILE.states);
  assert.strictEqual(resolveAutoActivate({ state: 'New' }, 8, wf, true), null);
});

test('an already-active item is not re-activated', () => {
  const wf = resolveWorkflow('Task', AGILE.states);
  assert.strictEqual(resolveAutoActivate({ state: 'Active' }, 3, wf, false), null);
});

test('logging zero hours does not activate anything', () => {
  const wf = resolveWorkflow('Task', AGILE.states);
  assert.strictEqual(resolveAutoActivate({ state: 'New' }, 0, wf, false), null);
});

suite('applyStateWrite: validated against the CURRENT project only');

test('ALLOWED: a state this project really has', async () => {
  const client = createFakeClient({
    project: 'ScrumProject',
    workItems: workItem({ id: 1, type: 'Task', state: 'To Do', assignedToId: ME }),
  });
  const result = await applyStateWrite(client, 1, 'In Progress', SCRUM.states);
  assert.strictEqual(result.state, 'In Progress');
  assert.strictEqual(statePatch(client.patches), 'In Progress');
});

test('REFUSED: a state from a DIFFERENT project\'s process template', async () => {
  // The cross-project case in the brief: 'Closed' is a perfectly real state —
  // in an Agile project. This project is Scrum. Nothing is sent to ADO.
  const client = createFakeClient({
    project: 'ScrumProject',
    workItems: workItem({ id: 1, type: 'Task', state: 'To Do', assignedToId: ME }),
  });
  await assert.rejects(
    () => applyStateWrite(client, 1, 'Closed', SCRUM.states),
    (err) => {
      assert.ok(err instanceof ValidationError, 'should be a 400, not a 502 from ADO');
      assert.match(err.message, /not one of the states Task uses in this project/);
      return true;
    }
  );
  assert.strictEqual(client.patches.length, 0, 'no invalid write reached Azure DevOps');
});

test('REFUSED: a state that exists for another TYPE in the same project', async () => {
  // 'Ready For Test (Demo)' is real in this project — on Delivery Item, not Task.
  const client = createFakeClient({
    project: 'CustomProject',
    workItems: workItem({ id: 1, type: 'Task', state: 'Intake', assignedToId: ME }),
  });
  await assert.rejects(() => applyStateWrite(client, 1, 'Ready For Test (Demo)', CUSTOM.states), ValidationError);
  assert.strictEqual(client.patches.length, 0);
});

test('REFUSED: an unknown type refuses instead of writing unvalidated', async () => {
  const client = createFakeClient({
    project: 'P',
    workItems: workItem({ id: 1, type: UNKNOWN_TYPE, state: 'Something', assignedToId: ME }),
  });
  await assert.rejects(
    () => applyStateWrite(client, 1, 'Closed', AGILE.states),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /hasn't returned the available states/);
      return true;
    }
  );
  assert.strictEqual(client.patches.length, 0);
});

test('a no-op state change does not PATCH', async () => {
  const client = createFakeClient({
    project: 'P',
    workItems: workItem({ id: 1, type: 'Task', state: 'Active', assignedToId: ME }),
  });
  const result = await applyStateWrite(client, 1, 'Active', AGILE.states);
  assert.strictEqual(result.state, 'Active');
  assert.strictEqual(client.patches.length, 0);
});

suite('applyTaskWrite: hours + the transition that rides with them');

test('Scrum: reaching the estimate patches hours and "Done" under one rev guard', async () => {
  const client = createFakeClient({
    project: 'ScrumProject',
    workItems: workItem({ id: 5, type: 'Task', state: 'In Progress', rev: 7, estimated: 8, completed: 6, remaining: 2, assignedToId: ME }),
  });
  const result = await applyTaskWrite(client, 5, () => ({ newCompleted: 8, newRemaining: 0 }), ME, SCRUM.states);
  assert.strictEqual(result.closed, true);
  assert.strictEqual(result.newState, 'Done');

  const ops = client.patches[0].patchDocument;
  assert.deepStrictEqual(ops[0], { op: 'test', path: '/rev', value: 7 }, 'optimistic concurrency guard is first');
  assert.strictEqual(ops.filter((o) => o.path === '/fields/System.State').length, 1, 'exactly one state op');
  assert.strictEqual(statePatch(client.patches), 'Done');
});

test('the same write on an Agile project patches "Closed" instead', async () => {
  const client = createFakeClient({
    project: 'AgileProject',
    workItems: workItem({ id: 5, type: 'Task', state: 'Active', estimated: 8, completed: 6, assignedToId: ME }),
  });
  const result = await applyTaskWrite(client, 5, () => ({ newCompleted: 8, newRemaining: 0 }), ME, AGILE.states);
  assert.strictEqual(result.newState, 'Closed');
});

test('hours still land when the workflow is unknown — only the state op is dropped', async () => {
  const client = createFakeClient({
    project: 'P',
    workItems: workItem({ id: 5, type: UNKNOWN_TYPE, state: 'Whatever', estimated: 8, completed: 6, assignedToId: ME }),
  });
  const result = await applyTaskWrite(client, 5, () => ({ newCompleted: 8, newRemaining: 0 }), ME, AGILE.states);
  assert.strictEqual(result.closed, false);
  assert.strictEqual(result.newState, 'Whatever', 'state unchanged');
  assert.strictEqual(statePatch(client.patches), null, 'no state op in the patch');
  const paths = client.patches[0].patchDocument.map((o) => o.path);
  assert.ok(paths.includes('/fields/Microsoft.VSTS.Scheduling.CompletedWork'), 'hours were still written');
});

test('the parent-story cascade uses the PARENT type\'s own workflow', async () => {
  // A Custom-process Task activates to 'Building'; its Delivery Item parent
  // must also go to 'Building' — resolved from Delivery Item's own states, not
  // copied from the task's.
  const items = {
    ...workItem({ id: 10, type: 'Task', state: 'Intake', estimated: 8, completed: 0, assignedToId: ME, parentId: 20 }),
    ...workItem({ id: 20, type: 'Delivery Item', state: 'Intake' }),
  };
  const client = createFakeClient({ project: 'CustomProject', workItems: items });
  const result = await applyTaskWrite(client, 10, () => ({ newCompleted: 2, newRemaining: 6 }), ME, CUSTOM.states);
  assert.strictEqual(result.activated, true);
  assert.strictEqual(result.storyActivated, true);
  const parentPatch = client.patches.find((p) => p.id === 20);
  assert.ok(parentPatch, 'the parent was patched');
  const op = parentPatch.patchDocument.find((o) => o.path === '/fields/System.State');
  assert.strictEqual(op.value, 'Building');
});

test('the cascade is skipped when the parent is already past Proposed', async () => {
  const items = {
    ...workItem({ id: 10, type: 'Task', state: 'New', estimated: 8, completed: 0, assignedToId: ME, parentId: 20 }),
    ...workItem({ id: 20, type: 'User Story', state: 'Resolved' }),
  };
  const client = createFakeClient({ project: 'AgileProject', workItems: items });
  const result = await applyTaskWrite(client, 10, () => ({ newCompleted: 1, newRemaining: 7 }), ME, AGILE.states);
  assert.strictEqual(result.activated, true);
  assert.strictEqual(result.storyActivated, false);
  assert.ok(!client.patches.some((p) => p.id === 20), 'the parent was left alone');
});

test('ownership is still enforced before any of this runs', async () => {
  const client = createFakeClient({
    project: 'P',
    workItems: workItem({ id: 5, type: 'Task', state: 'New', estimated: 8, assignedToId: 'someone-else' }),
  });
  await assert.rejects(() => applyTaskWrite(client, 5, () => ({ newCompleted: 1, newRemaining: 7 }), ME, AGILE.states), ForbiddenError);
  assert.strictEqual(client.patches.length, 0);
});

suite('006-linked-identity-aliases (T014, FR-008): a linked identity is a READ subject, never a WRITE one');

// `expectedAssigneeId` is always the caller's PRIMARY identity id — nothing in
// server/identitySet.js or the widened WIQL/PR reads ever reaches
// assertAssignedTo (see ado/writeback.js), so a write to an item still
// assigned to the person's OLD (linked) identity's id is refused exactly the
// same way a teammate's item already is above. This is the direct,
// server-side assertion the plan calls for — independent of whatever the
// client's `editable` flag happens to show.
const OLD_IDENTITY_ID = 'old-identity-id'; // e.g. alex.k@legacy-example.onmicrosoft.com
const NEW_IDENTITY_ID = ME; // e.g. alex.k@EXAMPLE.DEV — the signed-in identity

test('a write to an item assigned to the caller\'s OWN linked (retired) identity is refused', async () => {
  const client = createFakeClient({
    project: 'P',
    workItems: workItem({ id: 6, type: 'Task', state: 'New', estimated: 8, assignedToId: OLD_IDENTITY_ID }),
  });
  // The caller signs in as NEW_IDENTITY_ID; assertAssignedTo only ever
  // compares against that primary id, never against a linked identity's id,
  // so this must refuse just like any other non-owned item.
  await assert.rejects(
    () => applyTaskWrite(client, 6, () => ({ newCompleted: 1, newRemaining: 7 }), NEW_IDENTITY_ID, AGILE.states),
    ForbiddenError
  );
  assert.strictEqual(client.patches.length, 0);
});

test('the SAME item is writable once truly assigned to the primary identity', async () => {
  // Sanity check that the refusal above is really about identity, not some
  // other property of the fixture — an item assigned to the primary id
  // writes normally.
  const client = createFakeClient({
    project: 'P',
    workItems: workItem({ id: 7, type: 'Task', state: 'New', estimated: 8, assignedToId: NEW_IDENTITY_ID }),
  });
  const result = await applyTaskWrite(client, 7, () => ({ newCompleted: 1, newRemaining: 7 }), NEW_IDENTITY_ID, AGILE.states);
  assert.ok(result);
  assert.ok(client.patches.some((p) => p.id === 7));
});

module.exports = run;
