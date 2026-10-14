import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { requireScope } from '../middleware/autenticar.js';
import { createNotasController } from '../controllers/notasController.js';

export function notasRoutes(services) {
  const router = Router();
  const c = createNotasController(services);
  const sensitive = rateLimit({ windowMs: 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, message: { erro: { codigo: 'LIMITE_REQUISICOES', mensagem: 'Aguarde antes de tentar novamente.' } } });
  router.post('/sincronizar', requireScope('notas:sincronizar'), sensitive, c.sincronizar);
  router.get('/status', requireScope('notas:ler'), c.status);
  router.get('/sincronizacoes', requireScope('notas:ler'), c.historico);
  router.get('/sincronizacoes/:id', requireScope('notas:ler'), c.execucao);
  router.get('/', requireScope('notas:ler'), c.listar);
  router.get('/:chave', requireScope('notas:ler'), c.obter);
  router.get('/:chave/xml', requireScope('notas:download'), c.xml);
  router.get('/:chave/danfe', requireScope('notas:download'), c.pdf);
  router.post('/:chave/danfe', requireScope('notas:gerar'), sensitive, c.gerar);
  return router;
}
