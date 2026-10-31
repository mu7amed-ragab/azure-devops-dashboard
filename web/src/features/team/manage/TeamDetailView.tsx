import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import { IconButton } from '../../../components/ui/IconButton';
import { PrimaryButton } from '../../../components/ui/PrimaryButton';
import { InlineMessage } from '../../../components/ui/InlineMessage';
import { Tabs } from '../../../components/ui/Tabs';
import { DirectionalIcon } from '../../../components/ui/DirectionalIcon';
import { Foreign } from '../../../components/ui/Foreign';
import { useTranslation } from '../../../lib/i18n';
import { TeamEditForm } from './TeamEditForm';
import { AddMemberPanel } from './AddMemberPanel';
import { MemberList } from './MemberList';
import { PeopleTree } from './PeopleTree';
import { flattenRoster, nonDeveloperRosterFor } from './roleRules';
import { describeError, type ErrorDisplay } from '../../../lib/errorDisplay';
import { ApiError } from '../../../lib/api';
import type { OrgMember, OrgTeam } from '../../../lib/types';
import type { Announce, Mutations } from './types';
import type { OrgRole } from './roleRules';

type ViewMode = 'list' | 'hierarchy';

interface TeamDetailViewProps {
  team: OrgTeam;
  manager: OrgMember | null;
  members: OrgMember[];
  teams: OrgTeam[];
  self: OrgMember | null;
  selfId: string | null;
  isOwner: boolean;
  canManage: boolean;
  assignableRoles: OrgRole[];
  mutations: Mutations;
  announce: Announce;
  onBack: () => void;
}

/** One team's full management surface — reached from the team list's
 * "Manage" action. Defaults to a flat member List; a Hierarchy toggle
 * reveals the same data as a tree (see PeopleTree.tsx) for anyone who
 * needs the reporting structure. Absorbs everything the old per-team card
 * (TeamCard.tsx) used to own: rename, delete, and the owner's join/leave
 * toggle. */
