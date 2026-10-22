import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import * as authApi from '../api/auth.js';
import type { Session } from '../api/auth.js';

// Only three states, as required. Nothing is persisted: the session lives in memory and the
// HttpOnly cookie, never in localStorage, sessionStorage or a global.
type SessionState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authenticated'; user: Session };

interface SessionContextValue {
  state: SessionState;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | undefined>(undefined);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    authApi.me().then(
      (user) => {
        if (active) setState({ status: 'authenticated', user });
      },
      () => {
        if (active) setState({ status: 'anonymous' });
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    await authApi.login(email, password);
    // The login response has no roles, so the session is read again after the cookie is set.
    const user = await authApi.me();
    setState({ status: 'authenticated', user });
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout();
    setState({ status: 'anonymous' });
  }, []);

  const value = useMemo(() => ({ state, login, logout }), [state, login, logout]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
