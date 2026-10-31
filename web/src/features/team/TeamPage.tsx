import { useEffect, useState } from 'react';
import { ChevronsDownUp, ChevronsUpDown, Users, Settings } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { useMe } from '../../lib/useMe';
import { useTeam } from '../../lib/useTeam';
import { TeamMemberSection } from '../../components/TeamMemberSection';
import { Menu } from '../../components/Menu';
import type { MenuSection } from '../../components/Menu';
import { LoadingView, ErrorView, EmptyView } from '../../components/StatusView';
import { Toolbar } from '../../components/ui/Toolbar';
import { usePersistedSet } from '../../lib/persistedState';
import { ManageTeamModal } from './ManageTeamModal';
import { useTranslation } from '../../lib/i18n';
import { roleLabel } from './manage/roleRules';

export function TeamPage() {
  const t = useTranslation();
  const { role, isLoading: roleLoading, canAdminOrg, canSeeTeamPage } = useMe();
  const team = useTeam();
  const [selectedIds, setSelectedIds] = usePersistedSet<string>('team:selected-members');
  const [expandSignal, setExpandSignal] = useState(0);
  const [collapseSignal, setCollapseSignal] = useState(0);
  const [manageOpen, setManageOpen] = useState(false);

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const members = team.data?.members ?? [];

  // selectedIds is persisted in localStorage, so it can outlive the roster
  // it was chosen from — a member removed from the team (or the whole set
  // seeded before the roster ever loaded) leaves ids in there that match no
  // current member. Left alone, `selectedIds.size` disagrees with what's
  // actually shown: the "Show members (N)" badge counts ghosts nothing in
  // the menu is checked against. Once the roster is known, drop anything
  // that doesn't belong to it.
  //
  // Must run unconditionally, before the roleLoading/canSeeTeamPage early
  // returns below — a hook placed after an early return fires on some
  // renders and not others (this one doesn't run while roleLoading, then
  // does once it resolves), which is exactly React error #310 ("rendered
  // more hooks than during the previous render").
  useEffect(() => {
    if (!team.data) return;
    const validIds = new Set(members.map((m) => m.id));
    setSelectedIds((prev) => {
      if ([...prev].every((id) => validIds.has(id))) return prev;
      const next = new Set([...prev].filter((id) => validIds.has(id)));
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team.data]);

  // A role that hasn't loaded yet must not be treated as "no role" — that
  // would flash-redirect every visitor away before /api/people even answers.
  if (roleLoading) return <LoadingView label={t('common.loading')} />;
  if (!canSeeTeamPage) return <Navigate to="/" replace />;

  const groups = team.data?.groups ?? [];
  const selectedMembers = members.filter((m) => selectedIds.has(m.id));

  // Grouping is only worth surfacing once there's more than one group — a
  // Principal's roster (their direct reports only) collapses to a single
  // group, so the flat picker below is what they'd see anyway. Not
  // memoized — groups/members/selectedIds already change on every render
  // that matters, and the list sizes here are small (a team roster, not a
  // work-item table).
  // Anyone the server's groups don't mention. Should be nobody — the groups
  // and the members list are folded the same way (see org.js's
  // rosterGroupsForEmail) — but when they did drift, the picker rendered
  // only grouped people while the badge counted every member, so an
  // unreachable member showed up as a phantom "(1)" that couldn't be
  // cleared. Rendering the leftovers keeps the two in step whatever the
  // server sends.
  const groupedIds = new Set(groups.flatMap((g) => g.memberIds));
  const ungrouped = members.filter((m) => !groupedIds.has(m.id));

  const sections: MenuSection[] | null =
    groups.length <= 1 && ungrouped.length === 0
      ? null
      : [...groups, ...(ungrouped.length > 0 ? [{ id: 'ungrouped', label: t('team.othersGroup'), memberIds: ungrouped.map((m) => m.id) }] : [])].map((g) => {
          const groupMembers = members.filter((m) => g.memberIds.includes(m.id));
          const allSelected = groupMembers.length > 0 && groupMembers.every((m) => selectedIds.has(m.id));
          return {
            id: g.id,
            label: g.label,
            allSelected,
            onSelectAll: () =>
              setSelectedIds((prev) => {
                const next = new Set(prev);
                if (allSelected) {
                  for (const m of groupMembers) next.delete(m.id);
                } else {
                  for (const m of groupMembers) next.add(m.id);
                }
                return next;
              }),
            options: groupMembers.map((m) => ({
              id: m.id,
              label: m.displayName,
              checked: selectedIds.has(m.id),
              onToggle: () => toggleSelected(m.id),
            })),
          };
        });

  return (
    <div className="space-y-6">
      <div className="flex items-baseline gap-2">
        <h1 className="text-lg font-semibold tracking-tight text-ink">{t('team.heading')}</h1>
        <span className="text-xs text-ink-subtle">
          {role ? roleLabel(role) : ''} — {t('team.followedWork')}{canAdminOrg ? '' : t('team.readOnlySuffix')}
        </span>
      </div>

      <Toolbar aria-label={t('team.rosterControlsAriaLabel')}>
        {team.isLoading ? (
          <p className="text-xs text-ink-subtle">{t('team.loadingRoster')}</p>
        ) : members.length === 0 ? (
          <p className="text-xs text-ink-subtle">
            {/* An empty roster in a project with no wiki isn't "no team" — the
                chart has nowhere to live yet. See server/orgStore.js. */}
            {team.data && team.data.wikiAvailable === false
              ? t('team.wikiMissingRoster')
              : canAdminOrg
                ? t('team.noOneOnTeamCanAdmin')
                : t('team.noOneOnTeam')}
          </p>
        ) : (
          <Menu
            label={selectedMembers.length === 0 ? t('team.showMembers') : t('team.showMembersCount', { count: selectedMembers.length })}
            icon={Users}
            sections={sections ?? undefined}
            options={
              sections
                ? undefined
                : members.map((m) => ({
                    id: m.id,
                    label: m.displayName,
                    checked: selectedIds.has(m.id),
                    onToggle: () => toggleSelected(m.id),
                  }))
            }
          />
        )}
        <div className="ms-auto flex shrink-0 items-center gap-1">
          {selectedMembers.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setExpandSignal((v) => v + 1)}
                className="focus-ring flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs text-ink-subtle transition-colors hover:bg-surface-sunken hover:text-ink"
                title={t('team.expandAllMembersTitle')}
              >
                <ChevronsUpDown size={14} />
                <span>{t('workitems.expandAll')}</span>
              </button>
              <button
                type="button"
                onClick={() => setCollapseSignal((v) => v + 1)}
                className="focus-ring flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs text-ink-subtle transition-colors hover:bg-surface-sunken hover:text-ink"
                title={t('team.collapseAllMembersTitle')}
              >
                <ChevronsDownUp size={14} />
                <span>{t('workitems.collapseAll')}</span>
              </button>
            </>
          )}
          {canAdminOrg && (
            <button
              type="button"
              data-shot="manage-team"
              onClick={() => setManageOpen(true)}
              className="focus-ring flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs text-ink-subtle transition-colors hover:bg-surface-sunken hover:text-ink"
            >
              <Settings size={14} />
              <span>{t('team.manageTeamButton')}</span>
            </button>
          )}
        </div>
      </Toolbar>

      {selectedMembers.length === 0 ? (
        <EmptyView>
          {members.length === 0 ? t('team.nothingToShowYet') : t('team.pickMembersToSeeWork')}
        </EmptyView>
      ) : (
        <div className="space-y-3">
          {selectedMembers.map((m) => (
            <TeamMemberSection
              key={m.id}
              person={m}
              defaultOpen
              expandSignal={expandSignal}
              collapseSignal={collapseSignal}
            />
          ))}
        </div>
      )}

      {team.isError && members.length === 0 && (
        <ErrorView message={t('team.couldNotLoadRoster')} onRetry={() => team.refetch()} />
      )}

      {manageOpen && <ManageTeamModal onClose={() => setManageOpen(false)} />}
    </div>
  );
}
