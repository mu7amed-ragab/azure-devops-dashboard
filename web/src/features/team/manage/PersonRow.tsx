import type { KeyboardEvent } from 'react';
import { ChevronRight, Pencil, Trash2 } from 'lucide-react';
import { IconButton } from '../../../components/ui/IconButton';
import { Pill } from '../../../components/ui/Pill';
import { DirectionalIcon } from '../../../components/ui/DirectionalIcon';
import { EditMemberForm } from './EditMemberForm';
import { useTranslation } from '../../../lib/i18n';
import { Foreign } from '../../../components/ui/Foreign';
import { roleLabel } from './roleRules';
import type { OrgMember, OrgTeam } from '../../../lib/types';
import type { Announce, Mutations } from './types';
import type { OrgRole } from './roleRules';

interface PersonRowProps {
  member: OrgMember;
  level: number;
  setSize: number;
  posInSet: number;
  members: OrgMember[];
  teams: OrgTeam[];
  selfId: string | null;
  isOwner: boolean;
  assignableRoles: OrgRole[];
  childrenByParent: Map<string, OrgMember[]>;
  expanded: Set<string>;
  toggle: (id: string) => void;
  focusedId: string;
  setFocusedId: (id: string) => void;
  registerRef: (id: string, el: HTMLDivElement | null) => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>, member: OrgMember) => void;
  mutations: Mutations;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  deletingId: string | null;
  setDeletingId: (id: string | null) => void;
  announce: Announce;
}

const ROLE_TONE: Record<OrgRole, 'accent' | 'neutral' | 'info' | 'success'> = {
  lead: 'accent',
  principal: 'info',
  scrum: 'success',
  developer: 'neutral',
};

/** One row in a team's roster tree. `isSelf` is derived from `selfId` rather
 * than passed down positionally — a tree's root is no longer necessarily
 * "me" (it's a team's manager, who might be someone else entirely), so the
 * caller's own row can now show up at any level, not just the root. */
export function PersonRow(props: PersonRowProps) {
  const t = useTranslation();
  const {
    member,
    level,
    setSize,
    posInSet,
    members,
    teams,
    selfId,
    isOwner,
    assignableRoles,
    childrenByParent,
    expanded,
    toggle,
    focusedId,
    setFocusedId,
    registerRef,
    onKeyDown,
    mutations,
    editingId,
    setEditingId,
    deletingId,
    setDeletingId,
    announce,
  } = props;

  const isSelf = member.id === selfId;
  const children = childrenByParent.get(member.id) ?? [];
  const hasChildren = children.length > 0;
  const isExpanded = expanded.has(member.id);
  const isEditing = editingId === member.id;
  const isDeleting = deletingId === member.id;
  const rowId = `manage-team-row-${member.id}`;
  // Nobody can delete themselves, even the owner — that would strand the
  // chart with no root. Editing your own row IS allowed for the owner
  // (e.g. joining a team via EditMemberForm's Team field).
  const canEdit = !isSelf || isOwner;
  // The tree shows who reports to this person; the confirmation adds where
  // they land, which the tree can't (see OrgStore.deleteMember).
  const newParent = member.parentId ? members.find((m) => m.id === member.parentId) : null;

  return (
    <li role="none">
      <div
        ref={(el) => registerRef(member.id, el)}
        id={rowId}
        role="treeitem"
        aria-level={level}
        aria-setsize={setSize}
        aria-posinset={posInSet}
        aria-expanded={hasChildren ? isExpanded : undefined}
        tabIndex={focusedId === member.id ? 0 : -1}
        onFocus={() => setFocusedId(member.id)}
        onKeyDown={(e) => onKeyDown(e, member)}
        className="focus-ring flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-sunken"
      >
        {hasChildren ? (
          <IconButton
            aria-label={isExpanded ? t('team.collapseAriaLabel', { name: member.displayName }) : t('team.expandAriaLabel', { name: member.displayName })}
            onClick={() => toggle(member.id)}
            className="shrink-0"
          >
            <DirectionalIcon>
              <ChevronRight size={14} className={`transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
            </DirectionalIcon>
          </IconButton>
        ) : (
          <span className="w-6 shrink-0" aria-hidden="true" />
        )}

        <span className="text-xs font-medium text-ink">
          <Foreign as="span">{member.displayName}</Foreign>
          {isSelf && <span className="ms-1 text-ink-subtle">{t('team.youSuffixParen')}</span>}
        </span>
        <Pill tone={ROLE_TONE[member.role]}>{roleLabel(member.role)}</Pill>

        <div className="ms-auto flex items-center gap-1">
          {canEdit && (
            <IconButton aria-label={t('team.editTeamAriaLabel', { name: member.displayName })} onClick={() => setEditingId(isEditing ? null : member.id)}>
              <Pencil size={14} />
            </IconButton>
          )}
          {!isSelf &&
            (isDeleting ? (
              <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
                {hasChildren && newParent && (
                  <span className="text-xs text-warning">
                    {t('team.reportsMoveTo', { count: children.length, name: newParent.displayName })}
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
        <EditMemberForm
          member={member}
          members={members}
          teams={teams}
          assignableRoles={assignableRoles}
          mutations={mutations}
          onDone={() => setEditingId(null)}
          announce={announce}
        />
      )}

      {hasChildren && isExpanded && (
        <ul role="group" className="ms-4 space-y-1 border-s border-border ps-3">
          {children.map((child, i) => (
            <PersonRow {...props} key={child.id} member={child} level={level + 1} setSize={children.length} posInSet={i + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

