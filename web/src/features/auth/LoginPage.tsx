import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { User, ExternalLink } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { LanguageToggle } from '../../components/ui/LanguageToggle';
import { useAuth } from '../../lib/useAuth';
import { submitPassword, submitPat, submitProject, fetchProjects, logout, readAndClearLoginReason } from '../../lib/api';
import type { AdoProject } from '../../lib/types';
import { PrimaryButton } from '../../components/ui/PrimaryButton';
import { InlineMessage } from '../../components/ui/InlineMessage';
import { describeError, type ErrorDisplay } from '../../lib/errorDisplay';
import { SearchInput } from '../../components/ui/SearchInput';
import { LoadingView } from '../../components/StatusView';
import { AmbientSky } from '../../components/AmbientSky';
import { Pill } from '../../components/ui/Pill';
import { isPresentation } from '../../lib/presentation';

const REQUIRED_SCOPES = ['Work Items (Read & Write)', 'Code (Read)', 'Project and Team (Read)', 'Wiki (Read)'];

const STEPS = [
  { key: 'password', labelKey: 'auth.step1Label' },
  { key: 'pat', labelKey: 'auth.step2Label' },
  { key: 'project', labelKey: 'auth.step3Label' },
] as const;

/** Above this many projects the list gets a filter — below it, scanning is
 * faster than typing. */
const FILTER_THRESHOLD = 8;

function fieldClass() {
  return 'focus-ring w-full rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm text-ink placeholder:text-ink-subtle focus-visible:border-accent';
}

/** Wraps every returned state in the same night-sky shell so the very first
 * screen a visitor sees is never a flash of the light theme before this
 * resolves. Always dark regardless of the app's own theme toggle — see
 * DESIGN.md "The Ambient Canopy". */
function NightShell({ children }: { children: ReactNode }) {
  return (
    <div className="login-night dark relative flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <AmbientSky />
      <div className="relative z-10 w-full max-w-sm">{children}</div>
      <p className="relative z-10 mt-8 text-center text-xs uppercase tracking-[0.2em] text-white/40">
        By Mohammed Ragab
      </p>
    </div>
  );
}

/** Segment rail + caption — replaces the old "Step 1 of 2 — team password"
 * prose. The rail carries the count, the caption carries the step's own
 * name, so nothing repeats. */
function StepIndicator({ stepIndex }: { stepIndex: number }) {
  const t = useTranslation();
  return (
    <div className="mb-5 flex flex-col items-center gap-2">
      <div className="flex items-center gap-1.5">
        {STEPS.map((step, i) => (
          <span
            key={step.key}
            className={`h-0.5 w-8 rounded-full transition-colors ${i <= stepIndex ? 'bg-accent' : 'bg-border'}`}
          />
        ))}
      </div>
      <p className="text-xs font-medium text-ink-muted">{t(STEPS[stepIndex].labelKey)}</p>
    </div>
  );
}

