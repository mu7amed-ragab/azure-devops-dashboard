import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { PrimaryButton } from '../../../components/ui/PrimaryButton';
import { InlineMessage } from '../../../components/ui/InlineMessage';
import { useTranslation } from '../../../lib/i18n';
import { AddMemberPanel } from './AddMemberPanel';
import { teamManagerOptions, inputClass, labelClass, type OrgRole } from './roleRules';
import { describeError, type ErrorDisplay } from '../../../lib/errorDisplay';
import type { OrgMember } from '../../../lib/types';
import type { Announce, Mutations } from './types';

interface CreateTeamFormProps {
  members: OrgMember[];
  selfId: string | null;
  /** Echoed from the server on OrgResponse — the roles this caller may
   * actually grant. Passed straight through to the inline member form so a
   * lead is never offered something the server would reject. */
  assignableRoles: OrgRole[];
  mutations: Mutations;
  announce: Announce;
  /** Called after a successful create — lets a caller collapse an inline
   * panel (see TeamListView.tsx) without this form needing to know it's
   * being shown inside one. */
  onDone?: () => void;
}

/** Sentinel for the "create the manager right here" option. Deliberately not
 * a member id, and never submitted. */
const ADD_NEW = '__add_new_member__';

export function CreateTeamForm({ members, selfId, assignableRoles, mutations, announce, onDone }: CreateTeamFormProps) {
  const t = useTranslation();
  const formId = useId();
  const [name, setName] = useState('');
  // No default manager. It used to preselect the caller, which combined with
  // the server's own fallback made the dashboard owner the lead of every
  // team by accident — owner and team lead are separate things, and the
  // manager is now always an explicit choice.
  const [managerId, setManagerId] = useState('');
  const [isCreatingManager, setIsCreatingManager] = useState(false);
  const [formError, setFormError] = useState<ErrorDisplay | null>(null);

  // Team leads only — see teamManagerOptions. Anyone else in the chart is
  // simply not offered, rather than being offered and then rejected on save.
  const eligibleManagers = teamManagerOptions(members);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setFormError({ message: t('team.nameRequired') });
      return;
    }
    if (!managerId || managerId === ADD_NEW) {
      setFormError({ message: t('team.managerRequired') });
      return;
    }
    setFormError(null);
    mutations.createTeam.mutate(
      { name: name.trim(), managerMemberId: managerId },
      {
        onSuccess: () => {
          announce(t('team.addedTeamAnnouncement', { name: name.trim() }));
          setName('');
          setManagerId('');
          onDone?.();
        },
        onError: (err) => setFormError(describeError(err, t('team.couldNotAddTeam'))),
      }
    );
  }

  return (
    <div className="rounded-md border border-dashed border-border p-3">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <div className="min-w-[8rem] flex-1">
          <label htmlFor={`${formId}-name`} className={labelClass}>
            {t('team.addTeamFieldLabel')}
          </label>
          <input
            id={`${formId}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('team.teamNamePlaceholder')}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor={`${formId}-manager`} className={labelClass}>
            {t('team.teamManager')}
          </label>
          <select
            id={`${formId}-manager`}
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
            {/* First option, per spec: create the manager inline rather than
                forcing a trip elsewhere to add them first. There is
                deliberately no "None" — a team always has a manager. */}
            <option value={ADD_NEW}>{t('team.addNewMemberOption')}</option>
            {!managerId && (
              <option value="" disabled>
                {t('team.selectManagerPlaceholder')}
              </option>
            )}
            {eligibleManagers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
                {m.id === selfId ? t('team.youSuffix') : ''}
              </option>
            ))}
          </select>
        </div>
        <PrimaryButton type="submit" disabled={mutations.createTeam.isPending || isCreatingManager}>
          {t('common.add')}
        </PrimaryButton>
      </form>

      {/* Reuses the ordinary member-creation flow rather than a second
          system. Two things are decided for the user here, because this
          flow exists for exactly one purpose:
            - role is pinned to Team Lead — someone created to head a team is
              a team lead by definition, so there is nothing to choose;
            - parentId is null, making them a chart root. A team manager must
              not be auto-parented under the owner, who stays outside the
              reporting hierarchy unless explicitly picked.
          Neither applies to the ordinary Add Member flow, which keeps the
          full role/permission rules. */}
      {isCreatingManager && (
        <AddMemberPanel
          parentId={null}
          teamId={null}
          assignableRoles={assignableRoles}
          fixedRole="lead"
          submitLabel={t('team.createManagerLabel')}
          mutations={mutations}
          announce={announce}
          onCreated={(member) => {
            setManagerId(member.id);
            setIsCreatingManager(false);
          }}
          onDone={() => setIsCreatingManager(false)}
        />
      )}

      {formError && (
        <InlineMessage tone="error" detail={formError.detail} className="mt-2">
          {formError.message}
        </InlineMessage>
      )}
    </div>
  );
}
