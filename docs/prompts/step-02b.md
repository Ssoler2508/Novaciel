# Step 2b — Authentication, sessions and secrets encryption

Checkpoints: A → B → C → D → E → F → G. Each one is independently verifiable and ends in one commit.
Must be merged before Steps 9, 10 and 11.

---

## How to run (rules for Claude Code)

- Run **only the checkpoint you are asked for**. When its commit is done, stop and print:
  - the files changed;
  - the dependencies added, and why;
  - the commands to verify it.

  Do not start the next checkpoint until told.
- Plan first for every checkpoint. If the checkpoint is unclear or conflicts with CLAUDE.md, docs/PLAN.md or the spec, stop and ask. Checkpoints B and F ask you to present a design in the plan and wait for approval. In those, do not write code until the developer approves.
- Branch: at checkpoint A, check that the working tree is clean and create `step-02b` from `main` (`git switch -c step-02b`). For later checkpoints, make sure you are on `step-02b`. Never commit to `main` and never merge.
- Commit message format: `step-02b(<letter>): <short summary>`. One commit per checkpoint; extra commits only to fix that same checkpoint.
- A checkpoint is done only when `npm test` and `npm run typecheck` pass. For checkpoints with migrations, `npm run migrate:up`, then `npm run migrate:down` (once per migration of the checkpoint), then `npm run migrate:up` must run cleanly.

## Context to read

- CLAUDE.md.
- Step 2b in docs/PLAN.md. **At checkpoint A, compare it with this file. If they conflict, list the conflicts in your plan and ask before building.**
- .env.example. **Never read .env.**
- The code you need from Step 2: `src/config`, `src/db` (`Db`, `runInTransaction`), `src/modules/shared` (`ClienteId`, `buildUpdate`), `src/modules/auditoria` (`recordAudit`), `src/modules/usuarios`, `src/modules/roles`, `tests/utils`, and `src/modules/isolation.test.ts`.
- From docs/ESPECIFICACION_MOTOR_CONTENIDO.md (written in Spanish), read only:
  - section 14 (roles and permissions);
  - section 15 (data, including `conexiones_redes`);
  - section 16 (security rules).

## Rules for every checkpoint

- Domain tables and columns in Spanish, exactly as the spec names them. Functions, variables, comments and commits in English.
- Everything from Step 2 still applies:
  - repositories take `Db` first and use `ClienteId` for client tables;
  - every real write writes one `auditoria` row in the same transaction;
  - every foreign key is `ON DELETE RESTRICT`;
  - tests use factories and `withTestTransaction`, never the seed.
- **Secrets never leave memory in plain text.** No plaintext secret, password, password hash, session token or encryption key may appear in:
  - logs;
  - `auditoria` (`datos_antes` and `datos_despues` must omit or mask them);
  - error messages;
  - test snapshots;
  - commits.
- Use `node:crypto` for all cryptography. Never write your own algorithm. No new dependencies without explaining why first; the only one expected in this step is `@fastify/cookie` (checkpoint E).
- New tables with `cliente_id` must be added to `src/modules/isolation.test.ts`. Its structural guard will fail otherwise.
- Not in this step: domain endpoints (approvals, dashboard), real social-network calls, password reset by email, 2FA. If the spec requires any of them before Step 9, list them in your plan and ask.

---

## Checkpoint A — Secrets encryption utility (no database)

1. New env vars, validated in `src/config` and added to `.env.example` with no real values:
   - `SECRETS_KEYS`: a comma-separated list of `version:base64key` entries, for example `1:<base64>`. Each key must decode to exactly 32 bytes.
   - `SECRETS_ACTIVE_KEY_VERSION`: the version used to encrypt; it must exist in `SECRETS_KEYS`.

   Startup fails with a clear message that never prints a key. In tests, use a fixed test-only key defined in the test setup, never a real one.
