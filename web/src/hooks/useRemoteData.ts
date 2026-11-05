import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/http.js';
import type { RemoteState } from '../lib/asyncState.js';
import { loadError } from '../lib/loadError.js';
import { useSession } from '../session/SessionContext.js';

// One independent GET per section: own loading, own error, own manual retry. A 404 becomes an empty
// section; a 401 expires the session; anything else is shown in Spanish and only retried by hand.
export function useRemoteData<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
): { state: RemoteState<T>; reload: () => void } {
  const { expire } = useSession();
  const [reloadToken, setReloadToken] = useState(0);
  const [state, setState] = useState<RemoteState<T>>({ status: 'loading' });
  const loadRef = useRef(load);
  const seq = useRef(0);
  loadRef.current = load;

  useEffect(() => {
    const current = ++seq.current;
    setState({ status: 'loading' });

    loadRef.current().then(
      (data) => {
        if (seq.current === current) setState({ status: 'ready', data });
      },
      (error: unknown) => {
        if (seq.current !== current) return;
        if (error instanceof ApiError && error.status === 401) {
          expire();
          return;
        }
        if (error instanceof ApiError && error.status === 404) {
          setState({ status: 'empty' });
          return;
        }
        setState({ status: 'error', ...loadError(error) });
      },
    );

    // The sequence guard makes a late response harmless when the piece changes or the user retries.
  }, [reloadToken, expire, ...deps]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  return { state, reload };
}
