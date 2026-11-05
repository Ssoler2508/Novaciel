// Minimal hash router: no dependency and no server rewrite needed. Routes are client-side only.
import { useEffect, useState } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'aprobaciones'; clienteId: string };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '');
  const approvals = /^\/clientes\/([^/]+)\/aprobaciones\/?$/.exec(path);
  if (approvals) return { name: 'aprobaciones', clienteId: decodeURIComponent(approvals[1]!) };
  return { name: 'home' };
}

export function hrefAprobaciones(clienteId: string): string {
  return `#/clientes/${encodeURIComponent(clienteId)}/aprobaciones`;
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}
