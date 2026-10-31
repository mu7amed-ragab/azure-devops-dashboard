import { useState } from 'react';
import { Check, ChevronDown, FolderGit2, RefreshCw } from 'lucide-react';
import { fetchProjects, submitProject } from '../lib/api';
import type { AdoProject } from '../lib/types';
import { InlineMessage } from './ui/InlineMessage';
import { SearchInput } from './ui/SearchInput';
import { Foreign } from './ui/Foreign';
import { useTranslation } from '../lib/i18n';
import { describeError, type ErrorDisplay } from '../lib/errorDisplay';

/** Above this many projects the list gets a filter — same threshold as the
 * login step's, so the two lists behave identically. */
const FILTER_THRESHOLD = 8;

/**
 * Switching project without signing out.
 *
 * The server side of this needed nothing new: POST /api/auth/project accepts
 * any valid session (not just one still on the project step), re-seals the
 * cookie with the new project and preserves `iat`, so switching is not a new
 * sign-in and doesn't extend the session's lifetime. The PAT stays exactly as
 * it was — the person is the same person, only the project they're served from
 * changes.
 *
 * A successful switch does a full page load rather than a client-side
 * navigation, deliberately: everything the client persists (filters, grouping,
 * sprint pick, the cached dashboard payload) is namespaced by project id and
 * read during the initial render of its consumers (see lib/activeProject.ts).
 * Reloading is what guarantees the in-memory query cache, the localStorage
 * namespace and the session all flip at the same instant, instead of one
 * render of project A's data under project B's header.
 */
export function ProjectSwitcher({ currentProject }: { currentProject: { id: string | null; name: string } }) {
  const t = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // null = not fetched yet; the list is loaded on first expand, not on mount,
  // so opening the account menu costs no ADO call.
  const [projects, setProjects] = useState<AdoProject[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [filter, setFilter] = useState('');
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);

  async function toggle() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (projects !== null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const { projects: list } = await fetchProjects();
      setProjects(list);
    } catch (err) {
      setProjects([]);
      setError(describeError(err, t('auth.error.couldNotLoad')));
    } finally {
      setLoading(false);
    }
  }

  async function choose(project: AdoProject) {
    if (project.name === currentProject.name || switchingTo) return;
    setError(null);
    setSwitchingTo(project.name);
    try {
      await submitProject(project.name);
      // Full load, not a router navigation — see the module comment.
      window.location.href = '/';
    } catch (err) {
      setSwitchingTo(null);
      setError(describeError(err, t('project.couldNotOpen')));
    }
  }

  const filtered = (projects || []).filter((p) =>
    filter ? p.name.toLowerCase().includes(filter.toLowerCase()) : true
  );

  return (
    <div>
      <button
        role="menuitem"
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        disabled={switchingTo !== null}
        className="focus-ring flex w-full cursor-pointer items-start gap-2.5 rounded-md px-3 py-2.5 text-start text-xs font-medium text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink disabled:cursor-default disabled:opacity-40"
      >
        <FolderGit2 size={14} className="mt-0.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block">{t('project.switchProject')}</span>
          <span className="mt-0.5 block truncate font-normal text-ink-subtle" title={currentProject.name}>
            {t('project.currentlyLabel')} <Foreign as="span">{currentProject.name}</Foreign>
          </span>
        </span>
        <ChevronDown
          size={14}
          className={`mt-0.5 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {expanded && (
        <div className="space-y-1.5 px-1.5 pb-1.5">
          {loading && <p className="px-1.5 py-1 text-xs text-ink-subtle">{t('project.loadingProjects')}</p>}

          {projects !== null && projects.length > FILTER_THRESHOLD && (
            <SearchInput value={filter} onChange={setFilter} placeholder={t('project.filterPlaceholder')} maxWidth={9999} />
          )}

          {projects !== null && projects.length > 0 && (
            <div className="max-h-52 space-y-0.5 overflow-y-auto rounded-md border border-border bg-surface-sunken p-1">
              {filtered.map((project) => {
                const isCurrent = project.name === currentProject.name;
                return (
                  <button
                    key={project.id}
                    role="menuitem"
                    type="button"
                    onClick={() => choose(project)}
                    disabled={switchingTo !== null || isCurrent}
                    aria-current={isCurrent ? 'true' : undefined}
                    className={`focus-ring flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-start text-xs transition-colors ${
                      isCurrent
                        ? 'cursor-default bg-accent/10 text-accent'
                        : 'text-ink-muted hover:bg-surface-raised hover:text-ink'
                    } ${switchingTo && !isCurrent ? 'opacity-40' : ''}`}
                  >
                    <span className="min-w-0 flex-1 truncate" title={project.name}>
                      <Foreign as="span">{project.name}</Foreign>
                    </span>
                    {isCurrent && <Check size={12} className="shrink-0" />}
                    {switchingTo === project.name && <RefreshCw size={12} className="shrink-0 animate-spin" />}
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-ink-subtle">{t('project.noMatch', { filter })}</p>
              )}
            </div>
          )}

          {projects !== null && projects.length === 0 && !error && (
            <p className="px-1.5 py-1 text-xs text-ink-subtle">{t('project.noOtherProjects')}</p>
          )}

          {error && <InlineMessage tone="error" detail={error.detail}>{error.message}</InlineMessage>}
        </div>
      )}
    </div>
  );
}