2. `src/lib/crypto/secrets.ts`:
   - `encryptSecret(plaintext, context)` returns `{ ciphertext, iv, authTag, keyVersion }` (Buffers or base64; choose one and say which). It uses AES-256-GCM, a random 12-byte IV per call, and `context` as additional authenticated data.
   - `decryptSecret(encrypted, context)` decrypts with the key of `keyVersion`, so old values keep working after rotation. A wrong context, a tampered ciphertext, IV or tag, or an unknown version throws a typed error with no secret in the message.
   - `context` is a string built by the caller, for example `conexiones_redes:<cliente_id>:<red>`.
3. Extend pino's redaction to cover at least: `password`, `contrasena`, `token`, `session`, `cookie`, `secret`, `ciphertext`, `password_hash` and `authorization`. Keep the existing paths.
4. Tests:
   - an encrypt/decrypt round trip;
   - the same plaintext encrypted twice gives different ciphertexts;
   - a tampered ciphertext, a tampered tag and a wrong context all fail;
   - after rotation (active version 2, value encrypted with version 1), decryption still works;
   - config rejects a short key, a malformed list, and an active version that is missing from the list;
   - a logged object with those fields shows them redacted.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint B — conexiones_redes (encrypted client credentials)

**Present this design in your plan and wait for approval before building.**

1. A migration for `conexiones_redes`, with the columns the spec defines in sections 15 and 16. Where the spec is silent, propose and mark them as a proposal. Expected at minimum:
   - `cliente_id NOT NULL` (foreign key and index);
   - the network (`red`) with a CHECK listing the networks the spec names;
   - a non-secret label or account handle;
   - the encrypted fields: ciphertext, IV, auth tag, key version;
   - `creado_por` (foreign key to `usuarios`), `creado_en`;
   - `revocada_en` (nullable).

   State in your plan whether a client may have more than one active connection per network, and enforce it with a partial unique index.
2. Repository `src/modules/conexionesRedes/`:
   - `createConexion(db, clienteId, input, actor)` encrypts with `encryptSecret`. The context includes `cliente_id` and `red`.
   - `listConexiones(db, clienteId)` returns metadata only, never the encrypted or plaintext secret.
   - `getSecretForUse(db, clienteId, conexionId)` is the only function that decrypts. It returns the plaintext to the caller and writes nothing to logs.
   - `rotateConexion(db, clienteId, conexionId, newSecret, actor)` re-encrypts the stored value with a new secret.
   - `revokeConexion(db, clienteId, conexionId, actor)` revokes a connection. There is no hard delete.
   - Every write is audited. `datos_antes` and `datos_despues` exclude the ciphertext, IV, tag and plaintext. Record only that the secret changed.
3. A factory `createConexionRed` in `tests/utils/factories/`, using the test key. Add the table to the cleanup list.
4. Add `conexiones_redes` to `src/modules/isolation.test.ts`: client A cannot list, decrypt, rotate or revoke client B's connections, and B's rows stay unchanged.

Tests:
- the stored row never contains the plaintext (search the raw row for it);
- `getSecretForUse` returns it;
- a row copied to another client fails to decrypt, because the context does not match;
- a revoked connection cannot be used;
- audit rows contain no secret material;
- isolation holds.

