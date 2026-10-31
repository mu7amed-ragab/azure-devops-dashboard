import type { useOrgMutations } from '../../../lib/useOrg';

export type Mutations = ReturnType<typeof useOrgMutations>;

/** Confirms what just happened, in the modal's one banner (see
 * ManageTeamModal). `tone` is about the nature of the change, not whether it
 * worked — a deletion that succeeded still reads as a removal, so it is red.
 * Failures are not announced at all: they stay next to the form that caused
 * them, where the fields can still be corrected. */
export type Announce = (message: string, tone?: 'success' | 'danger') => void;
