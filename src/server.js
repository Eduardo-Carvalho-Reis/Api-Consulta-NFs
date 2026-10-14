import { loadConfig } from './config/env.js';
import { createLogger } from './config/logger.js';
import { createDatabase } from './config/database.js';
import { StorageService } from './services/storageService.js';
import { createDanfeService } from './services/danfeService.js';
import { createDistribuicaoService } from './services/distribuicaoService.js';
import { startWorker } from './jobs/sincronizarNotas.js';
import { createApp } from './app.js';

let config;
try { config = loadConfig(); }
catch { console.error('Configuração inválida. Verifique DATABASE_URL, JWT_SECRET e .env.example. Nenhum segredo foi registrado.'); process.exit(1); }
const logger = createLogger(config.LOG_LEVEL);
const database = createDatabase(config.DATABASE_URL);
try {
  await database.prisma.$connect();
  const storage = new StorageService(config.STORAGE_DIR); await storage.init();
  const services = { ...database, storage, config, logger };
  services.danfe = createDanfeService(services);
  services.distribuicao = createDistribuicaoService(services);
  const app = createApp(services);
  const server = app.listen(config.PORT, config.HOST, () => logger.info({ port: config.PORT }, 'API iniciada'));
  const stopWorker = startWorker(services);
  let closing = false;
  const shutdown = async () => {
    if (closing) return; closing = true;
    server.close(); await stopWorker(); await database.close();
  };
  server.on('error', async () => { logger.error('Não foi possível iniciar o servidor HTTP.'); await shutdown(); process.exitCode = 1; });
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
} catch {
  logger.error('Falha ao iniciar. Verifique conexão com PostgreSQL, migrations e permissões de armazenamento.');
  await database.close(); process.exitCode = 1;
}