Done when migrations up/down/up, `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint C — Passwords

1. A migration that adds authentication columns to `usuarios`:
   - `password_hash` (nullable: a user without a password cannot log in);
   - `intentos_fallidos integer NOT NULL DEFAULT 0`;
   - `bloqueado_hasta timestamptz`;
   - `ultimo_login timestamptz`.

   Use the spec's names if it defines them.
2. `src/lib/crypto/passwords.ts`:
   - `hashPassword(plain)` uses `crypto.scrypt` with a random 16-byte salt. It stores the algorithm, its parameters, the salt and the hash in one self-describing string (for example `scrypt$N$r$p$salt$hash`), so the parameters can change later.
   - `verifyPassword(plain, stored)` uses `timingSafeEqual`.
   - Password policy: at least 12 characters, at most 128.
3. In the usuarios repository:
   - `setPassword(db, usuarioId, plain, actor)` is audited without the hash; it records only `password_changed`.
   - `verifyCredentials(db, email, plain)` returns the user or a generic failure:
     - The lookup uses `lower(email)`.
     - For an unknown email it still runs a hash comparison against a fixed dummy hash, so response time does not reveal which emails exist.
     - It rejects inactive users and users whose `bloqueado_hasta` is in the future, using the database clock.
     - On failure it increments `intentos_fallidos`; at 5 failures it sets `bloqueado_hasta` to 15 minutes from now. The increment and the lock happen in **one atomic SQL statement**: `UPDATE ... SET intentos_fallidos = intentos_fallidos + 1, bloqueado_hasta = CASE WHEN ... END ... RETURNING ...`. Never read the counter in the application and write it back. Concurrent failed logins must not lose increments.
     - The plan must state the trade-off: anyone who knows an email can keep that account locked by retrying every 15 minutes. This is accepted for an internal panel. Per-IP rate limiting is future work.
     - On success it resets the counter and sets `ultimo_login`.
     - These counter updates are not audited. Only lockouts are audited.
   - If section 16 defines other lockout numbers, use the spec's and say so.
4. The factory `createUsuario` accepts an optional `password`.

Tests:
- hash and verify;
- the same password gives different hashes;
- the policy limits;
- a wrong password fails;
- an unknown email fails with the same generic result;
- a user without a password cannot log in;
- an inactive user cannot log in;
- the account locks after 5 failures and unlocks after `bloqueado_hasta`;
- concurrent failures: 5 parallel wrong-password attempts on separate connections leave `intentos_fallidos` at 5 and the account locked (run this test with the cleanup helper, not inside one transaction);
- success resets the counter;
- no hash appears in `auditoria`.

Done when migrations up/down/up, `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint D — Sessions

1. A migration for `sesiones`, a global table with no `cliente_id`. Add it to the documented exceptions in a comment, next to `usuarios`. Columns:
   - `id`, `usuario_id` (foreign key);
   - `token_hash` (SHA-256 of the token, unique), never the token itself;
   - `creado_en`, `ultimo_uso`, `expira_en`, `revocada_en`.
2. New env vars, validated in config, with defaults:
   - `SESSION_TTL_HOURS` (absolute lifetime, default 12);
   - `SESSION_IDLE_MINUTES` (idle timeout, default 120).
3. `src/modules/sesiones/`:
   - `createSession(db, usuarioId)` generates 32 random bytes encoded as base64url. It stores only the hash and returns the plain token **once**.
   - `validateSession(db, token)` hashes the token and finds the session. It rejects the session if it is expired, idle too long, revoked, or belongs to an inactive user, using the database clock. Otherwise it returns the user. It updates `ultimo_uso` only when the stored value is more than 60 seconds old, so most requests cause no write. The idle check uses `ultimo_uso`, so the idle timeout can be up to 60 seconds longer than configured; say so in a comment.
   - `revokeSession(db, token)` revokes one session.
   - `revokeAllSessions(db, usuarioId, actor)` revokes every session of a user.
   - `setPassword` from C must call `revokeAllSessions` in the same transaction.
   - Audit session creation and revocation, without the token or its hash.
4. Add `sesiones` to the cleanup list.

Tests:
- the token is never stored; only its hash is;
- validation works;
- two validations within 60 seconds write `ultimo_uso` only once;
- expired, idle and revoked sessions are rejected;
- a deactivated user's session is rejected;
- a password change revokes all of that user's sessions;
- two sessions of the same user are independent.

Done when migrations up/down/up, `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint E — Login endpoints

1. Add `@fastify/cookie`, after explaining why: it parses and sets cookies safely, and writing that by hand is error-prone.
2. Routes, registered in `src/index.ts` through a plugin in `src/modules/auth/`:
   - `POST /auth/login`, with a JSON body `{ email, password }` validated with zod:
     - It calls `verifyCredentials`, then `createSession`.
     - It sets the cookie `novaciel_session`: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` outside development, and `Max-Age` equal to the TTL.
     - Every failure returns the same 401 with a generic message, whatever the reason: unknown email, wrong password, locked, inactive or no password.
   - `POST /auth/logout` revokes the current session, clears the cookie and returns 204, also when there was no session.
   - `GET /auth/me` returns the user (id, email, nombre) and their roles, or 401.
