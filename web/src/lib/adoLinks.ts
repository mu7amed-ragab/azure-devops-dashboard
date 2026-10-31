/**
 * Deep links into Azure DevOps.
 *
 * `project` is optional, and passing `null` is the meaningful case rather than a
 * fallback: Azure DevOps resolves `/{org}/_workitems/edit/{id}` to the item's
 * OWN project, while `/{org}/{project}/_workitems/edit/{id}` asserts a project
 * the item had better actually be in.
 *
 * That matters on the Pull Requests page. Pull requests are org-wide there by
 * design (see server/ado/pullrequests.js), and attribution resolves a PR to its
 * story across projects — so a story shown under a PR may well live in a
 * different project from the one you signed in to, and naming the signed-in
 * project in its link would point at the wrong place. Everywhere else the
 * project is known to be right, so it stays in the URL.
 */
export function workItemUrl(org: string, project: string | null, id: number): string {
  return project
    ? `https://dev.azure.com/${org}/${project}/_workitems/edit/${id}`
    : `https://dev.azure.com/${org}/_workitems/edit/${id}`;
}
