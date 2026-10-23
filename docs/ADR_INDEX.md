# Architecture decision records

One line per ADR. ADR-01 to ADR-04 are written in Spanish and were copied unchanged from the project notes (`brain/`, which is not versioned); the `[[...]]` links inside them point to those notes and do not resolve in this repository. ADR-05 and ADR-06 are written in English.

| ADR | Title | Status | Summary |
| --- | --- | --- | --- |
| [ADR-01](ADR-01-Decision-D3.md) | Claude as the main language model provider | Accepted (spec decision D3) | Claude is the system's brain, behind the `LLMProvider` adapter; provider and models live in configuration. |
| [ADR-02](ADR-02-Stack.md) | Technical stack | Accepted with changes (7 Oct update) | Strict TypeScript, PostgreSQL, pg-boss on the same database, S3-compatible storage, FFmpeg; chosen to minimize the pieces to operate. |
| [ADR-03](ADR-03-Plataforma-multicliente.md) | Central multi-client platform | Accepted (spec decision D1) | One platform for all clients with strict isolation: `cliente_id` in every table, storage path and query; network accounts belong to the client. |
| [ADR-04](ADR-04-Modelo-de-datos-del-Paso-2.md) | Step 2 data model | Accepted, with points pending confirmation | Columns of `clientes` and `usuarios`, the versioned brand profile and its supporting tables; JSON keys and required fields are proposals to confirm. |
| [ADR-05](ADR-05_APROBACION_DOS_NIVELES.md) | Two-level approval | Built (Step 9) | Internal review then client approval, recorded against the exact piece hash; change rounds, escalation, reminders, publish gate (`assertPublicable`) and the temporary Step 8 bridge. |
| [ADR-06](ADR-06_REMOTION_LICENCIA.md) | Remotion: license gate and integration | Built (Step 7c) | `REMOTION_LICENCIA` has no default (unset = Remotion disabled); Remotion renders only a transparent text layer that the FFmpeg pipeline composes. |

Related technical notes: [HASH_PIEZA_NP1.md](HASH_PIEZA_NP1.md) (piece hash format and test vectors; do not change).
