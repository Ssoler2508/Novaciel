import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/http.js';
import { getPiezaProduccion, type PiezaProduccion } from '../api/pieza.js';
import type { RemoteState } from '../lib/asyncState.js';
import { loadError } from '../lib/loadError.js';
import { useSession } from '../session/SessionContext.js';

// Production needs more than a plain GET: a file that fails to load triggers ONE refetch of the
// production (to renew the signed URLs) and a timer renews them before they expire. The signed URL
// itself is only handed to <img>/<video>: never rebuilt, logged or persisted.
export function usePiezaProduction(clienteId: string, piezaId: string) {
  const { expire } = useSession();
  const [reloadToken, setReloadToken] = useState(0);
  const [state, setState] = useState<RemoteState<PiezaProduccion>>({ status: 'loading' });
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(() => new Set());
  const seq = useRef(0);
  const fileRetryUsed = useRef(false);
  const refreshPromise = useRef<Promise<boolean> | null>(null);

  const load = useCallback(
    async (silent: boolean): Promise<boolean> => {
      const current = ++seq.current;
      if (!silent) setState({ status: 'loading' });
      try {
        const data = await getPiezaProduccion(clienteId, piezaId);
        if (seq.current !== current) return false;
        setState({ status: 'ready', data });
        setUnavailable(new Set());
        return true;
      } catch (error) {
        if (seq.current !== current) return false;
        if (error instanceof ApiError && error.status === 401) {
          expire();
          return false;
        }
        if (!silent) {
          if (error instanceof ApiError && error.status === 404) setState({ status: 'empty' });
          else setState({ status: 'error', ...loadError(error) });
        }
        return false;
      }
    },
    [clienteId, piezaId, expire],
  );

  useEffect(() => {
    fileRetryUsed.current = false;
    refreshPromise.current = null;
    void load(false);
  }, [load, reloadToken]);

  // Renew once per expiry window. The cleanup clears the timer when the piece changes or unmounts.
  useEffect(() => {
    if (state.status !== 'ready') return;
    const seconds = state.data.archivos
      .map((archivo) => archivo.url_expira_en_s)
      .filter((value) => Number.isFinite(value) && value > 0);
    if (seconds.length === 0) return;
    const delay = Math.max(1, Math.round(Math.min(...seconds))) * 1000;
    const timer = window.setTimeout(() => {
      void load(true);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [state, load]);

  const onFileError = useCallback(
    (url: string) => {
      if (state.status !== 'ready' || !state.data.archivos.some((archivo) => archivo.url === url)) {
        return;
      }

      if (!fileRetryUsed.current) {
        fileRetryUsed.current = true;
        const pending = load(true);
        refreshPromise.current = pending;
        void pending.then((ok) => {
          refreshPromise.current = null;
          if (!ok) setUnavailable((prev) => (prev.has(url) ? prev : new Set(prev).add(url)));
        });
        return;
      }

      if (refreshPromise.current !== null) {
        const pending = refreshPromise.current;
        void pending.then((ok) => {
          if (!ok) setUnavailable((prev) => (prev.has(url) ? prev : new Set(prev).add(url)));
        });
        return;
      }

      setUnavailable((prev) => (prev.has(url) ? prev : new Set(prev).add(url)));
    },
    [state, load],
  );

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  return { state, unavailable, onFileError, reload };
}
