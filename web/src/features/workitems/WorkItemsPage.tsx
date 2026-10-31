import { useSearchParams } from 'react-router-dom';
import { useDashboard } from '../../lib/useDashboard';
import { WorkItemsView } from '../../components/WorkItemsView';
import { VIEWS, type ViewId } from '../../lib/workItemViews';

function parseView(raw: string | null): ViewId | null {
  return raw && raw in VIEWS ? (raw as ViewId) : null;
}

export function WorkItemsPage() {
  const { data, isLoading, isError, refetch } = useDashboard();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = parseView(searchParams.get('view'));

  function onViewChange(next: ViewId | null) {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (next) params.set('view', next);
      else params.delete('view');
      return params;
    });
  }

  return (
    <WorkItemsView
      data={data}
      isLoading={isLoading}
      isError={isError}
      refetch={refetch}
      scope="self"
      view={view}
      onViewChange={onViewChange}
    />
  );
}