export function TeamDetailView({
  team,
  manager,
  members,
  teams,
  self,
  selfId,
  isOwner,
  canManage,
  assignableRoles,
  mutations,
  announce,
  onBack,
}: TeamDetailViewProps) {
  const t = useTranslation();
  const [view, setView] = useState<ViewMode>('list');
  const [isEditingTeam, setIsEditingTeam] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [isAddingMember, setIsAddingMember] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Drilling into a team should hand focus to something meaningful in the
  // new view rather than leaving it on the (now-gone) "Manage" button —
  // the heading is the clearest anchor for where the user landed.
  useEffect(() => {
    headingRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team.id]);

  // Both scoped to this team's id — membership is `teamId`, never the
  // manager's parentId subtree, so a lead heading several teams gets a
  // distinct roster per team instead of the same list three times.
  const roster = useMemo(() => (manager ? flattenRoster(members, manager.id, team.id).map((r) => r.member) : []), [members, manager, team.id]);
  const parentOptions = useMemo(() => (manager ? nonDeveloperRosterFor(members, manager.id, team.id) : []), [members, manager, team.id]);

  const isSelfMember = !!self && self.teamId === team.id;

  /** Leaving clears the reporting line along with the team: a member with a
   * parent but no team is exactly the inconsistent state the rest of this
   * screen exists to prevent. There is no matching "join" button — joining
   * means picking a role and a manager, which is what "+ Add Member" does
   * (it recognises someone already in the chart and moves them). */
  function leaveTeam() {
    if (!self) return;
    mutations.editMember.mutate(
      { id: self.id, patch: { teamId: null, parentId: null } },
      {
        onSuccess: () => announce(t('team.leftTeamAnnouncement', { name: team.name }), 'danger'),
        onError: (err) => setError(describeError(err, t('team.couldNotUpdateMembership'))),
      }
    );
  }

  /** Every member belongs to exactly one team and there is no unassigned
   * state to fall back to, so deleting a populated team takes its people with
   * it. The button says so with the count before it's pressed, and passes
   * `cascade` — without it the server refuses (TEAM_NOT_EMPTY) rather than
   * assuming consent. */
  function deleteTeam(cascade: boolean) {
    mutations.removeTeam.mutate(
      { id: team.id, cascade },
      {
        onSuccess: () => {
          announce(
            cascade
              ? t('team.deletedTeamAnnouncement', { name: team.name, count: roster.length })
              : t('team.teamDeletedAnnouncement'),
            'danger'
          );
          onBack();
        },
        onError: (err) => {
          // A populated-team refusal names the count (details.memberCount)
          // rather than falling back to the generic TEAM_NOT_EMPTY catalog
          // sentence — see error.teamNotEmptySummary and FR-012. Only
          // reachable via a race (the roster grew between page load and the
          // click), since the button itself already sends `cascade` for a
          // non-empty team.
          if (err instanceof ApiError && err.code === 'TEAM_NOT_EMPTY' && err.details) {
            const memberCount = err.details.memberCount ?? 0;
            setError({ message: t('error.teamNotEmptySummary', { name: team.name, count: memberCount }) });
          } else {
            setError(describeError(err, t('team.couldNotDeleteTeam')));
          }
          setIsConfirmingDelete(false);
        },
      }
    );
  }

  let body: ReactNode;
  if (!manager) {
    body = <p className="text-xs text-ink-subtle">{t('team.noManagerRoster')}</p>;
  } else if (view === 'list') {
    body = (
      <MemberList
        roster={roster}
        managerId={manager.id}
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
    );
  } else {
    body = (
      <PeopleTree
        root={manager}
        ariaLabel={t('team.rosterAriaLabel', { name: team.name })}
        members={members}
        teams={teams}
        selfId={selfId}
        isOwner={isOwner}
        teamId={team.id}
        assignableRoles={assignableRoles}
        mutations={mutations}
        editingId={editingId}
        setEditingId={setEditingId}
        deletingId={deletingId}
        setDeletingId={setDeletingId}
        announce={announce}
      />
    );
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onBack}
        className="focus-ring flex cursor-pointer items-center gap-1 rounded-md py-1 text-xs font-medium text-ink-subtle transition-colors hover:text-ink"
      >
        <DirectionalIcon>
          <ChevronLeft size={14} />
        </DirectionalIcon>
        {t('team.allTeams')}
      </button>

      <div>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-ink focus:outline-none">
            <Foreign as="span">{team.name}</Foreign>
          </h3>
          {canManage && (
            <div className="flex items-center gap-1">
              {/* Leaving, reassigning the lead, and deleting the team are
                  structural changes to the chart, not roster upkeep — owner
                  only. A team's own lead can still rename it and manage its
                  members via canManage, but not dissolve or hand off the
                  team itself (see TeamEditForm's isOwner gating below). */}
              {isOwner && isSelfMember && self && (
                <button
                  type="button"
                  onClick={leaveTeam}
                  disabled={mutations.editMember.isPending}
                  className="focus-ring cursor-pointer rounded-md px-2 py-1 text-xs text-ink-subtle transition-colors hover:bg-surface-sunken hover:text-ink"
                >
                  {t('team.leaveTeamButton')}
                </button>
              )}
              <IconButton aria-label={t('team.editTeamAriaLabel', { name: team.name })} onClick={() => setIsEditingTeam((v) => !v)}>
                <Pencil size={14} />
              </IconButton>
              {isOwner &&
                (isConfirmingDelete ? (
                  <button
                    type="button"
                    onClick={() => deleteTeam(roster.length > 0)}
                    className="focus-ring cursor-pointer rounded-md px-2 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger/10"
                  >
                    {roster.length > 0
                      ? t('team.deleteTeamAndMembers', { count: roster.length })
                      : t('team.confirmDelete')}
                  </button>
                ) : (
                  <IconButton aria-label={t('team.deleteTeamAriaLabel', { name: team.name })} onClick={() => setIsConfirmingDelete(true)}>
                    <Trash2 size={14} />
                  </IconButton>
                ))}
            </div>
          )}
        </div>
        {/* <bdi> around the name — see TeamRow.tsx for why. */}
        <p className="text-xs text-ink-subtle">
          {manager ? (
            <>
              {t('team.managedByPrefix')} <bdi><Foreign as="span">{manager.displayName}</Foreign></bdi> · {t('team.memberCount', { count: roster.length })}
            </>
          ) : (
            t('team.noManagerAssigned')
          )}
        </p>
        {error && (
          <InlineMessage tone="error" detail={error.detail} className="mt-2">
            {error.message}
          </InlineMessage>
        )}
        {isEditingTeam && canManage && (
          <TeamEditForm
            team={team}
            members={members}
            isOwner={isOwner}
            assignableRoles={assignableRoles}
            mutations={mutations}
            onDone={() => setIsEditingTeam(false)}
            announce={announce}
          />
        )}
      </div>

      {manager && (
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-semibold text-ink">{t('team.membersHeading')}</h4>
          <Tabs
            aria-label={t('team.viewAriaLabel', { name: team.name })}
            centered={false}
            value={view}
            onChange={setView}
            options={[
              { id: 'list', label: t('team.listTab') },
              { id: 'hierarchy', label: t('team.hierarchyTab') },
            ]}
          />
          {/* Not gated on `canManage`: before this restructure the per-row
              "+" was ungated too, and the server allows a Lead to add anyone
              under a person inside their own subtree even in a team they
              don't manage (assertParentInScope). Gating here would remove a
              capability that still exists. */}
          <PrimaryButton className="ms-auto flex items-center gap-1.5" onClick={() => setIsAddingMember((v) => !v)}>
            <Plus size={14} />
            {t('team.addMember')}
          </PrimaryButton>
        </div>
      )}

      {manager && isAddingMember && (
        <AddMemberPanel
          parentId={manager.id}
          teamId={team.id}
          assignableRoles={assignableRoles}
          mutations={mutations}
          parentOptions={parentOptions}
          members={members}
          teams={teams}
          onDone={() => setIsAddingMember(false)}
          announce={announce}
        />
      )}

      {body}
    </div>
  );
}
