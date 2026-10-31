const { REPOS, slug } = require('./vocabulary');

// Pull request descriptions, picked by id so the seeded random sequence is untouched.
const PR_NOTES = [
  'تم الانتهاء من تعديل الـ API وجاري مراجعة الـ Integration Tests.',
  'تمت إضافة الـ Unit Tests والنتائج كلها Passed.',
  'تم نشر التحديث على Staging والنتائج كلها Passed.',
  'محتاجين نراجع الـ Edge Cases قبل نقل التغيير للـ Release.',
  'المشكلة كانت بسبب Invalid Token وتم إصلاحها.',
];
const { identityRef } = require('./people');

const VOTES = [10, 10, 10, 5, 0, -5, -10];

/**
 * Repositories and pull requests across the three projects. Each PR names the
 * story it ships in its title (`#<id>`), links that story, and carries commit
 * messages mentioning it — the three signals the app attributes PRs by. A
 * couple of `shared-ui` PRs (an Enterprise Cloud Platform repo) ship Customer Experience Portal stories, which is what
 * the Pull Requests page marks with a project pill.
 */
function buildPullRequests({ rng, projects, people, items, now }) {
  const projectByName = new Map(projects.map((p) => [p.name, p]));
  const repos = REPOS.map((r) => ({ id: rng.guid(), name: r.name, project: projectByName.get(r.project) }));
  const reposOf = (projectName) => repos.filter((r) => r.project.name === projectName);

  const storyTypes = new Set(['User Story', 'Product Backlog Item']);
  const nowMs = now.getTime();
  const tenWeeksAgo = nowMs - 70 * 24 * 3600 * 1000;
  const candidates = items.filter((i) => {
    if (!storyTypes.has(i.fields['System.WorkItemType'])) return false;
    if (i.fields['System.State'] === 'Removed') return false;
    return Date.parse(i.fields['System.CreatedDate']) >= tenWeeksAgo - 21 * 24 * 3600 * 1000;
  });

  const byUnique = new Map(people.map((p) => [p.uniqueName.toLowerCase(), p]));
  const lead = people.find((p) => p.key === 'mona');
  const prs = [];
  let nextPrId = 1180;

  function addPr(story, repo, author, { status, draft = false }) {
    const createdMs = Math.max(tenWeeksAgo, Math.min(nowMs - 3600 * 1000, Date.parse(story.fields['System.CreatedDate']) + rng.int(2, 9) * 24 * 3600 * 1000));
    const closedMs = status === 'active' ? null : Math.min(nowMs - 1800 * 1000, createdMs + rng.int(1, 5) * 24 * 3600 * 1000);
    const reviewers = rng
      .shuffle(people.filter((p) => p !== author && p.projects.includes(repo.project.name)))
      .slice(0, rng.int(2, 4))
      .map((p) => {
        let vote = rng.pick(VOTES);
        if (status === 'completed' && vote < 0) vote = 10;
        if (status === 'active' && vote === 10 && rng.chance(0.5)) vote = 0;
        return { ...identityRef(p), vote, isRequired: rng.chance(0.3) };
      });
    const title = `${story.fields['System.Title']} (#${story.id})`;
    const pr = {
      pullRequestId: nextPrId,
      codeReviewId: nextPrId,
      title,
      description: `${PR_NOTES[nextPrId % PR_NOTES.length]} (Work Item #${story.id})`,
      status,
      isDraft: draft,
      createdBy: identityRef(author),
      creationDate: new Date(createdMs).toISOString(),
      closedDate: closedMs ? new Date(closedMs).toISOString() : undefined,
      sourceRefName: `refs/heads/feature/${story.id}-${slug(story.fields['System.Title'])}`,
      targetRefName: 'refs/heads/main',
      mergeStatus: status === 'completed' ? 'succeeded' : 'notSet',
      repository: { id: repo.id, name: repo.name, project: { id: repo.project.id, name: repo.project.name } },
      reviewers,
      workItemIds: [story.id],
      commits: [
        { commitId: rng.hex(40), comment: `${rng.pick(['إضافة', 'ربط', 'تحسين', 'إصلاح'])} ${story.fields['System.Title'].toLowerCase()} #${story.id}` },
        { commitId: rng.hex(40), comment: `معالجة ملاحظات المراجعة (#${story.id})` },
      ],
    };
    nextPrId += rng.int(1, 4);
    prs.push(pr);
    story.relations.push({
      rel: 'ArtifactLink',
      url: `vstfs:///Git/PullRequestId/${repo.project.id}%2F${repo.id}%2F${pr.pullRequestId}`,
      attributes: { name: 'Pull Request' },
    });
    return pr;
  }

  function statusFor(story) {
    const cat = story.fields['System.State'];
    if (['Closed', 'Done', 'Resolved'].includes(cat)) return rng.chance(0.08) ? 'abandoned' : 'completed';
    return rng.chance(0.7) ? 'active' : 'completed';
  }

  for (const story of candidates) {
    const projectName = story.fields['System.TeamProject'];
    const assigned = story.fields['System.AssignedTo'];
    const owner = (assigned && byUnique.get(String(assigned.uniqueName).toLowerCase())) || lead;
    const repo = rng.pick(reposOf(projectName));
    const status = statusFor(story);
    addPr(story, repo, owner, { status, draft: status === 'active' && rng.chance(0.15) });
    if (rng.chance(0.25)) addPr(story, rng.pick(reposOf(projectName)), owner, { status: rng.chance(0.5) ? 'completed' : 'abandoned' });
  }

  // Shared UI work for Customer Experience Portal stories, shipped from an Enterprise Cloud Platform repository.
  const sharedUi = repos.find((r) => r.name === 'shared-ui');
  const portalLeadStories = candidates.filter((s) => s.fields['System.TeamProject'] === 'Customer Experience Portal' && s.fields['System.AssignedTo'] && s.fields['System.AssignedTo'].uniqueName === lead.uniqueName);
  portalLeadStories.slice(0, 3).forEach((story, i) => addPr(story, sharedUi, lead, { status: i === 0 ? 'active' : 'completed' }));

  return { repos, prs };
}

module.exports = { buildPullRequests };
