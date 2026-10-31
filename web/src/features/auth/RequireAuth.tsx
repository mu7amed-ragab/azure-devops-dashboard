import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../lib/useAuth';
import { setActiveProjectKey } from '../../lib/activeProject';
import { hydrateCurrentSprint } from '../../lib/currentSprint';
import { LoadingView } from '../../components/StatusView';
import { useTranslation } from '../../lib/i18n';

/** Gate around the whole app shell: anything other than `stage === 'ready'`
 * (no session, or no project picked yet) bounces to /login, which itself
 * no-ops back here once the visitor is through all three steps. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { data, isLoading } = useAuth();
  const location = useLocation();
  const t = useTranslation();

  if (isLoading) return <LoadingView label={t('auth.checkingStatus')} />;
  if (!data || data.stage !== 'ready') {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  // Set here, in the render body, deliberately: everything persisted in
  // localStorage is namespaced by project and read during the initial render
  // of the components below, so an effect would run one render too late.
  setActiveProjectKey(data.project ? data.project.id : null);
  hydrateCurrentSprint();
  return <>{children}</>;
}
