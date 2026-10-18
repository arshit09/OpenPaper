import { useEffect, useState } from 'react';
import { Home } from './home/Home.tsx';
import { EditorView } from './editor/EditorView.tsx';
import { Toasts } from './ui/Toasts.tsx';
import { ConnectDialog } from './ui/ConnectDialog.tsx';
import { useEditor } from './state/store.ts';
import { closeFile, navigateTo } from './sync/session.ts';

type Route = { name: 'home' } | { name: 'file'; fileId: string; pageId?: string; nodeId?: string };

function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'file' && parts[1]) return { name: 'file', fileId: parts[1], pageId: parts[2], nodeId: parts[3] };
  return { name: 'home' };
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const showConnect = useEditor((s) => s.showConnect);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (route.name === 'file') void navigateTo(route.fileId, route.pageId, route.nodeId).catch(() => (location.hash = '#/'));
    else closeFile();
  }, [route.name === 'file' ? route.fileId : null]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {route.name === 'file' ? <EditorView /> : <Home />}
      {showConnect && <ConnectDialog />}
      <Toasts />
    </>
  );
}