3. CSRF protection for state-changing routes:
   - require `Content-Type: application/json`;
   - when an `Origin` header is present, it must match `PUBLIC_BASE_URL`.

   `PUBLIC_BASE_URL` already exists in config since Step 1b (optional, default `http://localhost:${PORT}`). Reuse it; do not add a new variable.

   In the plan, justify explicitly why a request **without** an `Origin` header is allowed: with `SameSite=Lax`, a cross-site POST does not carry the session cookie, so it cannot act as the user, and non-browser clients (curl, scripts) send no `Origin`. If you see a reason to reject a missing `Origin` on authenticated routes, propose it.
4. Never log the request body of `/auth/login`.

Tests with `app.inject()` against the test database (factories, and cleanup instead of a transaction if the route needs its own connection; explain which):
- a successful login sets the cookie with the right flags;
- every failure returns the identical 401 body;
- `/auth/me` works with the cookie and returns 401 without it;
- after logout, the same cookie returns 401;
- a wrong `Origin` or a non-JSON body is rejected;
- the login password never appears in captured log output.

Done when `npm test` and `npm run typecheck` pass, and `npm run dev` still answers `GET /health`. Commit.

---

## Checkpoint F — Authorization helpers

**Present the permission matrix in your plan and wait for approval before building.**

1. From spec section 14, list what each of the 5 roles may do, as a matrix of role × action. Include at least: read client data, edit the brand profile, approve internally, approve as the client, manage connections, and manage users.
   - State whether the two NovaCiel roles can act on every client.
   - Mark anything the spec leaves unclear as a proposal.
2. `src/modules/auth/authorize.ts`:
   - a Fastify `requireSession` preHandler that loads the user from the cookie, or returns 401;
   - `requirePermission(action, getClienteId)` returns 403 unless the user's roles grant the action for that client. Client roles count only for their own `cliente_id`; NovaCiel roles count per the approved matrix.
   - The matrix lives in one file, as data.
3. No real domain routes yet. Tests register small test-only routes on a test app instance.

Tests:
- one allowed and one denied case per role for each action in the matrix;
- a client role for client A gets 403 on client B;
- no session gets 401;
- a revoked role assignment takes effect on the next request.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint G — First admin and final check

1. `npm run create-admin`, a development and operations script:
   - It creates or updates a user by email and gives it `administrador_novaciel`.
   - It reads the password from an interactive hidden prompt or from stdin, **never from a command-line argument or an env var**, and never prints it.
   - It goes through the repositories (audited, actor `sistema`).
   - It refuses `*_test` databases.
2. The seed (`npm run seed`) does not set any password. Seed users can only log in after `create-admin` or `setPassword`.
3. Update `.env.example` comments for every new variable, with no values.

Final check for the step, done by Claude Code:
- all of this step's migrations run down and then up cleanly;
- `npm run seed` still reports `Created: 0` on the second run;
- `npm test` and `npm run typecheck` pass;
- `git grep` finds no real key, password or token.

Final check done **by the developer, not by Claude Code**. A hidden password prompt cannot be typed by Claude Code, and it must never invent a password or pipe one through stdin against `novaciel_db`. After the commit, print these as exact commands for Windows PowerShell, then stop:
1. `npm run create-admin`, which the developer runs and types the password into;
2. a `curl.exe` call to `POST /auth/login` that saves the cookie to a file, with the password typed by the developer;
3. a `curl.exe` call to `GET /auth/me` that sends that cookie and should return the user;
4. a `curl.exe` call to `POST /auth/logout`, then `GET /auth/me` again, which should return 401;
5. deleting the cookie file.

Commit. Do not merge; the developer merges `step-02b` into `main` after review.

---

## Known debt (do not build in this step)

- **Re-encryption on key rotation.** `decryptSecret` reads old key versions and `rotateConexion` replaces a secret, but nothing re-encrypts existing values with the new active key. Before any key is retired, a later step needs a script that re-encrypts every `conexiones_redes` row with the active version and reports the rows still on old versions.
- **Per-IP rate limiting on `/auth/login`**, to reduce the account-lockout denial-of-service risk accepted in checkpoint C.