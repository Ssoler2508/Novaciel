// Shapes match the backend exactly: login returns the user without roles; /auth/me returns the same
// user plus roles as { rol, clienteId } objects. Role names are shown as received, never translated.
import { getJson, postJson } from './http.js';

export interface SessionUser {
  id: string;
  email: string;
  nombre: string;
}

export interface UserRole {
  rol: string;
  clienteId: string | null;
}

export interface Session extends SessionUser {
  roles: UserRole[];
}

export function login(email: string, password: string): Promise<SessionUser> {
  return postJson<SessionUser>('/auth/login', { email, password });
}

export function me(): Promise<Session> {
  return getJson<Session>('/auth/me');
}

export function logout(): Promise<void> {
  return postJson<void>('/auth/logout', {});
}
