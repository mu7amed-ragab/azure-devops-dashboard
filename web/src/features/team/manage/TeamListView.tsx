import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { Toolbar } from '../../../components/ui/Toolbar';
import { SearchInput } from '../../../components/ui/SearchInput';
import { PrimaryButton } from '../../../components/ui/PrimaryButton';
import { useTranslation } from '../../../lib/i18n';
import { CreateTeamForm } from './CreateTeamForm';
import { TeamRow } from './TeamRow';
import type { OrgMember, OrgTeam } from '../../../lib/types';
import type { Announce, Mutations } from './types';
import type { OrgRole } from './roleRules';

interface TeamListViewProps {
  teams: OrgTeam[];
  members: OrgMember[];
  self: OrgMember | null;
  isOwner: boolean;
  assignableRoles: OrgRole[];
  mutations: Mutations;
  announce: Announce;
  onManage: (teamId: string) => void;
  /** Set by the caller right after returning from a team's detail view —
   * moves focus back to that team's "Manage" button instead of leaving it
   * stranded, then must be cleared via `onFocusHandled` so it doesn't
   * re-fire on every unrelated re-render. */
  focusTeamId?: string | null;
  onFocusHandled?: () => void;
}

/** The Manage Teams landing screen: what teams exist, who runs each, how
 * big is each, and how to create or open one — the full member hierarchy
 * lives one level deeper, behind "Manage" (see TeamDetailView.tsx). */
export function TeamListView({
  teams,
  members,
  self,
  isOwner,
  assignableRoles,
  mutations,
  announce,
  onManage,
  focusTeamId,
  onFocusHandled,
}: TeamListViewProps) {
  const t = useTranslation();
  const [search, setSearch] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  // Membership is `teamId` — never the manager's parentId subtree. Counting
  // descendants (as this used to) made every team sharing one manager report
  // the same size, which is the same bug the rosters had.
  const countByTeam = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of members) {
      if (!m.teamId) continue;
      counts.set(m.teamId, (counts.get(m.teamId) ?? 0) + 1);
    }
    return counts;
  }, [members]);

  // The dashboard owner gets no special row here. Their org-chart record
  // exists (it carries their admin capability and makes them selectable as a
  // manager), but this screen shows teams — the owner appears in it only
  // once they are deliberately put on a team or chosen to head one, with a
  // role picked like anyone else.

  // Search is the only filter here. A "Mine | All" scope toggle used to sit
  // beside it; it was removed as chrome — the list is short, everyone who
  // reaches this screen manages the teams they can see, and search already
  // matches the manager's name.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return teams;
    return teams.filter((t) => {
      const manager = t.managerMemberId ? memberById.get(t.managerMemberId) : null;
      return t.name.toLowerCase().includes(q) || (manager ? manager.displayName.toLowerCase().includes(q) : false);
    });
  }, [teams, search, memberById]);

  function canManageTeam(team: OrgTeam) {
    return isOwner || (!!self && team.managerMemberId === self.id);
  }

  useEffect(() => {
    if (!focusTeamId) return;
    document.getElementById(`team-manage-${focusTeamId}`)?.focus();
    onFocusHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTeamId]);

  return (
    <div className="space-y-3">
      <Toolbar aria-label={t('team.searchActionsAriaLabel')}>
        <SearchInput value={search} onChange={setSearch} placeholder={t('team.searchTeamsPlaceholder')} maxWidth={220} />
        {/* Adding a team is a structural chart change — owner-only, same as
            deleting one or reassigning its lead (see TeamDetailView.tsx). */}
        {isOwner && (
          <PrimaryButton className="ms-auto flex items-center gap-1.5" onClick={() => setIsCreating((v) => !v)}>
            <Plus size={14} />
            {t('team.addTeam')}
          </PrimaryButton>
        )}
      </Toolbar>

      {isOwner && isCreating && (
        <CreateTeamForm
          members={members}
          selfId={self ? self.id : null}
          assignableRoles={assignableRoles}
          mutations={mutations}
          announce={announce}
          onDone={() => setIsCreating(false)}
        />
      )}

      {teams.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-ink-subtle">{t('team.noTeamsYet')}</p>
      ) : filtered.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-4 text-center">
          <p className="text-xs text-ink-subtle">{t('team.noTeamsMatch', { query: search.trim() })}</p>
          <button
            type="button"
            onClick={() => setSearch('')}
            className="focus-ring mt-1 cursor-pointer rounded-md px-2 py-1 text-xs font-medium text-accent hover:underline"
          >
            {t('team.clearSearch')}
          </button>
        </div>
      ) : (
        <div className="rounded-md border border-border">
          {filtered.map((team) => (
            <TeamRow
              key={team.id}
              team={team}
              members={members}
              manager={team.managerMemberId ? memberById.get(team.managerMemberId) ?? null : null}
              memberCount={countByTeam.get(team.id) ?? 0}
              canManage={canManageTeam(team)}
              isOwner={isOwner}
              assignableRoles={assignableRoles}
              onManage={() => onManage(team.id)}
              mutations={mutations}
              announce={announce}
            />
          ))}
        </div>
      )}
    </div>
  );
}
