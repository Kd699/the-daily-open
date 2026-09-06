import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import DailyOpenLab from './pages/DailyOpenLab';
import CloudsPage from './pages/clouds/page';
import './index.css';

/* Hash routing, because two surfaces do not justify a router.
 *
 * The concept lab is the landing page: that is the thing being reviewed, and it owns the
 * hash itself (#m=…&s=…&p=…&v=… selects a mode/state/platform/view), so a link someone
 * pastes into Slack opens on the exact frame they meant. `#/app` is the escape hatch to
 * the bare environment — the same components, no board around them. `/clouds` (and
 * `#/clouds`) is the sky brought over from next-personal. */
function isClouds(path: string, hash: string) {
  return path === '/clouds' || path.startsWith('/clouds/') || hash.startsWith('#/clouds');
}

function Root() {
  const [loc, setLoc] = useState(() => ({ path: window.location.pathname, hash: window.location.hash }));
  useEffect(() => {
    const on = () => setLoc({ path: window.location.pathname, hash: window.location.hash });
    window.addEventListener('hashchange', on);
    window.addEventListener('popstate', on);
    return () => {
      window.removeEventListener('hashchange', on);
      window.removeEventListener('popstate', on);
    };
  }, []);
  if (isClouds(loc.path, loc.hash)) return <CloudsPage />;
  return loc.hash.startsWith('#/app') ? <App /> : <DailyOpenLab />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
