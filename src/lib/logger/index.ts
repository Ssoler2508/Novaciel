import { pino } from 'pino';
import { config } from '../../config/index.js';

const sensitive = [
  'password',
  'contrasena',
  'password_hash',
  'token',
  'session',
  'cookie',
  'authorization',
  'secret',
  'ciphertext',
  'api_key',
];

export const redactPaths = sensitive.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]);

export function createLogger(level: string = config.LOG_LEVEL, destination?: pino.DestinationStream) {
  return pino({ level, redact: { paths: redactPaths, censor: '[REDACTED]' } }, destination);
}

export const logger = createLogger();
