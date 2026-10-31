import { useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { PrimaryButton } from '../../../components/ui/PrimaryButton';
import { InlineMessage } from '../../../components/ui/InlineMessage';
import { useTranslation } from '../../../lib/i18n';
import { PersonCombobox } from './PersonCombobox';
import { roleLabel, roleOptionsFor, roleOptionsUnder, inputClass, labelClass, type OrgRole } from './roleRules';
import { describeError, type ErrorDisplay } from '../../../lib/errorDisplay';
import type { OrgMember, OrgTeam, Person } from '../../../lib/types';
import type { Announce, Mutations } from './types';

interface AddMemberPanelProps {
  /** The default "Reports to". Null when the caller has no single obvious
   * parent — the team picker below then drives it. */
  parentId: string | null;
  teamId: string | null;
  assignableRoles: OrgRole[];
  mutations: Mutations;
  onDone: () => void;
  announce: Announce;
  /** Candidate parents within the team. Rendered as a "Reports to" select
   * whenever there's more than one — the team-level "+ Add Member" button
   * replaced the old per-row "+", so this is how someone gets placed under a
   * principal rather than under the team manager. */
  parentOptions?: OrgMember[];
  /** Everyone already in the chart. Used to recognise an email that is
   * already a member — see the move-vs-add-as-well branch in `submit`. */
  members?: OrgMember[];
  /** Only to name the team someone is currently on, in that same branch. */
  teams?: OrgTeam[];
  /** Pins the role and hides the picker entirely. Used when minting a team's
   * manager from the Create Team form: that person exists precisely to head
   * the new team, so the role is a foregone conclusion rather than a
   * question. It is still shown read-only, so the outcome isn't invisible.
   * Everywhere else the normal role/permission rules keep applying. */
  fixedRole?: OrgRole;
  submitLabel?: string;
  /** Receives the created member, for callers that need to act on it (the
   * Create Team form auto-selects a freshly minted manager). */
  onCreated?: (member: OrgMember) => void;
}

/** The "add person" panel — directory pick or a raw email. Only roles the
 * caller may assign are offered (assignableRoles, echoed from the server on
 * OrgResponse), intersected with what may legally report to the chosen
 * parent (rolesAllowedUnder — a principal takes developers only). The server
 * enforces both; this just avoids offering a rejected combination. */
export function AddMemberPanel({
  parentId,
  teamId,
  assignableRoles,
  mutations,
  onDone,
  announce,
  parentOptions,
  members = [],
  teams = [],
  fixedRole,
  submitLabel,
  onCreated,
}: AddMemberPanelProps) {
  const t = useTranslation();
  const effectiveSubmitLabel = submitLabel ?? t('team.addPersonDefault');
  const formId = useId();
  const teamNameOf = (id: string | null) => (id ? teams.find((t) => t.id === id)?.name ?? null : null);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [reportsTo, setReportsTo] = useState(parentId ?? '');
  const [formError, setFormError] = useState<ErrorDisplay | null>(null);

  const candidates = parentOptions ?? [];
  const parentRole = useMemo(() => candidates.find((m) => m.id === reportsTo)?.role, [candidates, reportsTo]);

  // Someone can already be in the chart and simply belong elsewhere — most
  // obviously the dashboard owner, whose row exists from the moment they
  // first opened this screen. Refusing with "already in the org chart" was a
  // dead end: this form already collects everything needed to place them.
  //
  // `elsewhere` is their membership of some OTHER team, which is the case
  // that needs a decision: move them here, or add this team alongside the one
  // they already have. `alreadyHere` is a membership of THIS team, which is
  // nothing to decide — they are already in it.
  const { elsewhere, alreadyHere } = useMemo(() => {
    const target = email.trim().toLowerCase();
    if (!target) return { elsewhere: null, alreadyHere: null };
    const rows = members.filter((m) => m.email.toLowerCase() === target);
    return {
      elsewhere: rows.find((m) => (m.teamId ?? null) !== (teamId ?? null)) ?? null,
      alreadyHere: rows.find((m) => (m.teamId ?? null) === (teamId ?? null)) ?? null,
    };
  }, [members, email, teamId]);

  /** 'move' rewrites their existing membership to point at this team;
   * 'both' leaves it alone and creates a second one. Only asked when they
   * are actually on another team. */
  const [placement, setPlacement] = useState<'move' | 'both'>('move');
  const isMove = !!elsewhere && placement === 'move';

  const roleOptions = useMemo(() => {
    if (fixedRole) return [];
    // With no parent at all the person is a chart root (a freshly minted
    // team manager), so no parent-role constraint applies — only what the
    // caller may assign. Running the matrix here would return nothing and
    // leave the role select empty.
    return parentRole ? roleOptionsUnder(assignableRoles, parentRole) : roleOptionsFor(assignableRoles);
  }, [assignableRoles, parentRole, fixedRole]);

  const [role, setRole] = useState<OrgRole>('developer');
  const effectiveRole = fixedRole ?? (roleOptions.some((o) => o.value === role) ? role : roleOptions[0]?.value);

  function pick(person: Person) {
    setEmail(person.uniqueName ?? '');
    setDisplayName(person.displayName);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!email.trim()) {
      setFormError({ message: t('team.pickFromDirectory') });
      return;
    }
    if (!effectiveRole) {
      setFormError({ message: t('team.noRoleUnderPerson') });
      return;
    }
    const parent = candidates.length > 0 ? reportsTo || null : parentId;
    if (candidates.length > 0 && !parent) {
      setFormError({ message: t('team.pickReportsTo') });
      return;
    }
    if (alreadyHere) {
      setFormError({ message: t('team.alreadyOnThisTeam', { name: alreadyHere.displayName }) });
      return;
    }
    const label = displayName.trim() || elsewhere?.displayName || email.trim();

    // Moving rewrites the membership they already have. Adding to both leaves
    // it alone and falls through to createMember below, which now only
    // rejects a duplicate within the SAME team.
    if (isMove) {
      mutations.editMember.mutate(
        { id: elsewhere.id, patch: { role: effectiveRole, teamId, parentId: parent } },
        {
          onSuccess: (result) => {
            announce(t('team.movedAnnouncement', { name: label }));
            onCreated?.(result.member);
            onDone();
          },
          onError: (err) => setFormError(describeError(err, t('team.couldNotMovePerson'))),
        }
      );
      return;
    }

    mutations.addMember.mutate(
      {
        email: email.trim(),
        displayName: displayName.trim() || undefined,
        role: effectiveRole,
        teamId,
        parentId: parent,
      },
      {
        onSuccess: (result) => {
          announce(
            elsewhere
              ? t('team.addedToTeamAlsoAnnouncement', { name: label })
              : t('team.addedPersonAnnouncement', { name: label })
          );
          onCreated?.(result.member);
          onDone();
        },
        onError: (err) => setFormError(describeError(err, t('team.couldNotAddPerson'))),
      }
    );
  }

  return (
    <form onSubmit={submit} className="mt-2 space-y-2 rounded-md border border-border bg-surface-sunken p-3">
      <PersonCombobox label={t('team.findPerson')} onPick={pick} />

      <div>
        <label htmlFor={`${formId}-email`} className={labelClass}>
          {t('team.memberEmail')} {!email && <span className="text-ink-subtle">{t('team.emailHint')}</span>}
        </label>
        <input id={`${formId}-email`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('team.emailPlaceholder')} className={inputClass} />
        {alreadyHere && (
          <p className="mt-1 text-xs text-ink-subtle">
            {t('team.alreadyOnThisTeam', { name: alreadyHere.displayName })}
          </p>
        )}
      </div>

      {/* Someone already on another team is the one case with a real
          decision behind it, so it is asked rather than assumed. Belonging
          to both is a first-class state: each membership carries its own
          role and its own manager, and removing one leaves the other. */}
      {elsewhere && !alreadyHere && (
        <fieldset>
          <legend className={labelClass}>
            {t('team.onAnotherTeamLegend', {
              name: elsewhere.displayName,
              teamName: teamNameOf(elsewhere.teamId) ?? t('team.anotherTeamFallback'),
            })}
          </legend>
          <div className="space-y-1">
            {(
              [
                ['move', t('team.moveHereOption', { teamName: teamNameOf(elsewhere.teamId) ?? t('team.otherTeamFallback') })],
                ['both', t('team.addBothOption')],
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
          {placement === 'move' && (
            <p className="mt-1 text-xs text-ink-subtle">{t('team.reportsMoveUpHint')}</p>
          )}
        </fieldset>
      )}

      <div>
        <label htmlFor={`${formId}-name`} className={labelClass}>
          {t('team.nameOptionalLabel')}
        </label>
        <input id={`${formId}-name`} type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={inputClass} />
      </div>

      <div className="flex flex-wrap gap-2">
        {/* Parent first here, role second — the inverse of EditMemberForm,
            where the person already exists and their role is the fixed point.
            Adding starts from "where does this person go", so the role list
            narrows to what may sit there (a scrum only under a lead). */}
        {candidates.length > 0 && (
          <div>
            <label htmlFor={`${formId}-reports-to`} className={labelClass}>
              {t('team.memberParent')}
            </label>
            <select
              id={`${formId}-reports-to`}
              value={reportsTo}
              onChange={(e) => setReportsTo(e.target.value)}
              className={inputClass}
            >
              {!reportsTo && <option value="">{t('team.selectEllipsis')}</option>}
              {candidates.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* The role field disappears rather than degrading into an empty or
            placeholder-only picker: it is either pinned (see `fixedRole`),
            or a real choice, or — when nothing may legally report to the
            selected parent — replaced by the explanation below. */}
        {fixedRole ? (
          <div>
            <span className={labelClass}>{t('team.memberRole')}</span>
            <p className="py-1.5 text-xs font-medium text-ink">{roleLabel(fixedRole)}</p>
          </div>
        ) : (
          roleOptions.length > 0 && (
            <div>
              <label htmlFor={`${formId}-role`} className={labelClass}>
                {t('team.memberRole')}
              </label>
              <select
                id={`${formId}-role`}
                value={effectiveRole ?? ''}
                onChange={(e) => setRole(e.target.value as OrgRole)}
                className={inputClass}
              >
                {roleOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {roleLabel(o.value)}
                  </option>
                ))}
              </select>
            </div>
          )
        )}
      </div>

      {!fixedRole && roleOptions.length === 0 && (
        <InlineMessage tone="error">
          {parentRole
            ? t('team.cantAddUnderRole', { role: roleLabel(parentRole).toLowerCase() })
            : t('team.notAllowedToAddHere')}
        </InlineMessage>
      )}

      {formError && <InlineMessage tone="error" detail={formError.detail}>{formError.message}</InlineMessage>}

      <div className="flex gap-2">
        <PrimaryButton
          type="submit"
          disabled={mutations.addMember.isPending || mutations.editMember.isPending || !effectiveRole || !!alreadyHere}
        >
          {mutations.addMember.isPending || mutations.editMember.isPending
            ? isMove
              ? t('team.movingEllipsis')
              : t('team.addingEllipsis')
            : isMove
              ? t('team.moveToThisTeam')
              : elsewhere
                ? t('team.addToThisTeamAlso')
                : effectiveSubmitLabel}
        </PrimaryButton>
        <button type="button" onClick={onDone} className="focus-ring cursor-pointer rounded-md px-2 py-1.5 text-xs text-ink-subtle transition-colors hover:text-ink">
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}
