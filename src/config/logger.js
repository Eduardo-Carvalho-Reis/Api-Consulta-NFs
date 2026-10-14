import pino from 'pino';
export const createLogger = (level = 'info') => pino({
  level,
  redact: ['password', 'senha', 'token', 'authorization', 'cert', 'key', 'pfx', 'xml', 'req.headers.authorization'],
});
