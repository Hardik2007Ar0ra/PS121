import pino from 'pino';
import config from '../config.js';

/**
 * Structured logger. Levels are controlled by NWIS_LOG_LEVEL so the same code
 * path is quiet during a demo and verbose when debugging an extraction.
 */
const logger = pino({
  level: config.logLevel,
  base: { service: 'nwis' },
  redact: {
    paths: [
      'req.headers.authorization',
      'headers.authorization',
      'password',
      '*.password',
      'token',
      '*.token',
      'config.auth.jwtSecret',
      'config.llm.apiKey',
    ],
    censor: '[redacted]',
  },
});

export default logger;