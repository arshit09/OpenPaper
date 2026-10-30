import { useEffect, useState } from 'react';
import { Home } from './home/Home.tsx';
import { EditorView } from './editor/EditorView.tsx';
import { SiteView } from './site/SiteView.tsx';
import { Toasts } from './ui/Toasts.tsx';
import { ConnectDialog } from './ui/ConnectDialog.tsx';
import { toast, useEditor } from './state/store.ts';
import { closeFile, exitVersion, navigateTo, showVersion } from './sync/session.ts';

type Route =
  | { name: 'home' }
  /** `version`: a commit of the file, shown read-only (`#/file/<id>/version/<commit>`). */
  | { name: 'file'; fileId: string; pageId?: string; nodeId?: string; version?: string }
  | { name: 'site'; siteId: string };

function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'file' && parts[1] && parts[2] === 'version' && parts[3]) return { name: 'file', fileId: parts[1], version: parts[3] };
  if (parts[0] === 'file' && parts[1]) return { name: 'file', fileId: parts[1], pageId: parts[2], nodeId: parts[3] };
  if (parts[0] === 'site' && parts[1]) return { name: 'site', siteId: parts[1] };
  return { name: 'home' };
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const showConnect = useEditor((s) => s.showConnect);
  const fileId = route.name === 'file' ? route.fileId : null;
  const version = route.name === 'file' ? (route.version ?? null) : null;

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (route.name === 'file') void navigateTo(route.fileId, route.pageId, route.nodeId).catch(() => (location.hash = '#/'));
    else closeFile();
  }, [fileId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!fileId) return;
    if (!version) return exitVersion();
    showVersion(fileId, version).catch((error: Error) => {
      toast(error.message, 4000);
      location.hash = `#/file/${fileId}`;
    });
  }, [fileId, version]);

  return (
    <>
      {route.name === 'file' ? <EditorView /> : route.name === 'site' ? <SiteView key={route.siteId} siteId={route.siteId} /> : <Home />}
      {showConnect && <ConnectDialog />}
      <Toasts />
    </>
  );
}
