import { useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { PrimaryButton } from '../../../components/ui/PrimaryButton';
import { InlineMessage } from '../../../components/ui/InlineMessage';
import { TeamSelect } from './TeamSelect';
import { descendantIds, inputClass, labelClass, managerOptionsFor, roleChangeOptionsFor, roleLabel, type OrgRole } from './roleRules';
import { ApiError } from '../../../lib/api';
import { describeError, type ErrorDisplay } from '../../../lib/errorDisplay';
import { useTranslation } from '../../../lib/i18n';
import { Foreign } from '../../../components/ui/Foreign';
import type { OrgMember, OrgTeam } from '../../../lib/types';
import type { Announce, Mutations } from './types';

interface EditMemberFormProps {
  member: OrgMember;
  members: OrgMember[];
  teams: OrgTeam[];
  assignableRoles: OrgRole[];
  mutations: Mutations;
  onDone: () => void;
  announce: Announce;
}

export function EditMemberForm({ member, members, teams, assignableRoles, mutations, onDone, announce }: EditMemberFormProps) {
  const t = useTranslation();
  const formId = useId();
  const [displayName, setDisplayName] = useState(member.displayName);
  const [role, setRole] = useState<OrgRole>(member.role);
  const [teamId, setTeamId] = useState(member.teamId ?? '');
  const [parentId, setParentId] = useState(member.parentId ?? '');
  const [formError, setFormError] = useState<ErrorDisplay | null>(null);
  // Set when the server refuses a demotion because this person has reports.
  // The message is the server's — it names the count and the destination —
  // and confirming re-sends the same patch with `reassignReports`.
  const [reassignPrompt, setReassignPrompt] = useState<string | null>(null);

  // Role first, then who they report to. "Reports to" lists only people the
  // SELECTED role may legally sit under — a scrum only ever sees team leads,
  // rather than being offered a principal and then told "Only a developer can
  // report to a principal" once they press Save. Never a developer, never one
  // of this member's own descendants. server/orgStore.js enforces all of it.
  const excluded = useMemo(() => {
    const ids = descendantIds(members, member.id);
    ids.add(member.id);
    return ids;
  }, [members, member.id]);
  const parentOptions = useMemo(
    () => managerOptionsFor(members, teams, role, teamId, excluded),
    [members, teams, role, teamId, excluded]
  );

  // Heading a team pins the role: the team is defined by this person's role
  // and every other member's parent was validated against it, so it changes
  // by changing the team's manager instead. server/orgStore.js rejects it
  // either way; this keeps the choice from being offered at all.
  const headedTeam = teams.find((t) => t.managerMemberId === member.id) ?? null;
  const roleOptions = roleChangeOptionsFor(assignableRoles, member, !!headedTeam);
  // Pinned for one of two reasons, each with its own explanation: they head a
  // team, or they are the scrum (a separate track, so there is no promotion
  // or demotion out of it). Either way the control is visibly locked rather
  // than a select with one entry that silently does nothing.
  const roleLock = headedTeam
    ? {
        key: 'heads',
        text: t('team.headsTeamLock', { teamName: headedTeam.name }),
      }
    : member.role === 'scrum'
      ? { key: 'scrum', text: t('team.scrumRoleLock') }
      : null;

  // A role change can invalidate the manager already picked (a developer
  // under a principal promoted to scrum, who may only report to a lead).
  // Drop the now-illegal selection rather than submitting it.
  const parentStillValid = !parentId || parentOptions.some((m) => m.id === parentId);
  const effectiveParentId = parentStillValid ? parentId : '';

  const isOrgRoot = !member.parentId && !member.teamId;

  // Picking a different team in the Team select is the other way into the
  // same decision "+ Add Member" asks (see AddMemberPanel): belonging to two
  // teams at once is a supported state, so changing the team must not quietly
  // assume the old one is being given up. Only asked when they actually have
  // a team to leave, and when they aren't already on the target.
  const movingTeam = !!member.teamId && !!teamId && teamId !== member.teamId;
  const alreadyOnTarget = useMemo(
    () => (movingTeam ? members.some((m) => m.email === member.email && m.teamId === teamId) : false),
    [movingTeam, members, member.email, teamId]
  );
  const [placement, setPlacement] = useState<'move' | 'both'>('move');
  const keepBoth = movingTeam && !alreadyOnTarget && placement === 'both';
  const teamNameOf = (id: string | null) => (id ? teams.find((t) => t.id === id)?.name ?? null : null);

  function save(reassignReports: boolean) {
    // "Stay on both" leaves this row exactly as it is and creates a second
    // membership. The role and manager on this form describe the NEW team —
    // that is the one being set up — while the existing membership keeps its
    // own, which is the whole point of memberships being independent.
    if (keepBoth) {
      mutations.addMember.mutate(
        { email: member.email, displayName: displayName.trim() || undefined, role, teamId, parentId: effectiveParentId || null },
        {
          onSuccess: () => {
            announce(
              t('team.addedToTeamAsWellAnnouncement', {
                name: displayName.trim() || member.displayName,
                teamName: teamNameOf(teamId) ?? t('team.thisTeamFallback'),
              })
            );
            onDone();
          },
          onError: (err) => setFormError(describeError(err, t('team.couldNotAddToTeam'))),
        }
      );
      return;
    }
    mutations.editMember.mutate(
      {
        id: member.id,
        patch: {
          displayName: displayName.trim(),
          role,
          teamId: teamId || null,
          parentId: effectiveParentId || null,
          ...(reassignReports ? { reassignReports: true } : {}),
        },
      },
      {
        onSuccess: () => {
          announce(t('team.savedAnnouncement', { name: displayName.trim() || member.displayName }));
          onDone();
        },
        onError: (err) => {
          // A demotion with reports isn't a failure, it's a question — the
          // server answers with the consequence (how many reports, and
          // where they'd go) via err.details, not err.message (always
          // English) — see contracts/error-details.md and T060.
          if (err instanceof ApiError && err.code === 'REPORTS_REASSIGN_REQUIRED' && err.details) {
            const reportCount = err.details.reportCount ?? 0;
            const newManagerName = err.details.newManagerName ?? null;
            const summary = t('error.reportsReassignSummary', { name: member.displayName, count: reportCount });
            const destination = newManagerName
              ? t('error.reportsMoveToManager', { name: newManagerName })
              : t('error.reportsMoveToTop');
            setReassignPrompt(`${summary} ${destination}`);
            return;
          }
          setFormError(describeError(err, t('team.couldNotSavePerson')));
        },
      }
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    // The organization root (the owner) legitimately has neither a team nor
    // a parent. Everyone else must have both — no "Unknown parent" state.
    if (!isOrgRoot) {
      if (!teamId) {
        setFormError({ message: t('team.pickTeamForPerson') });
        return;
      }
      if (parentOptions.length > 0 && !effectiveParentId) {
        setFormError({ message: t('team.pickReportsTo') });
        return;
      }
      if (parentOptions.length === 0) {
        setFormError({ message: t('team.nobodyCanHaveRoleReport', { role: roleLabel(role).toLowerCase() }) });
        return;
      }
    }
    setFormError(null);
    setReassignPrompt(null);
    save(false);
  }

  return (
    <form onSubmit={submit} className="ms-4 mt-1 space-y-2 rounded-md border border-border bg-surface-sunken p-3">
      <div>
        <label htmlFor={`${formId}-name`} className={labelClass}>
          {t('team.nameLabel')}
        </label>
        <input id={`${formId}-name`} type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={inputClass} />
      </div>

      <div className="flex flex-wrap gap-3">
        <div>
          <label htmlFor={`${formId}-role`} className={labelClass}>
            {t('team.memberRole')}
          </label>
          <select
            id={`${formId}-role`}
            value={role}
            onChange={(e) => {
              setRole(e.target.value as OrgRole);
              // Picking a different role invalidates the pending "…and their
              // reports move to X" confirmation — it was about the old one.
              setReassignPrompt(null);
            }}
            disabled={!!roleLock}
            aria-describedby={roleLock ? `${formId}-role-locked` : undefined}
            className={`${inputClass} disabled:cursor-not-allowed disabled:opacity-60`}
          >
            {roleOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {roleLabel(o.value)}
              </option>
            ))}
          </select>
          {roleLock && (
            <p id={`${formId}-role-locked`} className="mt-1 max-w-[16rem] text-xs text-ink-subtle">
              {roleLock.text}
            </p>
          )}
        </div>
        {/* The organization root (the owner) sits outside every team and
            reports to nobody, so it gets neither picker. Everyone else must
            have both — there is no "no team" and no "— none —" parent. */}
        {!isOrgRoot && (
          <>
            <div>
              <label htmlFor={`${formId}-team`} className={labelClass}>
                {t('team.memberTeam')}
              </label>
              <TeamSelect
                id={`${formId}-team`}
                value={teamId}
                onChange={(next) => {
                  setTeamId(next);
                  // Changing team invalidates whatever "reports to" was picked
                  // for the old one — clear it rather than silently keeping a
                  // now out-of-scope manager selected.
                  setParentId('');
                }}
                teams={teams}
              />
            </div>
            {parentOptions.length > 0 && (
              <div>
                <label htmlFor={`${formId}-parent`} className={labelClass}>
                  {t('team.memberParent')}
                </label>
                <select id={`${formId}-parent`} value={effectiveParentId} onChange={(e) => setParentId(e.target.value)} className={inputClass}>
                  {!effectiveParentId && (
                    <option value="" disabled>
                      {t('team.selectEllipsis')}
                    </option>
                  )}
                  {parentOptions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </>
        )}
      </div>

      {/* The team changed, so the old membership's fate is a real question —
          asked here rather than assumed. Same two answers as the Add Member
          panel, worded from this direction. */}
      {movingTeam && !alreadyOnTarget && (
        <fieldset>
          <legend className={labelClass}>
            {t('team.movingFromToLegend', {
              fromTeam: teamNameOf(member.teamId) ?? t('team.theirTeamFallback'),
              toTeam: teamNameOf(teamId) ?? t('team.thisTeamFallback'),
            })}
          </legend>
          <div className="space-y-1">
            {(
              [
                ['move', t('team.moveLeavesOldTeam', { teamName: teamNameOf(member.teamId) ?? t('team.theOldTeamFallback') })],
                ['both', t('team.keepBothTeams', { teamName: teamNameOf(member.teamId) ?? t('team.theOldTeamFallback') })],
              ] as const
            ).map(([value, text]) => (
              <label key={value} className="flex cursor-pointer items-start gap-2 text-xs text-ink">
                <input
                  type="radio"
                  name={`${formId}-placement`}
                  value={value}
                  checked={placement === value}
                  onChange={() => setPlacement(value)}
                  className="focus-ring mt-0.5 cursor-pointer accent-accent"
                />
                <span>{text}</span>
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-ink-subtle">
            {keepBoth
              ? t('team.keepBothHint', {
                  newTeam: teamNameOf(teamId) ?? t('team.newTeamFallback'),
                  oldTeam: teamNameOf(member.teamId) ?? t('team.existingFallback'),
                })
              : t('team.reportsMoveUpHint')}
          </p>
        </fieldset>
      )}

      {movingTeam && alreadyOnTarget && (
        <InlineMessage tone="error">{t('team.alreadyOnTargetTeam', { teamName: teamNameOf(teamId) ?? t('team.thisTeamFallback') })}</InlineMessage>
      )}

      {formError && <InlineMessage tone="error" detail={formError.detail}>{formError.message}</InlineMessage>}
      {reassignPrompt && <InlineMessage tone="warning">{reassignPrompt}</InlineMessage>}

      <div className="flex gap-2">
        {reassignPrompt ? (
          <PrimaryButton type="button" onClick={() => save(true)} disabled={mutations.editMember.isPending}>
            {mutations.editMember.isPending ? t('team.savingEllipsis') : t('team.saveAndMoveThem')}
          </PrimaryButton>
        ) : (
          <PrimaryButton type="submit" disabled={mutations.editMember.isPending || mutations.addMember.isPending || alreadyOnTarget}>
            {mutations.editMember.isPending || mutations.addMember.isPending
              ? t('team.savingEllipsis')
              : keepBoth
                ? t('team.addToBothTeams')
                : movingTeam
                  ? t('team.moveToThisTeam')
                  : t('common.save')}
          </PrimaryButton>
        )}
        <button type="button" onClick={onDone} className="focus-ring cursor-pointer rounded-md px-2 py-1.5 text-xs text-ink-subtle transition-colors hover:text-ink">
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

