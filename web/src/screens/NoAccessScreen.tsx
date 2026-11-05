import { es } from '../i18n/index.js';

export function NoAccessScreen() {
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
