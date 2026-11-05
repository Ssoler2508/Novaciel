import { es } from './i18n/index.js';
import { useHashRoute, type Route } from './router.js';
import { AprobacionesScreen } from './screens/AprobacionesScreen.js';
import { HomeScreen } from './screens/HomeScreen.js';
import { LoginScreen } from './screens/LoginScreen.js';
import { NoAccessScreen } from './screens/NoAccessScreen.js';
import { PiezaScreen } from './screens/PiezaScreen.js';
import { PlanDetailScreen } from './screens/PlanDetailScreen.js';
import { PlanesScreen } from './screens/PlanesScreen.js';
import { PlanRevisionScreen } from './screens/PlanRevisionScreen.js';
import { RevisionScreen } from './screens/RevisionScreen.js';
import { hasNovaCielAccess, nivelAprobacion } from './session/roles.js';
import { SessionProvider, useSession } from './session/SessionContext.js';

function NovaCielScreen({ route }: { route: Exclude<Route, { name: 'home' }> }) {
  switch (route.name) {
    case 'planes':
      return <PlanesScreen clienteId={route.clienteId} semana={route.semana} />;
    case 'pieza':
      return <PiezaScreen clienteId={route.clienteId} piezaId={route.piezaId} />;
    case 'plan':
      return <PlanDetailScreen clienteId={route.clienteId} planId={route.planId} />;
    case 'planRevision':
      return <PlanRevisionScreen clienteId={route.clienteId} planId={route.planId} />;
  }
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

  if (route.name === 'home') return <HomeScreen user={state.user} />;

  if (route.name === 'aprobaciones') {
    if (nivelAprobacion(state.user.roles, route.clienteId) === null) return <NoAccessScreen />;
    return <AprobacionesScreen clienteId={route.clienteId} />;
  }

  if (route.name === 'revision') {
    if (nivelAprobacion(state.user.roles, route.clienteId) === null) return <NoAccessScreen />;
    return (
      <RevisionScreen
        key={`${route.clienteId}:${route.piezaId}`}
        clienteId={route.clienteId}
        piezaId={route.piezaId}
      />
    );
  }

  if (!hasNovaCielAccess(state.user.roles)) return <NoAccessScreen />;

  return <NovaCielScreen route={route} />;
}

export function App() {
  return (
    <SessionProvider>
      <CurrentScreen />
    </SessionProvider>
  );
}
