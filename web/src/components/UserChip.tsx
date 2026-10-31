import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { LogOut, RefreshCw, Trash2, Link2 } from 'lucide-react';
import { useMe } from '../lib/useMe';
import { useAuth } from '../lib/useAuth';
import { clearCache, logout, triggerFullSync } from '../lib/api';
import { requestLocalReset } from '../lib/localReset';
import { usePopover } from '../lib/usePopover';
import { PopoverPanel } from './ui/Popover';
import { ProjectSwitcher } from './ProjectSwitcher';
import { Foreign } from './ui/Foreign';
import { Pill } from './ui/Pill';
import { linkedDomains } from '../lib/linkedDomains';
import { useTranslation } from '../lib/i18n';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 3 ? parts.slice(0, -1).join(' ') : name;
}

type Busy = { action: 'clear' | 'reload'; phase: 'running' | 'done' | 'error' } | null;

export function UserChip() {
  const t = useTranslation();
  const { displayName, uniqueName, isOwner, isLoading, linkedIdentities, identitiesDegraded } = useMe();
  const domains = linkedDomains(linkedIdentities);
  const { data: auth } = useAuth();
  const { open, setOpen, rootRef } = usePopover<HTMLDivElement>();
  const [busy, setBusy] = useState<Busy>(null);
  const queryClient = useQueryClient();

  async function handleLogout() {
    // Logging out must never get stuck: POST /api/auth/logout makes no ADO
    // call and should always be fast, but a person escaping a broken
    // session (dead token, unresponsive network) can't be made to wait on
    // it — and an unhandled rejection from a failed fetch (e.g. offline)
    // would otherwise skip the cleanup/redirect below entirely. Race it
    // against a short timeout and swallow any failure; either way the
    // local sign-out below always runs.
    await Promise.race([
      logout().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    // Clears every cached query and the persisted dashboard payload so the
    // next person to sign in on this browser never sees a flash of
    // whoever was previously signed in.
    queryClient.clear();
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('azure-dashboard-cache-')) localStorage.removeItem(key);
    }
    window.location.href = '/login';
  }

  async function handleClearCache() {
    setBusy({ action: 'clear', phase: 'running' });
    try {
      await clearCache();
      // Flags a localStorage sweep (filters, grouping, team selection,
      // current sprint — everything except theme) to run on next boot,
      // before any component mounts and re-persists a stale value.
      requestLocalReset();
      setBusy({ action: 'clear', phase: 'done' });
      // Reload the page so React Query, localStorage, and server state all
      // start fresh — the cleanest UX for a full cache wipe.
      setTimeout(() => window.location.reload(), 800);
    } catch {
      setBusy({ action: 'clear', phase: 'error' });
      setTimeout(() => setBusy(null), 2500);
    }
  }

  async function handleReloadAll() {
    setBusy({ action: 'reload', phase: 'running' });
    try {
      await triggerFullSync(null);
      // No filter: covers every query key family in the app (dashboard,
      // people, states, team) — a full resync can change all of them.
      await queryClient.invalidateQueries();
      setBusy({ action: 'reload', phase: 'done' });
      setTimeout(() => { setBusy(null); setOpen(false); }, 1200);
    } catch {
      setBusy({ action: 'reload', phase: 'error' });
      setTimeout(() => setBusy(null), 2500);
    }
  }

  const disabled = busy !== null && busy.phase === 'running';

  // Avatar circle content — shown whether loading or loaded
  const avatarContent = isLoading || !displayName
    ? <span className="text-xs font-semibold text-ink-muted">···</span>
    : <span className="text-xs font-semibold text-accent">{initials(displayName)}</span>;

  const avatarBg = isLoading || !displayName ? 'bg-surface-sunken' : 'bg-accent/15';

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => { if (!isLoading && displayName) setOpen((v) => !v); }}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={displayName ? t('account.ariaLabel', { name: displayName }) : t('account.loadingAccount')}
        className={`focus-ring flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-border transition-colors ${avatarBg} hover:border-accent/40`}
      >
        {avatarContent}
      </button>

      {open && displayName && (
        <PopoverPanel className="top-full w-64 overflow-hidden p-0" role="menu">
          {/* Identity header */}
          <div className="bg-accent/5 px-4 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/20 text-base font-semibold text-accent">
                {initials(displayName)}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold leading-snug text-ink" title={displayName}>
                  <Foreign as="span">{shortName(displayName)}</Foreign>
                </p>
                {uniqueName && uniqueName !== displayName && (
                  <p className="truncate text-xs text-ink-subtle" title={uniqueName}>
                    <Foreign as="span">{uniqueName}</Foreign>
                  </p>
                )}
                {/* The project deliberately isn't repeated here: the Switch
                    project row below names it, and owns it. */}
              </div>
            </div>

            {/* 006-linked-identity-aliases (FR-009): discloses which other
                domain's work is folded into this person's view, so a
                surprising extra item elsewhere in the app is explainable
                rather than mysterious. Linked identities share the username
                by construction, so the domain is all that needs naming.
                Absent entirely for the common single-identity case. */}
            {domains.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-3 text-xs font-medium text-ink-muted">
                <Link2 size={12} className="shrink-0" />
                {t('account.alsoIncludesDomain', { count: domains.length })}
                {domains.map((domain) => (
                  <Pill key={domain} tone="neutral">
                    <Foreign as="span" className="truncate">{domain}</Foreign>
                  </Pill>
                ))}
              </div>
            )}
            {identitiesDegraded && (
              <p className="mt-2 text-xs text-warning">{t('account.identitiesMayBeIncomplete')}</p>
            )}
          </div>

          {/* Divider */}
          <div className="h-px bg-border" />

          {/* Actions */}
          <div className="p-1.5">
            {auth?.project && (
              <>
                <ProjectSwitcher currentProject={auth.project} />
                <div className="my-1 h-px bg-border" />
              </>
            )}

            {isOwner && (
              <>
                <button
                  role="menuitem"
                  type="button"
                  onClick={handleClearCache}
                  disabled={disabled}
                  className="focus-ring flex w-full cursor-pointer items-start gap-2.5 rounded-md px-3 py-2.5 text-start text-xs font-medium text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink disabled:cursor-default disabled:opacity-40"
                >
                  {busy?.action === 'clear' && busy.phase === 'running' ? (
                    <RefreshCw size={14} className="mt-0.5 shrink-0 animate-spin" />
                  ) : (
                    <Trash2 size={14} className="mt-0.5 shrink-0" />
                  )}
                  <span>
                    <span className="block">
                      {busy?.action === 'clear' && busy.phase === 'done'
                        ? t('account.clearedReloading')
                        : busy?.action === 'clear' && busy.phase === 'running'
                          ? t('account.clearingCache')
                          : busy?.action === 'clear' && busy.phase === 'error'
                            ? t('account.clearFailed')
                            : t('account.clearCache')}
                    </span>
                    {busy?.action !== 'clear' && (
                      <span className="mt-0.5 block text-xs font-normal text-ink-subtle">
                        {t('account.clearCacheHint')}
                      </span>
                    )}
                  </span>
                </button>

                <div className="my-1 h-px bg-border" />

                <button
                  role="menuitem"
                  type="button"
                  onClick={handleReloadAll}
                  disabled={disabled}
                  className="focus-ring flex w-full cursor-pointer items-start gap-2.5 rounded-md px-3 py-2.5 text-start text-xs font-medium text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink disabled:cursor-default disabled:opacity-40"
                >
                  <RefreshCw
                    size={14}
                    className={`mt-0.5 shrink-0 ${busy?.action === 'reload' && busy.phase === 'running' ? 'animate-spin' : ''}`}
                  />
                  <span>
                    <span className="block">
                      {busy?.action === 'reload' && busy.phase === 'done'
                        ? t('account.reloaded')
                        : busy?.action === 'reload' && busy.phase === 'error'
                          ? t('account.reloadFailed')
                          : busy?.action === 'reload' && busy.phase === 'running'
                            ? t('account.reloadingData')
                            : t('account.reloadAllData')}
                    </span>
                    {busy?.action !== 'reload' && (
                      <span className="mt-0.5 block text-xs font-normal text-ink-subtle">
                        {t('account.reloadHint')}
                      </span>
                    )}
                  </span>
                </button>
              </>
            )}

            {auth?.authEnabled && (
              <>
                {isOwner && <div className="my-1 h-px bg-border" />}
                <button
                  role="menuitem"
                  type="button"
                  onClick={handleLogout}
                  disabled={disabled}
                  className="focus-ring flex w-full cursor-pointer items-start gap-2.5 rounded-md px-3 py-2.5 text-start text-xs font-medium text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink disabled:cursor-default disabled:opacity-40"
                >
                  <LogOut size={14} className="mt-0.5 shrink-0" />
                  <span className="block">
                    {t('account.signOut')}
                    {/* Switching project no longer means signing out — that's
                        the Switch project row above. This clears the PAT. */}
                    <span className="mt-0.5 block font-normal text-ink-subtle">{t('account.signOutHint')}</span>
                  </span>
                </button>
              </>
            )}
          </div>
        </PopoverPanel>
      )}
    </div>
  );
}
