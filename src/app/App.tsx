import { useEffect, useState } from 'react';
import { ToastProvider } from '../components/ui';
import { ProjectHome } from '../features/projects/ProjectHome';
import { Workspace } from '../features/viewer/Workspace';
import { ReportView } from '../features/reports/ReportView';
import { PasswordRecoveryDialog } from '../components/Cloud';
import { UpdateBanner } from '../components/UpdateBanner';

type Route = { name: 'home' } | { name: 'project'; id: string } | { name: 'report'; id: string };
function parse(hash: string): Route {
  const m = /^#\/p\/([^/]+)(\/report)?$/.exec(hash);
  if (m) return m[2] ? { name: 'report', id: m[1] } : { name: 'project', id: m[1] };
  return { name: 'home' };
}
export const go = (path: string) => { window.location.hash = path; };

export function App() {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return (
    <ToastProvider>
      {route.name === 'home' && <ProjectHome />}
      {route.name === 'project' && <Workspace key={route.id} projectId={route.id} />}
      {route.name === 'report' && <ReportView key={route.id} projectId={route.id} />}
      <PasswordRecoveryDialog />
      <UpdateBanner />
    </ToastProvider>
  );
}
