import { NovaCielShell } from './components/NovaCielShell.js';
import { es } from './i18n/index.js';
import { useHashRoute, type Route } from './router.js';
import { HomeScreen } from './screens/HomeScreen.js';
import { LoginScreen } from './screens/LoginScreen.js';
import { NoAccessScreen } from './screens/NoAccessScreen.js';
import { hasNovaCielAccess } from './session/roles.js';
import { SessionProvider, useSession } from './session/SessionContext.js';

function PendingNovaCielScreen({ title }: { title: string }) {
  return (
    <NovaCielShell title={title}>
      <p className="muted">{es.interna.pending}</p>
    </NovaCielShell>
  );
}

function NovaCielScreen({ route }: { route: Exclude<Route, { name: 'home' }> }) {
  switch (route.name) {
    case 'pieza':
      return <PendingNovaCielScreen title={es.interna.piece} />;
    case 'planes':
    case 'plan':
    case 'planRevision':
      return <PendingNovaCielScreen title={es.nav.planner} />;
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
