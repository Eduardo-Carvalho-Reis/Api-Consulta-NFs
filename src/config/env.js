import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

export function loadConfig(env = process.env) {
  const values = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().default('127.0.0.1'),
    DATABASE_URL: z.string().url(),
    JWT_SECRET: z.string().min(32),
    JWT_ISSUER: z.string().default('api-notas-fiscais'),
    JWT_AUDIENCE: z.string().default('api-notas-fiscais'),
    SEFAZ_AMBIENTE: z.enum(['1', '2']).default('2'),
    SYNC_ENABLED: z.enum(['true', 'false']).default('false'),
    SYNC_INTERVAL_MS: z.coerce.number().int().min(3600000).default(3600000),
    SYNC_MAX_BATCHES: z.coerce.number().int().min(1).max(100).default(10),
    SEFAZ_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
    STORAGE_DIR: z.string().default('./storage/notas-fiscais'),
    LOG_LEVEL: z.enum(['debug','info','warn','error','silent']).default('info'),
  }).parse(env);
  return { ...values, STORAGE_DIR: path.resolve(values.STORAGE_DIR) };
}
