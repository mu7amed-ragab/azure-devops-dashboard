import type { LinkedIdentity } from './types';

/** The distinct `@domain`s of a person's linked identities, lowercased — what
 * the linked-identity disclosure shows. Every linked identity shares the
 * person's username by construction (server/identitySet.js), so the domain is
 * the only part that tells them apart. An identity with no `@` contributes
 * nothing. */
export function linkedDomains(identities: LinkedIdentity[]): string[] {
  const domains = new Set<string>();
  for (const { uniqueName } of identities) {
    const at = uniqueName.lastIndexOf('@');
    if (at >= 0 && at < uniqueName.length - 1) domains.add(uniqueName.slice(at).toLowerCase());
  }
  return [...domains];
}
