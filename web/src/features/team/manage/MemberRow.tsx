import { Pencil, Trash2 } from 'lucide-react';
import { IconButton } from '../../../components/ui/IconButton';
import { Pill } from '../../../components/ui/Pill';
import { EditMemberForm } from './EditMemberForm';
import { useTranslation } from '../../../lib/i18n';
import { Foreign } from '../../../components/ui/Foreign';
import { roleLabel } from './roleRules';
import type { OrgMember, OrgTeam } from '../../../lib/types';
import type { Announce, Mutations } from './types';
import type { OrgRole } from './roleRules';

const ROLE_TONE: Record<OrgRole, 'accent' | 'neutral' | 'info' | 'success'> = {
  lead: 'accent',
  principal: 'info',
  scrum: 'success',
  developer: 'neutral',
};

interface MemberRowProps {
  member: OrgMember;
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

/** One row in the default flat member list — the same person `PersonRow`
 * renders in the Hierarchy view (see PeopleTree.tsx), just without the tree
 * chrome. A `reports to <name>` suffix appears only when this person's
 * manager isn't the team's own manager, so the common case (reports
 * straight to the team lead) stays a single clean line. */
export function MemberRow({
  member,
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
}: MemberRowProps) {
  const t = useTranslation();
  const isSelf = member.id === selfId;
  const isEditing = editingId === member.id;
  const isDeleting = deletingId === member.id;
  const canEdit = !isSelf || isOwner;
  const reportsTo = member.parentId && member.parentId !== managerId ? members.find((m) => m.id === member.parentId) : null;
  // Deleting someone hands their reports to that person's own manager (see
  // OrgStore.deleteMember). That is a consequence for other people, so the
  // confirmation says so rather than leaving it to be discovered afterwards.
  const reportCount = members.filter((m) => m.parentId === member.id).length;
  const newParent = members.find((m) => m.id === (member.parentId ?? managerId));

  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex flex-wrap items-center gap-2 px-2 py-2">
        {/* <bdi> isolates the name so an RTL one can't reorder the "(you)"
            suffix that follows it — see TeamRow.tsx. */}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink" title={member.displayName}>
          <bdi><Foreign as="span">{member.displayName}</Foreign></bdi>
          {isSelf && <span className="ms-1 text-ink-subtle">{t('team.youSuffixParen')}</span>}
        </span>
        <Pill tone={ROLE_TONE[member.role]}>{roleLabel(member.role)}</Pill>
        {/* Secondary metadata yields before the name does: on a narrow
            viewport this drops out entirely rather than squeezing the
            person's name down to an ellipsis. The same relationship is
            always readable in the Hierarchy view and the edit form. */}
        {reportsTo && (
          <span
            className="hidden max-w-[45%] truncate text-xs text-ink-subtle sm:inline"
            title={t('team.reportsToTitle', { name: reportsTo.displayName })}
          >
            {t('team.reportsToLabel', { name: reportsTo.displayName })}
          </span>
        )}
        <div className="ms-auto flex items-center gap-1">
          {canEdit && (
            <IconButton aria-label={t('team.editTeamAriaLabel', { name: member.displayName })} onClick={() => setEditingId(isEditing ? null : member.id)}>
              <Pencil size={14} />
            </IconButton>
          )}
          {!isSelf &&
            (isDeleting ? (
              <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
                {reportCount > 0 && newParent && (
                  <span className="text-xs text-warning">
                    {t('team.reportsMoveTo', { count: reportCount, name: newParent.displayName })}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => {
                    mutations.removeMember.mutate(member.id, {
                      onSuccess: () => announce(t('team.deletedMemberAnnouncement', { name: member.displayName }), 'danger'),
                    });
                    setDeletingId(null);
                  }}
                  className="focus-ring cursor-pointer rounded-md px-2 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger/10"
                >
                  {t('team.confirmDelete')}
                </button>
              </div>
            ) : (
              <IconButton aria-label={t('team.deleteTeamAriaLabel', { name: member.displayName })} onClick={() => setDeletingId(member.id)}>
                <Trash2 size={14} />
              </IconButton>
            ))}
        </div>
      </div>
      {isEditing && canEdit && (
        <div className="px-2 pb-2">
          <EditMemberForm
            member={member}
            members={members}
            teams={teams}
            assignableRoles={assignableRoles}
            mutations={mutations}
            onDone={() => setEditingId(null)}
            announce={announce}
          />
        </div>
      )}
    </div>
  );
}

