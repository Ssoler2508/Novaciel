/**
 * SQL condition for "this media item is usable at AT" (rule written in the media migration). One
 * place for the rule, used by getUsableMedia and listMedia({ usable: true }).
 *
 * Usable when: not deleted; rights not expired; and, if people appear, there is at least one linked
 * authorization AND every linked authorization is valid at AT. "Valid" is exactly the condition of
 * getValidAutorizaciones: not a minor, vigente_desde <= AT < vigente_hasta, not revoked at AT.
 *
 * @param at SQL for the instant: 'now()' (the database clock) or a parameter such as '$3'.
 * @param alias the alias of the media table in the query.
 */
export function usableCondition(at: string, alias = 'm'): string {
  return `(
    ${alias}.eliminado_en IS NULL
    AND (${alias}.derechos_hasta IS NULL OR ${alias}.derechos_hasta > ${at})
    AND (
      NOT ${alias}.aparecen_personas
      OR (
        EXISTS (
          SELECT 1 FROM media_autorizaciones link
          WHERE link.media_id = ${alias}.id AND link.cliente_id = ${alias}.cliente_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM media_autorizaciones link
          JOIN autorizaciones_imagen aut ON aut.id = link.autorizacion_id AND aut.cliente_id = link.cliente_id
          WHERE link.media_id = ${alias}.id AND link.cliente_id = ${alias}.cliente_id
            AND NOT (
              aut.es_menor = false
              AND aut.vigente_desde <= ${at} AND aut.vigente_hasta > ${at}
              AND (aut.revocada_en IS NULL OR aut.revocada_en > ${at})
            )
        )
      )
    )
  )`;
}
