import { useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { IconButton } from '../../../components/ui/IconButton';
import { InlineMessage } from '../../../components/ui/InlineMessage';
import { useTranslation } from '../../../lib/i18n';
import { Foreign } from '../../../components/ui/Foreign';
import { TeamEditForm } from './TeamEditForm';
import { describeError, type ErrorDisplay } from '../../../lib/errorDisplay';
import { ApiError } from '../../../lib/api';
import type { OrgMember, OrgTeam } from '../../../lib/types';
import type { Announce, Mutations } from './types';
import type { OrgRole } from './roleRules';

interface TeamRowProps {
  team: OrgTeam;
  manager: OrgMember | null;
  members: OrgMember[];
  memberCount: number;
  canManage: boolean;
  /** Deleting a team (and reassigning its lead, inside TeamEditForm) is
   * owner-only — see server/index.js's DELETE /api/org/teams/:id. */
  isOwner: boolean;
  onManage: () => void;
  /** Only passed through to TeamEditForm's inline "create a team lead" panel. */
  assignableRoles: OrgRole[];
  mutations: Mutations;
  announce: Announce;
}

/** One compact row in the team list — name, manager, and member count on a
 * single scannable line. Deliberately shows none of the roster itself; that
 * lives one level deeper, behind "Manage" (see TeamDetailView.tsx). */
export function TeamRow({ team, manager, members, memberCount, canManage, isOwner, onManage, assignableRoles, mutations, announce }: TeamRowProps) {
  const t = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [error, setError] = useState<ErrorDisplay | null>(null);

  return (
    <div className="border-b border-border px-3 py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink" title={team.name}>
            <Foreign as="span">{team.name}</Foreign>
          </p>
          {/* <bdi> isolates the manager's name so an RTL one (Arabic names
              are ordinary input here) can't swallow the neutral "·" and the
              digits after it and reorder them — without it this renders as
              "0 · <name> members". */}
          <p className="truncate text-xs text-ink-subtle">
            {manager ? (
              <>
                <bdi><Foreign as="span">{manager.displayName}</Foreign></bdi> · {t('team.memberCount', { count: memberCount })}
              </>
            ) : (
              t('team.noManagerAssigned')
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Deliberately NOT a PrimaryButton: one filled accent button per
              row would repeat the loudest element in the system down the
              whole list and drown out "+ Add Team", which is meant to be the
              screen's single most prominent action. */}
          <button
            type="button"
            id={`team-manage-${team.id}`}
            onClick={onManage}
            className="focus-ring cursor-pointer rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-surface-sunken"
          >
            {t('team.manageRowButton')}
          </button>
          {canManage && (
            <>
              <IconButton aria-label={t('team.editTeamAriaLabel', { name: team.name })} onClick={() => setIsEditing((v) => !v)}>
                <Pencil size={14} />
              </IconButton>
              {/* Deleting the team is owner-only — a Lead can rename/staff
                  their own team via Edit above, but not dissolve it. */}
              {isOwner &&
                (isConfirmingDelete ? (
                  <button
                    type="button"
                    onClick={() =>
                      // A populated team takes its members with it — nobody can
                      // be left without a team — so the count is on the button
                      // itself, and `cascade` is what the server requires as
                      // proof that was read (see OrgStore.deleteTeam).
                      mutations.removeTeam.mutate(
                        { id: team.id, cascade: memberCount > 0 },
                        {
                          onSuccess: () =>
                            announce(
                              memberCount > 0
                                ? t('team.deletedTeamAnnouncement', { name: team.name, count: memberCount })
                                : t('team.teamDeletedAnnouncement'),
                              'danger'
                            ),
                          onError: (err) => {
                            // Same detail-carrying refusal as TeamDetailView's
                            // delete flow — see the comment there.
                            if (err instanceof ApiError && err.code === 'TEAM_NOT_EMPTY' && err.details) {
                              const detailedCount = err.details.memberCount ?? 0;
                              setError({ message: t('error.teamNotEmptySummary', { name: team.name, count: detailedCount }) });
                            } else {
                              setError(describeError(err, t('team.couldNotDeleteTeam')));
                            }
                            setIsConfirmingDelete(false);
                          },
                        }
                      )
                    }
                    className="focus-ring cursor-pointer rounded-md px-2 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger/10"
                  >
                    {memberCount > 0 ? t('team.deleteTeamAndMembers', { count: memberCount }) : t('team.confirmDelete')}
                  </button>
                ) : (
                  <IconButton aria-label={t('team.deleteTeamAriaLabel', { name: team.name })} onClick={() => setIsConfirmingDelete(true)}>
                    <Trash2 size={14} />
                  </IconButton>
                ))}
            </>
          )}
        </div>
      </div>
      {error && (
        <InlineMessage tone="error" detail={error.detail} className="mt-2">
          {error.message}
        </InlineMessage>
      )}
      {isEditing && canManage && (
        <TeamEditForm
          team={team}
          members={members}
          isOwner={isOwner}
          assignableRoles={assignableRoles}
          mutations={mutations}
          onDone={() => setIsEditing(false)}
          announce={announce}
        />
      )}
    </div>
  );
}