export function LoginPage() {
  const t = useTranslation();
  const { data, isLoading, refetch } = useAuth();
  const queryClient = useQueryClient();
  const location = useLocation();

  const [password, setPassword] = useState('');
  const [pat, setPat] = useState('');
  // Seeded from a one-shot reason left by a 401 elsewhere in the app (e.g.
  // this person's own PAT expired mid-session — see server's PAT_EXPIRED
  // and web/src/lib/api.ts's redirectToLogin) so it's shown exactly once,
  // right where the form the user needs to act on next already renders it.
  const [error, setError] = useState<ErrorDisplay | null>(() => {
    const reason = readAndClearLoginReason();
    return reason ? { message: reason } : null;
  });
  const [submitting, setSubmitting] = useState(false);
  // Seeded by the PAT step's own response; null means "not fetched yet", which
  // is what the effect below fills in after a reload on the project step.
  const [projects, setProjects] = useState<AdoProject[] | null>(null);
  const [selected, setSelected] = useState('');
  const [projectFilter, setProjectFilter] = useState('');

  const stage = data?.stage ?? 'password';
  const defaultProject = data?.defaultProject ?? null;

  useEffect(() => {
    if (stage !== 'project' || projects !== null) return;
    let cancelled = false;
    fetchProjects()
      .then(({ projects: list }) => {
        if (cancelled) return;
        setProjects(list);
      })
      .catch((err) => {
        if (cancelled) return;
        setProjects([]);
        setError(describeError(err, t('auth.error.couldNotLoad')));
      });
    return () => {
      cancelled = true;
    };
  }, [stage, projects]);

  // Preselect the deployment's default project once a list exists, so the
  // common case is one click.
  useEffect(() => {
    if (selected || !projects || projects.length === 0) return;
    const preferred = defaultProject && projects.find((p) => p.name.toLowerCase() === defaultProject.toLowerCase());
    setSelected(preferred ? preferred.name : projects[0].name);
  }, [projects, defaultProject, selected]);

  if (isLoading) {
    return (
      <NightShell>
        <LoadingView label={t('auth.checkingStatus')} />
      </NightShell>
    );
  }

  // Already signed in with a project picked — nothing to do here.
  if (data && data.stage === 'ready') {
    const to = (location.state as { from?: string } | null)?.from || '/';
    return <Navigate to={to} replace />;
  }

  const stepIndex = stage === 'project' ? 2 : stage === 'pat' ? 1 : 0;

  async function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await submitPassword(password);
      setPassword('');
      await refetch();
    } catch (err) {
      setError(describeError(err, t('auth.error.generic')));
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePatSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { projects: list } = await submitPat(pat);
      setPat('');
      // The token's projects come back with the token itself, so the next step
      // renders immediately instead of firing its own request.
      setProjects(list);
      await queryClient.invalidateQueries({ queryKey: ['auth'] });
      await refetch();
    } catch (err) {
      setError(describeError(err, t('auth.error.generic')));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleProjectSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await submitProject(selected);
      await queryClient.invalidateQueries({ queryKey: ['auth'] });
      await refetch();
    } catch (err) {
      setError(describeError(err, t('auth.error.generic')));
    } finally {
      setSubmitting(false);
    }
  }

  /** Back to step 1 with a different token — the only way back from the
   * project step, since the PAT is already sealed into the session by then. */
  async function handleUseDifferentToken() {
    setError(null);
    setSubmitting(true);
    try {
      await logout();
      setProjects(null);
      setSelected('');
      setProjectFilter('');
      await queryClient.invalidateQueries({ queryKey: ['auth'] });
      await refetch();
    } finally {
      setSubmitting(false);
    }
  }

  const filteredProjects = (projects || []).filter((p) =>
    projectFilter ? p.name.toLowerCase().includes(projectFilter.toLowerCase()) : true
  );

  const tokenUrl = data?.org ? `https://dev.azure.com/${data.org}/_usersSettings/tokens` : undefined;

  return (
    <NightShell>
      <div className="relative">
        {/* Avatar — overlaps the card's top edge, the one glow gesture on
            this screen (see DESIGN.md "The Ambient Canopy"). */}
        {/* Tailwind's translate-x utilities are physical (no logical
            equivalent exists), so centering on a logical `start-1/2` needs
            the rtl: variant to flip which way the -50% correction goes —
            otherwise this is off-center under Arabic. */}
        <div className="absolute start-1/2 top-0 z-20 -translate-y-1/2 -translate-x-1/2 rtl:translate-x-1/2">
          <div
            aria-hidden="true"
            className="animate-glow-breathe absolute inset-0 -z-10 rounded-full bg-gradient-to-br from-accent to-type-sprint opacity-60 blur-lg"
          />
          <div className="rounded-full bg-gradient-to-br from-accent to-type-sprint p-px">
            <div className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-surface-raised">
              <User size={32} className="text-accent" />
            </div>
          </div>
        </div>

        <div className="relative rounded-card border border-white/10 bg-surface-raised/70 pb-6 pt-11 shadow-2xl backdrop-blur-2xl">
          {/* Top hairline highlight — the card's one earned decorative touch. */}
          <div
            aria-hidden="true"
            className="absolute inset-x-6 top-9 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent"
          />

          <div className="px-6">
            <div className="mb-4 flex items-center justify-center gap-2">
              <LanguageToggle />
              {data?.demo && !isPresentation() && (
                <Pill tone="warning" data-demo-badge="" title={t('demo.badgeHint')}>
                  {t('demo.badge')}
                </Pill>
              )}
            </div>
            <div className="mb-6 text-center">
              <h1 dir="ltr" className="text-2xl font-semibold tracking-tight text-ink">Azure Dashboard</h1>
              <p className="mt-1 text-xs text-ink-subtle">{t('auth.subtitle')}</p>
            </div>

            <StepIndicator stepIndex={stepIndex} />

            <div>
              {stage === 'password' && (
                <form onSubmit={handlePasswordSubmit} className="space-y-3">
                  <label className="block">
                    <span className="sr-only">{t('auth.step1Label')}</span>
                    <input
                      type="password"
                      autoFocus
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={t('auth.step1Placeholder')}
                      className={fieldClass()}
                      autoComplete="current-password"
                      required
                    />
                  </label>
                  {error && <InlineMessage tone="error" detail={error.detail}>{error.message}</InlineMessage>}
                  <div className="flex justify-center pt-1">
                    <PrimaryButton type="submit" disabled={submitting || !password} className="min-w-[9rem] py-2 text-sm">
                      {submitting ? t('auth.step1Submitting') : t('auth.step1Submit')}
                    </PrimaryButton>
                  </div>
                </form>
              )}

              {stage === 'pat' && (
                <form onSubmit={handlePatSubmit} className="space-y-3">
                  <label className="block">
                    <span className="sr-only">{t('auth.step2Label')}</span>
                    <input
                      type="password"
                      autoFocus
                      value={pat}
                      onChange={(e) => setPat(e.target.value)}
                      placeholder={t('auth.step2Placeholder')}
                      className={fieldClass()}
                      autoComplete="off"
                      spellCheck={false}
                      required
                    />
                  </label>

                  <div className="rounded-card border border-border bg-surface-sunken p-3 text-xs text-ink-subtle">
                    <p className="mb-1.5 font-medium text-ink-muted">{t("auth.requiredScopes")}</p>
                    <ul className="mb-2 list-inside list-disc space-y-0.5">
                      {REQUIRED_SCOPES.map((scope) => (
                        <li key={scope}>{scope}</li>
                      ))}
                    </ul>
                    {tokenUrl && (
                      <a
                        href={tokenUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="focus-ring inline-flex items-center gap-1 text-accent hover:underline"
                      >
                        {t("auth.createToken", { org: data?.org || '' })} <ExternalLink size={12} />
                      </a>
                    )}
                  </div>

                  {error && <InlineMessage tone="error" detail={error.detail}>{error.message}</InlineMessage>}
                  <div className="flex justify-center pt-1">
                    <PrimaryButton type="submit" disabled={submitting || !pat} className="min-w-[9rem] py-2 text-sm">
                      {submitting ? t('auth.step2Submitting') : t('auth.step2Submit')}
                    </PrimaryButton>
                  </div>
                </form>
              )}

              {stage === 'project' && (
                <form onSubmit={handleProjectSubmit} className="space-y-3">
                  {projects === null && <LoadingView label={t('auth.loadingProjects')} />}

                  {projects !== null && projects.length === 0 && (
                    <InlineMessage tone="warning">
                      {t("auth.step3NoProjects", { org: data?.org || '' })}
                    </InlineMessage>
                  )}

                  {projects !== null && projects.length > 0 && (
                    <>
                      <p className="text-xs text-ink-subtle">
                        {t("auth.step3Description")}
                      </p>

                      {projects.length > FILTER_THRESHOLD && (
                        <SearchInput
                          value={projectFilter}
                          onChange={setProjectFilter}
                          placeholder={t('auth.projectFilter')}
                          maxWidth={9999}
                        />
                      )}

                      {/* Native radios: arrow-key navigation, roving focus and
                          screen-reader semantics come for free, and a filtered
                          list stays keyboard-navigable without custom keydown
                          handling. */}
                      <fieldset className="min-w-0 max-h-64 space-y-1 overflow-y-auto rounded-card border border-border bg-surface-sunken p-1.5">
                        <legend className="sr-only">{t('auth.step3Label')}</legend>
                        {filteredProjects.map((project) => (
                          <label
                            key={project.id}
                            className={`focus-within:ring-accent/60 flex cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 transition-colors focus-within:ring-1 ${
                              selected === project.name ? 'bg-accent/10' : 'hover:bg-surface-raised'
                            }`}
                          >
                            <input
                              type="radio"
                              name="project"
                              value={project.name}
                              checked={selected === project.name}
                              onChange={() => setSelected(project.name)}
                              className="accent-accent mt-0.5"
                            />
                            <span className="min-w-0">
                              <span className="block truncate text-sm text-ink">{project.name}</span>
                              {project.description && (
                                <span className="line-clamp-2 text-xs text-ink-subtle">{project.description}</span>
                              )}
                            </span>
                          </label>
                        ))}
                        {filteredProjects.length === 0 && (
                          <p className="px-2.5 py-2 text-xs text-ink-subtle">{t('auth.step3NoMatch', { filter: projectFilter })}</p>
                        )}
                      </fieldset>
                    </>
                  )}

                  {error && <InlineMessage tone="error" detail={error.detail}>{error.message}</InlineMessage>}

                  <div className="flex flex-col items-center gap-2 pt-1">
                    {projects !== null && projects.length > 0 && (
                      <PrimaryButton type="submit" disabled={submitting || !selected} className="min-w-[9rem] py-2 text-sm">
                        {submitting ? t('auth.step3Submitting') : t('auth.step3Submit')}
                      </PrimaryButton>
                    )}
                    <button
                      type="button"
                      onClick={handleUseDifferentToken}
                      disabled={submitting}
                      className="focus-ring cursor-pointer rounded text-xs text-ink-subtle transition-colors hover:text-ink"
                    >
                      {t("auth.useDifferentToken")}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      </div>
    </NightShell>
  );
}

