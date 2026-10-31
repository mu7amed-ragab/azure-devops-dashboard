import { useState } from 'react';
import type { FormEvent } from 'react';
import { PrimaryButton } from '../../../components/ui/PrimaryButton';
import { InlineMessage } from '../../../components/ui/InlineMessage';
import { useTranslation } from '../../../lib/i18n';
import { AddMemberPanel } from './AddMemberPanel';
import { inputClass, labelClass, type OrgRole } from './roleRules';
import { describeError, type ErrorDisplay } from '../../../lib/errorDisplay';
import type { OrgMember, OrgTeam } from '../../../lib/types';
import type { Announce, Mutations } from './types';

interface TeamEditFormProps {
  team: OrgTeam;
  members: OrgMember[];
  /** Reassigning who heads this team is owner-only (see server/index.js's
   * PATCH /api/org/teams/:id) — a team's own lead can still rename it here,
   * but the manager field is read-only for anyone else. */
  isOwner: boolean;
  /** Only to pass through to the inline "create a lead" panel, which needs to
   * know what this caller is allowed to grant. */
  assignableRoles: OrgRole[];
  mutations: Mutations;
  onDone: () => void;
  announce: Announce;
}

/** Sentinel for the "create the new manager right here" option — mirrors
 * CreateTeamForm, deliberately not a member id and never submitted. */
const ADD_NEW = '__add_new_member__';

/** The team name/manager form — shared by the list row's inline edit
 * (TeamRow.tsx) and the team detail header's "Edit team" panel
 * (TeamDetailView.tsx) so both stay byte-identical instead of drifting into
 * two hand-maintained copies.
 *
 * Handing a team to someone else happens here. The candidates are every team
 * lead in the chart — which includes leads already on this team, so promoting
 * from within is just picking them — plus "+ Add New Member" for a lead who
 * isn't in the chart yet. Only a lead can head a team (see
 * OrgStore._assertValidManager), so that inline form pins the role rather
 * than offering a choice that would be rejected. */
export function TeamEditForm({ team, members, isOwner, assignableRoles, mutations, onDone, announce }: TeamEditFormProps) {
  const t = useTranslation();
  const [name, setName] = useState(team.name);
  const [managerId, setManagerId] = useState(team.managerMemberId ?? '');
  const [isCreatingManager, setIsCreatingManager] = useState(false);
  const [error, setError] = useState<ErrorDisplay | null>(null);

  // The current manager stays listed even if their role no longer qualifies
  // (hand-edited wiki data), so the field shows what is actually set rather
  // than going blank — saving it unchanged is what the server rejects, with a
  // message naming why.
  const candidates = members.filter((m) => m.role === 'lead' || m.id === team.managerMemberId);
  const inThisTeam = candidates.filter((m) => m.teamId === team.id || m.id === team.managerMemberId);
  const elsewhere = candidates.filter((m) => !inThisTeam.includes(m));

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError({ message: t('team.nameRequired') });
      return;
    }
    // Non-owners can't reassign the manager (see the read-only field below),
    // so managerId is always the team's existing one for them — nothing to
    // validate or send beyond the name.
    if (isOwner && (!managerId || managerId === ADD_NEW)) {
      setError({ message: t('team.managerRequired') });
      return;
    }
    setError(null);
    mutations.renameTeam.mutate(
      { id: team.id, patch: isOwner ? { name: name.trim(), managerMemberId: managerId } : { name: name.trim() } },
      {
        onSuccess: () => {
          announce(
            isOwner && managerId !== team.managerMemberId
              ? t('team.nowLedByAnnouncement', { name: team.name })
              : t('team.teamUpdatedAnnouncement')
          );
          onDone();
        },
        onError: (err) => setError(describeError(err, t('team.couldNotUpdateTeam'))),
      }
    );
  }

  return (
    <div className="mt-2 rounded-md border border-border bg-surface-sunken p-3">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <div className="flex-1">
          <label htmlFor={`team-name-${team.id}`} className={labelClass}>
            {t('team.nameLabel')}
          </label>
          <input id={`team-name-${team.id}`} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label htmlFor={`team-manager-${team.id}`} className={labelClass}>
            {t('team.teamManager')}
          </label>
          {isOwner ? (
            // No "No manager": a team always has one. Grouped so promoting
            // someone already on this team is the first thing you see, rather
            // than being buried in an alphabetical list of every lead.
            <select
              id={`team-manager-${team.id}`}
              value={isCreatingManager ? ADD_NEW : managerId}
              onChange={(e) => {
                const next = e.target.value;
                if (next === ADD_NEW) {
                  setIsCreatingManager(true);
                  return;
                }
                setIsCreatingManager(false);
                setManagerId(next);
              }}
              className={inputClass}
            >
              <option value={ADD_NEW}>{t('team.addNewMemberOption')}</option>
              {!managerId && (
                <option value="" disabled>
                  {t('team.selectManagerPlaceholder')}
                </option>
              )}
              {inThisTeam.length > 0 && (
                <optgroup label={t('team.onThisTeamGroup')}>
                  {inThisTeam.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))}
                </optgroup>
              )}
              {elsewhere.length > 0 && (
                <optgroup label={t('team.otherTeamLeadsGroup')}>
                  {elsewhere.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          ) : (
            // Reassigning a team's lead is owner-only (see server/index.js)
            // — shown read-only rather than omitted, so it's clear the field
            // exists and isn't just missing data.
            <p id={`team-manager-${team.id}`} className={`${inputClass} cursor-default bg-surface-sunken`}>
              {candidates.find((m) => m.id === team.managerMemberId)?.displayName ?? '—'}
            </p>
          )}
        </div>
        <PrimaryButton type="submit" disabled={mutations.renameTeam.isPending || isCreatingManager}>
          {t('common.save')}
        </PrimaryButton>
        <button type="button" onClick={onDone} className="focus-ring cursor-pointer rounded-md px-2 py-1.5 text-xs text-ink-subtle hover:text-ink">
          {t('common.cancel')}
        </button>
      </form>

      {/* Same two decisions the Create Team form makes for this flow: the
          role is pinned to Team Lead because only a lead may head a team,
          and parentId is null so a new lead isn't auto-parented under the
          owner. Selecting them still needs a Save. */}
      {isCreatingManager && (
        <AddMemberPanel
          parentId={null}
          teamId={null}
          assignableRoles={assignableRoles}
          fixedRole="lead"
          submitLabel={t('team.createTeamLeadLabel')}
          members={members}
          mutations={mutations}
          announce={announce}
          onCreated={(member) => {
            setManagerId(member.id);
            setIsCreatingManager(false);
          }}
          onDone={() => setIsCreatingManager(false)}
        />
      )}

      {error && (
        <InlineMessage tone="error" detail={error.detail} className="mt-2">
          {error.message}
        </InlineMessage>
      )}
    </div>
  );
}
