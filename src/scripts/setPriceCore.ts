import type { Db } from '../db/types.js';
import { setModelPrice, setUnitPrice, type ModelPrice, type UnitPrice } from '../modules/precios/preciosRepository.js';
import { getUsuarioByEmail } from '../modules/usuarios/usuariosRepository.js';
import type { SetPriceArgs } from './setPriceArgs.js';

/**
 * Writes a new model price as the given administrator. It goes through setModelPrice, so the
 * manage_budget permission check and the audit row are the real ones: an email that is not an
 * active administrator is refused and nothing is written.
 */
export async function setPriceAsAdmin(db: Db, args: SetPriceArgs): Promise<ModelPrice | UnitPrice> {
  const user = await getUsuarioByEmail(db, args.adminEmail);
  if (!user || !user.activo) throw new Error('No active user with that email');
  const actor = { tipo: 'usuario', usuarioId: user.id } as const;
  if (args.unit !== 'tokens') {
    return setUnitPrice(
      db,
      {
        provider: args.provider,
        model: args.model,
        unit: args.unit,
        pricePerBlock: args.pricePerBlock,
        blockSize: args.blockSize,
        ...(args.nota !== undefined ? { nota: args.nota } : {}),
      },
      actor,
    );
  }
  return setModelPrice(
    db,
    {
      provider: args.provider,
      model: args.model,
      inputPerMillion: args.inputPerMillion,
      outputPerMillion: args.outputPerMillion,
      ...(args.nota !== undefined ? { nota: args.nota } : {}),
    },
    actor,
  );
}
