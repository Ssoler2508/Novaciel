import { es } from './i18n/index.js';
import { useHashRoute } from './router.js';
import { AprobacionesScreen } from './screens/AprobacionesScreen.js';
import { HomeScreen } from './screens/HomeScreen.js';
import { LoginScreen } from './screens/LoginScreen.js';
import { nivelAprobacion } from './session/roles.js';
import { SessionProvider, useSession } from './session/SessionContext.js';

function NoAccessScreen() {
  return (
    <main className="screen">
      <section className="card" aria-labelledby="no-access-title">
        <p className="brand">{es.app.name}</p>
        <h1 id="no-access-title">{es.common.forbidden}</h1>
        <a className="button" href="#/">
          {es.common.backHome}
        </a>
      </section>
    </main>
  );
}

function CurrentScreen() {
  const { state } = useSession();
  const route = useHashRoute();

  if (state.status === 'loading') {
    return (
      <main className="screen">
        <p role="status">{es.common.loading}</p>
      </main>
    );
  }

  if (state.status === 'anonymous') return <LoginScreen />;

  if (route.name === 'aprobaciones') {
    if (nivelAprobacion(state.user.roles, route.clienteId) === null) return <NoAccessScreen />;
    return <AprobacionesScreen clienteId={route.clienteId} />;
  }

  return <HomeScreen user={state.user} />;
}

export function App() {
  return (
    <SessionProvider>
      <CurrentScreen />
    </SessionProvider>
  );
}
