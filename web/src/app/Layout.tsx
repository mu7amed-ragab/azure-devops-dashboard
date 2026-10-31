import { NavLink, Outlet } from 'react-router-dom';
import { GitPullRequest, LayoutDashboard, ListTodo, Users, BarChart3 } from 'lucide-react';
import { AmbientSky } from '../components/AmbientSky';
import { ThemeToggle } from '../components/ThemeToggle';
import { LanguageToggle } from '../components/ui/LanguageToggle';
import { UserChip } from '../components/UserChip';
import { InlineMessage } from '../components/ui/InlineMessage';
import { Pill } from '../components/ui/Pill';
import { useMe } from '../lib/useMe';
import { useAuth } from '../lib/useAuth';
import { useTranslation } from '../lib/i18n';
import { useLang } from '../lib/i18n/useLang';
import { isPresentation } from '../lib/presentation';

const BASE_NAV_ITEMS = [
  { to: '/', labelKey: 'nav.dashboard', icon: LayoutDashboard, end: true },
  { to: '/work-items', labelKey: 'nav.workitems', icon: ListTodo, end: false },
];

export function Layout() {
  const t = useTranslation();
  // Team and Scrum are only ever nav items for whoever the org chart
  // (server/orgStore.js) lists as a lead/principal/scrum member — the same
  // canSeeTeamPage gate (FR-027; research.md R8), since the Scrum page is
  // read-only and reuses the Team page's permission concept rather than
  // adding a second one. Pull Requests is hidden for a scrum account. Every
  // route enforces this independently server-side — hiding the nav item
  // here is just so nobody sees a link to a page that 403s.
  const { canSeeTeamPage, canSeePullRequests } = useMe();
  const navItems = [
    ...BASE_NAV_ITEMS,
    ...(canSeePullRequests ? [{ to: '/pull-requests', labelKey: 'nav.pullrequests', icon: GitPullRequest, end: false }] : []),
    ...(canSeeTeamPage ? [{ to: '/team', labelKey: 'nav.team', icon: Users, end: false }] : []),
    ...(canSeeTeamPage ? [{ to: '/scrum', labelKey: 'nav.scrum', icon: BarChart3, end: false }] : []),
  ];

  // Shared reads (sprints, roster, hours history) all go through this
  // project's read token — if it's expired/revoked, everyone on the project
  // sees this at once (see server/index.js's /api/auth/me), so it's a
  // page-wide banner rather than tied to any one query's own error state.
  // `auth.project` is also where the header's project pill comes from: with
  // several projects in play, which one you're looking at has to be visible
  // without opening a menu.
  const { data: auth } = useAuth();
  const { dir } = useLang();

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col border-x border-border bg-surface/85 backdrop-blur-xl">
      <AmbientSky />
      <a href="#main-content" className="sr-only-focusable">
        {t('nav.skipToContent')}
      </a>
      <header
        dir="ltr"
        className="sticky top-0 z-header flex items-center justify-between gap-3 border-b border-border bg-surface/70 px-4 py-3 backdrop-blur sm:px-6"
      >
        <div className="flex min-w-0 shrink items-center gap-2">
          <span dir="ltr" className="shrink-0 text-sm font-semibold tracking-tight text-ink">Azure Dashboard</span>
          {auth?.project && (
            <Pill tone="accent" title={auth.project.name} className="hidden max-w-[10rem] sm:inline-flex">
              <span className="truncate">{auth.project.name}</span>
            </Pill>
          )}
          {auth?.demo && !isPresentation() && (
            <Pill tone="warning" data-demo-badge="" title={t('demo.badgeHint')} className="shrink-0">
              {t('demo.badge')}
            </Pill>
          )}
        </div>
        <nav dir={dir} className="flex items-center gap-1 overflow-x-auto">
          {navItems.map(({ to, labelKey, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `focus-ring flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  isActive ? 'bg-accent/15 text-accent' : 'text-ink-muted hover:text-ink'
                }`
              }
            >
              <Icon size={14} />
              <span className="hidden sm:inline">{t(labelKey as any)}</span>
            </NavLink>
          ))}
        </nav>
        <div className="flex shrink-0 items-center gap-1.5">
          <ThemeToggle />
          <LanguageToggle />
          <UserChip />
        </div>
      </header>
      {auth?.serviceTokenInvalid && (
        <div className="px-4 pt-4 sm:px-6">
          <InlineMessage tone="error">
            {t('serviceToken.invalid')}
          </InlineMessage>
        </div>
      )}
      <main id="main-content" tabIndex={-1} className="flex-1 px-4 py-5 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
