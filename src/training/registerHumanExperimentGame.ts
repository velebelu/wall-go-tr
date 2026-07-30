/**
 * Comando retirado a propósito.
 *
 * Escribía `registry.json` directamente y saltaba todas las salvaguardas del experimento V3.
 * Se conserva como punto de entrada para que quien lo tenga anotado en un guion de sesión
 * reciba una indicación clara en lugar de un fallo opaco de módulo inexistente.
 */
throw new Error(
  [
    'human-experiment:register-game fue retirado.',
    'Escribía registry.json sin validar sessionType, commits, replay ni traceSha256, y sin',
    'actualizar metadata.json, el archivo de partida ni la traza oficial, dejando el',
    'experimento fallando human-experiment:validate-v3.',
    '',
    'Vía admitida (publica traza, registro, archivo de partida y metadatos en una',
    'única transacción):',
    '  npm run human-experiment:ingest-latest -- <P0X> <1|2>',
  ].join('\n'),
)
