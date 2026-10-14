import path from 'node:path';
import { chaveSchema, listSchema, historySchema, executionIdSchema } from '../utils/validation.js';
import { AppError } from '../utils/errors.js';

export function publicNota(nota) {
  const { caminhoXml, caminhoDanfe, hashXml, hashDanfe, empresaId, ...data } = nota;
  return { ...data, xmlDisponivel: Boolean(caminhoXml), danfeDisponivel: Boolean(caminhoDanfe) };
}
export function createNotasController({ prisma, storage, distribuicao, danfe }) {
  const get = async req => {
    const chave = chaveSchema.parse(req.params.chave);
    const nota = await prisma.notaFiscal.findUnique({ where: { empresaId_chaveAcesso: { empresaId: req.empresa.id, chaveAcesso: chave } } });
    if (!nota) throw new AppError(404, 'NOTA_NAO_ENCONTRADA', 'Nota fiscal não encontrada.');
    return nota;
  };
  return {
    sincronizar: async (req, res) => {
      const { execution, reused } = await distribuicao.request(req.empresa);
      res.location(`/api/notas/sincronizacoes/${execution.id}`).status(202).json({ dados: { id: execution.id, status: execution.status, reutilizada: reused, mensagem: 'Solicitação registrada; o resultado depende do processamento da resposta da SEFAZ.' } });
    },
    listar: async (req, res) => {
      const q = listSchema.parse(req.query);
      const where = { empresaId: req.empresa.id, ...(q.emitente && { cnpjEmitente: q.emitente }), ...(q.numero && { numero: String(Number(q.numero)) }), ...(q.chave && { chaveAcesso: q.chave }), ...(q.status && { statusImportacao: q.status }) };
      if (q.inicio || q.fim) where.dataEmissao = { ...(q.inicio && { gte: new Date(`${q.inicio}T00:00:00-03:00`) }), ...(q.fim && { lt: new Date(+new Date(`${q.fim}T00:00:00-03:00`) + 86400000) }) };
      const [total, rows] = await prisma.$transaction([prisma.notaFiscal.count({ where }), prisma.notaFiscal.findMany({ where, skip: (q.pagina - 1) * q.limite, take: q.limite, orderBy: [{ dataEmissao: q.ordem }, { id: q.ordem }] })]);
      res.json({ dados: rows.map(publicNota), paginacao: { pagina: q.pagina, limite: q.limite, total } });
    },
    obter: async (req, res) => res.json({ dados: publicNota(await get(req)) }),
    xml: async (req, res) => {
      const nota = await get(req);
      if (!nota.caminhoXml) throw new AppError(409, 'XML_INDISPONIVEL', 'Somente resumo disponível; XML completo pode depender de manifestação ou distribuição posterior.');
      const data = await storage.readNote(req.empresa, nota.caminhoXml, 'xml', nota.hashXml);
      res.attachment(path.basename(nota.caminhoXml)).type('application/xml').send(data);
    },
    pdf: async (req, res) => {
      const nota = await get(req);
      if (!nota.caminhoDanfe) throw new AppError(409, 'DANFE_INDISPONIVEL', 'DANFE indisponível. Solicite a geração e consulte o motivo da falha nos metadados.');
      const data = await storage.readNote(req.empresa, nota.caminhoDanfe, 'pdf', nota.hashDanfe);
      res.attachment(path.basename(nota.caminhoDanfe)).type('application/pdf').send(data);
    },
    gerar: async (req, res) => res.json({ dados: publicNota(await danfe.generate(req.empresa, chaveSchema.parse(req.params.chave), true)) }),
    status: async (req, res) => {
      const [control, last] = await Promise.all([prisma.controleDistribuicao.findUnique({ where: { empresaId: req.empresa.id } }), prisma.historicoSincronizacao.findFirst({ where: { empresaId: req.empresa.id }, orderBy: { dataInicio: 'desc' } })]);
      const { respostaPendente, hashResposta, empresaId, ...safe } = control;
      res.json({ dados: { controle: { ...safe, possuiLotePendente: Boolean(respostaPendente) }, ultimaSincronizacao: last } });
    },
    historico: async (req, res) => {
      const q = historySchema.parse(req.query);
      const where = { empresaId: req.empresa.id, ...(q.status && { status: q.status }) };
      const [total, dados] = await prisma.$transaction([prisma.historicoSincronizacao.count({ where }), prisma.historicoSincronizacao.findMany({ where, skip: (q.pagina - 1) * q.limite, take: q.limite, orderBy: [{ dataInicio: 'desc' }, { id: 'desc' }] })]);
      res.json({ dados, paginacao: { pagina: q.pagina, limite: q.limite, total } });
    },
    execucao: async (req, res) => {
      const id = executionIdSchema.parse(req.params.id);
      const execution = await prisma.historicoSincronizacao.findFirst({ where: { id, empresaId: req.empresa.id } });
      if (!execution) throw new AppError(404, 'EXECUCAO_NAO_ENCONTRADA', 'Execução não encontrada para esta empresa.');
      res.json({ dados: execution });
    },
  };
}
