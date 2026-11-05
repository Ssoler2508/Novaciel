// Minimal hash router: no dependency and no server rewrite needed. Routes are client-side only.
import { useEffect, useState } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'aprobaciones'; clienteId: string }
  | { name: 'revision'; clienteId: string; piezaId: string };

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '');

  const revision = /^\/clientes\/([^/]+)\/piezas\/([^/]+)\/?$/.exec(path);
  if (revision) {
    const clienteId = decode(revision[1]!);
    const piezaId = decode(revision[2]!);
    if (clienteId !== null && piezaId !== null) return { name: 'revision', clienteId, piezaId };
    return { name: 'home' };
  }

  const approvals = /^\/clientes\/([^/]+)\/aprobaciones\/?$/.exec(path);
  if (approvals) {
    const clienteId = decode(approvals[1]!);
    if (clienteId !== null) return { name: 'aprobaciones', clienteId };
  }

  return { name: 'home' };
}

export function hrefAprobaciones(clienteId: string): string {
  return `#/clientes/${encodeURIComponent(clienteId)}/aprobaciones`;
}

export function hrefRevision(clienteId: string, piezaId: string): string {
  return `#/clientes/${encodeURIComponent(clienteId)}/piezas/${encodeURIComponent(piezaId)}`;
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
