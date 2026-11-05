import { es } from '../i18n/index.js';

export function SectionLoading() {
  return (
    <p className="muted" role="status">
      {es.common.loading}
    </p>
  );
}

export function SectionEmpty({ message }: { message: string }) {
  return <p className="muted">{message}</p>;
}

export function SectionError({
  message,
  retryable,
  onRetry,
}: {
  message: string;
  retryable: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="section" aria-live="polite">
      <p className="error" role="alert">
        {message}
      </p>
      {retryable && (
        <div className="page-actions">
          <button className="button button--secondary" type="button" onClick={onRetry}>
            {es.common.retry}
          </button>
        </div>
      )}
    </div>
  );
}
