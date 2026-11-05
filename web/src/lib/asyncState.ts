// Shared shape for the independent sections of the piece screen. A 404 is an empty section, not an
// error: the backend uses it when the piece has no production, brief, report or revision yet.
export type RemoteState<T> =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'error'; message: string; retryable: boolean }
  | { status: 'ready'; data: T };
