import type { OrgMember, OrgTeam } from '../../../lib/types';
import { useTranslation } from '../../../lib/i18n';
import { MemberRow } from './MemberRow';
import type { Announce, Mutations } from './types';
import type { OrgRole } from './roleRules';

interface MemberListProps {
  roster: OrgMember[];
  managerId: string;
  members: OrgMember[];
  teams: OrgTeam[];
  selfId: string | null;
  isOwner: boolean;
  assignableRoles: OrgRole[];
  mutations: Mutations;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  deletingId: string | null;
  setDeletingId: (id: string | null) => void;
  announce: Announce;
}

/** The default view of a team's roster: a flat, scannable list rather than
 * the Hierarchy view's nested tree (see PeopleTree.tsx). Both read the same
 * `parentId` data via `flattenRoster` in the same depth-first order, so
 * switching views never reorders or drops anyone. */
export function MemberList({
  roster,
  managerId,
  members,
  teams,
  selfId,
  isOwner,
  assignableRoles,
  mutations,
  editingId,
  setEditingId,
  deletingId,
  setDeletingId,
  announce,
}: MemberListProps) {
  const t = useTranslation();
  if (roster.length === 0) {
    return <p className="px-2 py-3 text-xs text-ink-subtle">{t('team.noMembersYet')}</p>;
  }
  return (
    <div className="rounded-md border border-border">
      {roster.map((member) => (
        <MemberRow
          key={member.id}
          member={member}
          managerId={managerId}
          members={members}
          teams={teams}
          selfId={selfId}
          isOwner={isOwner}
          assignableRoles={assignableRoles}
          mutations={mutations}
          editingId={editingId}
          setEditingId={setEditingId}
          deletingId={deletingId}
          setDeletingId={setDeletingId}
          announce={announce}
        />
      ))}
    </div>
  );
}
