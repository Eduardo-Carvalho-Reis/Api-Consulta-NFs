import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { autenticar, authorizeCompany, requireScope } from './middleware/autenticar.js';
import { tratarErros } from './middleware/tratarErros.js';
import { notasRoutes } from './routes/notasRoutes.js';
import { publicEmpresa } from './repositories/empresaRepository.js';
import { empresaSchema } from './utils/validation.js';
import { AppError } from './utils/errors.js';

export function createApp(services) {
  const { config, prisma, logger, withCompanyLock } = services;
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use((req, res, next) => {
    req.id = randomUUID(); res.set('X-Request-Id', req.id); res.set('Cache-Control', 'no-store');
    res.on('finish', () => logger.info({ requestId: req.id, method: req.method, status: res.statusCode }, 'HTTP'));
    next();
  });
  app.use(rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false, message: { erro: { codigo: 'LIMITE_REQUISICOES', mensagem: 'Limite de requisições excedido.' } } }));
  app.use(express.json({ limit: '16kb' }));
  app.get('/health', async (req, res) => { await prisma.$queryRaw`SELECT 1`; res.json({ status: 'ok' }); });
  app.use('/api', autenticar(config));
  app.get('/api/empresas', requireScope('empresas:ler'), async (req, res) => res.json({ dados: (await prisma.empresa.findMany({ where: { cnpj: { in: req.auth.cnpjs } } })).map(publicEmpresa) }));
  // Registration is an operator-only local command; HTTP cannot choose filesystem/secret paths.
  app.patch('/api/empresa', authorizeCompany(prisma), requireScope('empresas:editar'), async (req, res) => {
    const data = empresaSchema.pick({ nome: true, ativa: true, ufAutor: true }).partial().strict().parse(req.body);
    const result = await withCompanyLock(req.empresa.id, () => prisma.empresa.update({ where: { id: req.empresa.id }, data }));
    if (!result.acquired) throw new AppError(409, 'EMPRESA_OCUPADA', 'Aguarde o processamento da empresa.');
    res.json({ dados: publicEmpresa(result.value) });
  });
  app.use('/api/notas', authorizeCompany(prisma), notasRoutes(services));
  app.use((req, res, next) => next(new AppError(404, 'ROTA_NAO_ENCONTRADA', 'Rota não encontrada.')));
  app.use(tratarErros(logger));
  return app;
}
