import { es } from './i18n/index.js';
import { LoginScreen } from './screens/LoginScreen.js';
import { HomeScreen } from './screens/HomeScreen.js';
import { SessionProvider, useSession } from './session/SessionContext.js';

function CurrentScreen() {
  const { state } = useSession();

  if (state.status === 'loading') {
    return (
      <main className="screen">
        <p role="status">{es.common.loading}</p>
      </main>
    );
  }

  if (state.status === 'anonymous') return <LoginScreen />;

  return <HomeScreen user={state.user} />;
}

export function App() {
  return (
    <SessionProvider>
      <CurrentScreen />
    </SessionProvider>
  );
}
