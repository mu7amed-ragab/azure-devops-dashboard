import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './app/Layout';
import { LoadingView } from './components/StatusView';
import { LoginPage } from './features/auth/LoginPage';
import { RequireAuth } from './features/auth/RequireAuth';

const DashboardPage = lazy(() => import('./features/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const WorkItemsPage = lazy(() => import('./features/workitems/WorkItemsPage').then((m) => ({ default: m.WorkItemsPage })));
const PullRequestsPage = lazy(() =>
  import('./features/pullrequests/PullRequestsPage').then((m) => ({ default: m.PullRequestsPage }))
);
const TeamPage = lazy(() => import('./features/team/TeamPage').then((m) => ({ default: m.TeamPage })));
const ScrumPage = lazy(() => import('./features/scrum/ScrumPage').then((m) => ({ default: m.ScrumPage })));

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route
          index
          element={
            <Suspense fallback={<LoadingView />}>
              <DashboardPage />
            </Suspense>
          }
        />
        <Route
          path="work-items"
          element={
            <Suspense fallback={<LoadingView />}>
              <WorkItemsPage />
            </Suspense>
          }
        />
        <Route path="stories" element={<Navigate to="/work-items" replace />} />
        <Route
          path="team"
          element={
            <Suspense fallback={<LoadingView />}>
              <TeamPage />
            </Suspense>
          }
        />
        <Route
          path="scrum"
          element={
            <Suspense fallback={<LoadingView />}>
              <ScrumPage />
            </Suspense>
          }
        />
        <Route
          path="pull-requests"
          element={
            <Suspense fallback={<LoadingView />}>
              <PullRequestsPage />
            </Suspense>
          }
        />
      </Route>
    </Routes>
  );
}
