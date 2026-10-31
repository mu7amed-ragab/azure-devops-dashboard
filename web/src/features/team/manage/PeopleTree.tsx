import { useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { OrgMember, OrgTeam } from '../../../lib/types';
import { PersonRow } from './PersonRow';
import type { Announce, Mutations } from './types';
import { byRoleThenName } from './roleRules';
import type { OrgRole } from './roleRules';

interface PeopleTreeProps {
  root: OrgMember;
  ariaLabel: string;
  members: OrgMember[];
  teams: OrgTeam[];
  selfId: string | null;
  isOwner: boolean;
  /** The team this tree belongs to. Membership is scoped by it — see the
   * `scoped` filter below. */
  teamId: string | null;
  assignableRoles: OrgRole[];
  mutations: Mutations;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  deletingId: string | null;
  setDeletingId: (id: string | null) => void;
  announce: Announce;
}

interface VisibleRow {
  member: OrgMember;
  level: number;
}

/** The member roster below `root` as a real ARIA tree (role="tree"/
 * "treeitem"/"group"), collapsed by default so a chart with many people
 * stays scannable. `root` need not be the caller's own row — it's whoever
 * heads the team this tree belongs to (see TeamCard.tsx), so more than one
 * of these can be on screen at once, each with its own independent expand
 * state. Keyboard model follows the ARIA Authoring Practices tree pattern:
 * one row is tabbable at a time (roving tabIndex), ↑/↓ move, → expands/
 * descends, ← collapses/goes to parent. */
export function PeopleTree(props: PeopleTreeProps) {
  const { root, ariaLabel, members, teamId } = props;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([root.id]));
  const [focusedId, setFocusedId] = useState<string>(root.id);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const childrenByParent = useMemo(() => {
    // Scoped to this team's own members. The root manager is always included
    // even though their `teamId` points elsewhere (or nowhere) — they head
    // the team rather than belonging to it, and may head several. Without
    // this filter a manager's three teams would each render all three
    // rosters, since every member hangs off the same parent chain.
    const scoped = members.filter((m) => m.id === root.id || (m.teamId ?? null) === teamId);
    const map = new Map<string, OrgMember[]>();
    for (const m of scoped) {
      if (m.id === root.id) continue;
      const key = m.parentId ?? '';
      const list = map.get(key) ?? [];
      list.push(m);
      map.set(key, list);
    }
    // Anyone whose parent sits outside this team still shows, hanging off
    // the root, rather than disappearing from the only screen that can fix
    // the relationship.
    const reachable = new Set<string>();
    const walk = (id: string) => {
      for (const child of map.get(id) ?? []) {
        if (reachable.has(child.id)) continue;
        reachable.add(child.id);
        walk(child.id);
      }
    };
    walk(root.id);
    const orphans = scoped.filter((m) => m.id !== root.id && !reachable.has(m.id));
    if (orphans.length > 0) {
      map.set(root.id, [...(map.get(root.id) ?? []), ...orphans]);
    }
    // Seniority order within every level — lead, scrum, principal, then
    // developers — so the tree and the flat List (flattenRoster, which sorts
    // the same way) read identically top to bottom.
    for (const list of map.values()) list.sort(byRoleThenName);
    return map;
  }, [members, root.id, teamId]);

  const visible = useMemo(() => {
    const result: VisibleRow[] = [];
    function visit(member: OrgMember, level: number) {
      result.push({ member, level });
      if (expanded.has(member.id)) {
        for (const child of childrenByParent.get(member.id) ?? []) visit(child, level + 1);
      }
    }
    visit(root, 0);
    return result;
  }, [root, childrenByParent, expanded]);

  const indexOf = useMemo(() => {
    const map = new Map<string, number>();
    visible.forEach((row, i) => map.set(row.member.id, i));
    return map;
  }, [visible]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function focusRow(id: string) {
    setFocusedId(id);
    rowRefs.current.get(id)?.focus();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>, member: OrgMember) {
    const index = indexOf.get(member.id) ?? -1;
    if (index < 0) return;
    const hasChildren = (childrenByParent.get(member.id) ?? []).length > 0;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = visible[index + 1];
      if (next) focusRow(next.member.id);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = visible[index - 1];
      if (prev) focusRow(prev.member.id);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (hasChildren && !expanded.has(member.id)) {
        toggle(member.id);
      } else {
        const next = visible[index + 1];
        if (next && next.level > visible[index].level) focusRow(next.member.id);
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (hasChildren && expanded.has(member.id)) {
        toggle(member.id);
      } else {
        for (let i = index - 1; i >= 0; i -= 1) {
          if (visible[i].level < visible[index].level) {
            focusRow(visible[i].member.id);
            break;
          }
        }
      }
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusRow(visible[0].member.id);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusRow(visible[visible.length - 1].member.id);
    }
  }

  return (
    <ul role="tree" aria-label={ariaLabel} className="space-y-1">
      <PersonRow
        {...props}
        member={root}
        level={1}
        childrenByParent={childrenByParent}
        expanded={expanded}
        toggle={toggle}
        focusedId={focusedId}
        setFocusedId={setFocusedId}
        registerRef={(id, el) => {
          if (el) rowRefs.current.set(id, el);
          else rowRefs.current.delete(id);
        }}
        onKeyDown={handleKeyDown}
        setSize={1}
        posInSet={1}
      />
    </ul>
  );
}
