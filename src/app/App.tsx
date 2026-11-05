import { useEffect, useState } from 'react';
import { ToastProvider } from '../components/ui';
import { ProjectHome } from '../features/projects/ProjectHome';
import { Workspace } from '../features/viewer/Workspace';
import { ReportView } from '../features/reports/ReportView';
import { PasswordRecoveryDialog } from '../components/Cloud';
import { UpdateBanner } from '../components/UpdateBanner';
import { JoinPage } from '../features/projects/JoinPage';
import { useDeviceLock } from '../sync/cloud';

type Route = { name: 'home' } | { name: 'project'; id: string } | { name: 'report'; id: string } | { name: 'join'; token: string };
function parse(hash: string): Route {
  const j = /^#\/join\/([\w-]+)$/.exec(hash);
  if (j) return { name: 'join', token: j[1] };
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
  // Projects of an account that is not signed in here stay hidden: links to them land on the sign-in page.
  const locked = useDeviceLock() !== null;
  const r: Route = locked && (route.name === 'project' || route.name === 'report') ? { name: 'home' } : route;
  return (
    <ToastProvider>
      {r.name === 'home' && <ProjectHome />}
      {r.name === 'project' && <Workspace key={r.id} projectId={r.id} />}
      {r.name === 'report' && <ReportView key={r.id} projectId={r.id} />}
      {r.name === 'join' && <JoinPage token={r.token} />}
      <PasswordRecoveryDialog />
      <UpdateBanner />
    </ToastProvider>
  );
}
