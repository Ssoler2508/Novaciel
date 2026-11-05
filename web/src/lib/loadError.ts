import { ApiError } from '../api/http.js';
import { es } from '../i18n/index.js';

export interface LoadError {
  message: string;
  retryable: boolean;
}

// 401 is handled by the caller (it expires the session); everything else maps to a Spanish message.
export function loadError(error: unknown): LoadError {
  if (error instanceof ApiError) {
    if (error.status === 400) return { message: es.common.invalidRequest, retryable: false };
    if (error.status === 403) return { message: es.common.forbidden, retryable: false };
    if (error.status === 404) return { message: es.common.notFound, retryable: false };
    return { message: es.common.loadError, retryable: true };
  }
  return { message: es.common.networkError, retryable: true };
}
