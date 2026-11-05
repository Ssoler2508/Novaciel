import { useEffect, useState } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'planes'; clienteId: string; semana: string | null }
  | { name: 'plan'; clienteId: string; planId: string }
  | { name: 'planRevision'; clienteId: string; planId: string }
  | { name: 'pieza'; clienteId: string; piezaId: string };

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function splitHash(hash: string): { path: string; params: URLSearchParams } {
  const raw = hash.replace(/^#/, '') || '/';
  const queryAt = raw.indexOf('?');
  const path = queryAt === -1 ? raw : raw.slice(0, queryAt);
  const query = queryAt === -1 ? '' : raw.slice(queryAt + 1);
  return { path: path || '/', params: new URLSearchParams(query) };
}

export function parseRoute(hash: string): Route {
  const { path, params } = splitHash(hash);

  const planRevision = /^\/clientes\/([^/]+)\/planes\/([^/]+)\/revision\/?$/.exec(path);
  if (planRevision) {
    const clienteId = decode(planRevision[1]!);
    const planId = decode(planRevision[2]!);
    if (clienteId !== null && planId !== null) return { name: 'planRevision', clienteId, planId };
    return { name: 'home' };
  }

  const plan = /^\/clientes\/([^/]+)\/planes\/([^/]+)\/?$/.exec(path);
  if (plan) {
    const clienteId = decode(plan[1]!);
    const planId = decode(plan[2]!);
    if (clienteId !== null && planId !== null) return { name: 'plan', clienteId, planId };
    return { name: 'home' };
  }

  const planes = /^\/clientes\/([^/]+)\/planes\/?$/.exec(path);
  if (planes) {
    const clienteId = decode(planes[1]!);
    if (clienteId !== null) return { name: 'planes', clienteId, semana: params.get('semana') };
    return { name: 'home' };
  }

  const pieza = /^\/clientes\/([^/]+)\/piezas\/([^/]+)\/?$/.exec(path);
  if (pieza) {
    const clienteId = decode(pieza[1]!);
    const piezaId = decode(pieza[2]!);
    if (clienteId !== null && piezaId !== null) return { name: 'pieza', clienteId, piezaId };
    return { name: 'home' };
  }

  return { name: 'home' };
}

export function hrefPlanes(clienteId: string, semana?: string | null): string {
  const base = `#/clientes/${encodeURIComponent(clienteId)}/planes`;
  return semana ? `${base}?semana=${encodeURIComponent(semana)}` : base;
}

export function hrefPlan(clienteId: string, planId: string): string {
  return `#/clientes/${encodeURIComponent(clienteId)}/planes/${encodeURIComponent(planId)}`;
}

export function hrefPlanRevision(clienteId: string, planId: string): string {
  return `${hrefPlan(clienteId, planId)}/revision`;
}

export function hrefPieza(clienteId: string, piezaId: string): string {
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
