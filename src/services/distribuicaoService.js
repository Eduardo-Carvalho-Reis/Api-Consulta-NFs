import { randomUUID } from 'node:crypto';
import { parseResponse, inflateDocument, inspectDocument } from './xmlService.js';
import { notePaths, hash } from './storageService.js';
import { consultarSefaz } from './sefazService.js';
import { loadCertificate } from './certificateService.js';
import { AppError, safeError } from '../utils/errors.js';

export const HOUR = 3600000;
export function retryDelay(failures) { return Math.min(24 * HOUR, HOUR * 2 ** Math.min(failures, 5)); }
const active = ['PENDENTE', 'EXECUTANDO'];

export function createDistribuicaoService({ prisma, storage, withCompanyLock, danfe, config, logger, transport = consultarSefaz, certificateLoader = loadCertificate, now = () => new Date() }) {
  async function request(empresa, origem = 'MANUAL') {
    if (empresa.ambiente !== config.SEFAZ_AMBIENTE) throw new AppError(409, 'AMBIENTE_DIVERGENTE', 'Empresa pertence a outro ambiente fiscal.');
    if (!empresa.ativa) throw new AppError(409, 'EMPRESA_INATIVA', 'A consulta desta empresa está desativada.');
    const current = await prisma.historicoSincronizacao.findFirst({ where: { empresaId: empresa.id, status: { in: active } } });
    if (current) return { execution: current, reused: true };
    const control = await prisma.controleDistribuicao.findUnique({ where: { empresaId: empresa.id } });
    if (control.status === 'RECONCILIAR') throw new AppError(409, 'NSU_RECONCILIACAO', 'NSU diverge do servidor. Reconcilie com outros consumidores antes de continuar.');
    if (!control.respostaPendente && control.proximaConsulta > now()) throw new AppError(429, 'SEFAZ_AGUARDAR', `Nova consulta permitida a partir de ${control.proximaConsulta.toISOString()}.`);
    // No network call happens at submission time. Certificate validation gives immediate feedback.
    await certificateLoader(empresa);
    try {
      const execution = await prisma.historicoSincronizacao.create({ data: { empresaId: empresa.id, origem } });
      logger.info({ executionId: execution.id, empresaId: empresa.id }, 'Sincronização solicitada');
      return { execution, reused: false };
    } catch (error) {
      if (error.code !== 'P2002') throw error;
      return { execution: await prisma.historicoSincronizacao.findFirst({ where: { empresaId: empresa.id, status: { in: active } } }), reused: true };
    }
  }

  async function processDocument(empresa, document) {
    const content = inflateDocument(document);
    const digest = hash(content);
    const identifier = document.nsu ?? digest;
    const unique = { empresaId_identificador: { empresaId: empresa.id, identificador: identifier } };
    const previous = await prisma.documentoDistribuido.findUnique({ where: unique });
    if (previous) {
      if (previous.hash !== digest) throw new AppError(409, 'NSU_CONTEUDO_DIVERGENTE', 'Mesmo NSU retornou conteúdo diferente; intervenção necessária.');
      await storage.read(previous.caminho, previous.hash);
      return { xml: 0, errors: previous.mensagemErro ? 1 : 0 };
    }
    // Archive all document types, including unsupported XML, independently from the NF-e directory.
    const archive = `.distribuicao/${empresa.cnpj}/documentos/${identifier}.xml`;
    await storage.save(archive, content);
    let inspection;
    try { inspection = await inspectDocument(content.toString('utf8'), document.schema, empresa); }
    catch (error) {
      await prisma.documentoDistribuido.create({ data: { empresaId: empresa.id, identificador: identifier, nsu: document.nsu, schema: String(document.schema).slice(0, 100), tipo: 'INVALIDO', caminho: archive, hash: digest, mensagemErro: safeError(error) } });
      return { xml: 0, errors: 1 };
    }
    let xmlCount = 0;
    let errors = 0;
    if (inspection.nota) {
      const where = { empresaId_chaveAcesso: { empresaId: empresa.id, chaveAcesso: inspection.chave } };
      let nota = await prisma.notaFiscal.findUnique({ where });
      const metadata = { ...inspection.nota, nsu: document.nsu ?? nota?.nsu };
      if (nota?.statusDocumento === 'CANCELADA') metadata.statusDocumento = 'CANCELADA';
      if (inspection.tipo === 'RESUMO') {
        if (!nota?.caminhoXml) nota = await prisma.notaFiscal.upsert({ where, create: { ...metadata, empresaId: empresa.id }, update: metadata });
        else if (metadata.statusDocumento === 'CANCELADA') await prisma.notaFiscal.update({ where: { id: nota.id }, data: { statusDocumento: 'CANCELADA', caminhoDanfe: null, statusImportacao: 'XML_DISPONIVEL' } });
      } else {
        if (nota?.hashXml && nota.hashXml !== digest) throw new AppError(409, 'XML_DIVERGENTE', 'XML recebido diverge do original já armazenado para esta chave.');
        await storage.ensureNoteDirectories(empresa, metadata);
        let target = nota?.caminhoXml ?? notePaths(empresa, metadata).xml;
        const collision = await prisma.notaFiscal.findFirst({ where: { caminhoXml: target, chaveAcesso: { not: inspection.chave } } });
        if (collision) target = notePaths(empresa, metadata, inspection.chave).xml;
        try { await storage.save(target, content); }
        catch (error) {
          if (error.code !== 'COLISAO_ARQUIVO' || nota?.caminhoXml) throw error;
          target = notePaths(empresa, metadata, inspection.chave).xml;
          await storage.save(target, content);
        }
        xmlCount = nota?.caminhoXml ? 0 : 1;
        nota = await prisma.notaFiscal.upsert({ where, create: { ...metadata, empresaId: empresa.id, caminhoXml: target, hashXml: digest, statusImportacao: 'XML_DISPONIVEL' }, update: { ...metadata, caminhoXml: target, hashXml: digest } });
        // An event may arrive before the XML. Preserve cancellation regardless of document order.
        const cancelled = await prisma.documentoDistribuido.findFirst({ where: { empresaId: empresa.id, chaveAcesso: inspection.chave, tipo: 'CANCELAMENTO' } });
        if (cancelled && nota.statusDocumento !== 'CANCELADA') nota = await prisma.notaFiscal.update({ where: { id: nota.id }, data: { statusDocumento: 'CANCELADA' } });
        try { await danfe.generateUnlocked(empresa, nota); } catch { errors++; }
      }
    }
    if (inspection.cancelamento) {
      await prisma.notaFiscal.updateMany({ where: { empresaId: empresa.id, chaveAcesso: inspection.chave }, data: { statusDocumento: 'CANCELADA', caminhoDanfe: null } });
      await prisma.notaFiscal.updateMany({ where: { empresaId: empresa.id, chaveAcesso: inspection.chave, caminhoXml: { not: null } }, data: { statusImportacao: 'XML_DISPONIVEL' } });
    }
    if (inspection.tipo === 'NAO_SUPORTADO') errors++;
    await prisma.documentoDistribuido.create({ data: { empresaId: empresa.id, identificador: identifier, nsu: document.nsu, schema: document.schema, tipo: inspection.cancelamento ? 'CANCELAMENTO' : inspection.tipo, chaveAcesso: inspection.chave, caminho: archive, hash: digest, mensagemErro: inspection.tipo === 'NAO_SUPORTADO' ? 'Schema não suportado; original arquivado para reprocessamento.' : null } });
    return { xml: xmlCount, errors };
  }

  async function execute(execution) {
    return withCompanyLock(execution.empresaId, async assertLock => {
      const current = await prisma.historicoSincronizacao.findUnique({ where: { id: execution.id } });
      if (!current || !active.includes(current.status)) return;
      const empresa = await prisma.empresa.findUnique({ where: { id: execution.empresaId } });
      await prisma.historicoSincronizacao.update({ where: { id: execution.id }, data: { status: 'EXECUTANDO' } });
      logger.info({ executionId: execution.id, empresaId: empresa.id }, 'Sincronização iniciada/retomada');
      try {
        if (!empresa.ativa || empresa.ambiente !== config.SEFAZ_AMBIENTE) throw new AppError(409, 'EMPRESA_INATIVA', 'Consulta da empresa desativada ou de outro ambiente fiscal.');
        for (let batch = 0; batch < config.SYNC_MAX_BATCHES; batch++) {
          await assertLock();
          let control = await prisma.controleDistribuicao.findUnique({ where: { empresaId: empresa.id } });
          if (control.status === 'RECONCILIAR') throw new AppError(409, 'NSU_RECONCILIACAO', 'NSU divergente; reconciliação necessária.');
          if (!control.respostaPendente && control.proximaConsulta > now()) {
            await prisma.historicoSincronizacao.update({ where: { id: execution.id }, data: { status: 'ADIADA', dataFim: now() } }); return;
          }
          let soap;
          if (control.respostaPendente) soap = await storage.read(control.respostaPendente, control.hashResposta);
          else {
            const certificate = await certificateLoader(empresa);
            await assertLock();
            // Before the network call, persist a conservative cooldown for uncertain crash/timeout outcomes.
            await prisma.controleDistribuicao.update({ where: { empresaId: empresa.id }, data: { ultimaConsulta: now(), proximaConsulta: new Date(+now() + HOUR), status: 'CONSULTANDO' } });
            soap = await transport(empresa, control.ultimoNsu, certificate, config.SEFAZ_TIMEOUT_MS);
            await assertLock();
            const responsePath = `.distribuicao/${empresa.cnpj}/respostas/${randomUUID()}.xml`;
            const hashResposta = await storage.save(responsePath, soap);
            control = await prisma.controleDistribuicao.update({ where: { empresaId: empresa.id }, data: { respostaPendente: responsePath, hashResposta } });
          }
          const response = parseResponse(soap.toString('utf8'), empresa.ambiente);
          await prisma.historicoSincronizacao.update({ where: { id: execution.id }, data: { cStat: response.cStat } });
          if (!['137', '138'].includes(response.cStat)) {
            const divergent = response.cStat === '656' && response.ultimoNsu && response.ultimoNsu !== control.ultimoNsu;
            await prisma.controleDistribuicao.update({ where: { empresaId: empresa.id }, data: { status: divergent ? 'RECONCILIAR' : 'ERRO', cStat: response.cStat, nsuInformadoSefaz: response.ultimoNsu, proximaConsulta: new Date(+now() + retryDelay(control.falhasSeguidas)), respostaPendente: null, hashResposta: null } });
            throw new AppError(502, `SEFAZ_${response.cStat}`, `SEFAZ retornou cStat ${response.cStat}.${divergent ? ' NSU divergente: reconciliação necessária, sem avanço automático.' : ' Consulte a tabela de retornos na documentação.'}`);
          }
          if (!response.ultimoNsu || !response.maiorNsu || response.ultimoNsu < control.ultimoNsu || response.ultimoNsu > response.maiorNsu || (response.cStat === '138' && response.ultimoNsu === control.ultimoNsu)) throw new AppError(502, 'NSU_INVALIDO', 'Resposta sem progresso consistente de NSU.');
          // Keep the server's upper bound even if document processing fails; the local cursor stays unchanged.
          await prisma.controleDistribuicao.update({ where: { empresaId: empresa.id }, data: { maiorNsu: response.maiorNsu, cStat: response.cStat } });
          let xmls = 0, errors = 0, last = control.ultimoNsu;
          for (const document of response.documents) {
            if (document.nsu && (document.nsu <= last || document.nsu > response.ultimoNsu)) throw new AppError(502, 'NSU_ORDEM', 'NSUs fora da ordem esperada.');
            if (document.nsu) last = document.nsu;
            const result = await processDocument(empresa, document);
            xmls += result.xml; errors += result.errors;
          }
          const exhausted = response.cStat === '137' || response.ultimoNsu === response.maiorNsu;
          await assertLock();
          await prisma.$transaction([
            prisma.controleDistribuicao.update({ where: { empresaId: empresa.id }, data: { ultimoNsu: response.ultimoNsu, maiorNsu: response.maiorNsu, status: exhausted ? 'AGUARDANDO' : 'PRONTO', cStat: response.cStat, falhasSeguidas: 0, mensagemErro: null, respostaPendente: null, hashResposta: null, proximaConsulta: new Date(+now() + (exhausted ? HOUR : 1000)) } }),
            prisma.historicoSincronizacao.update({ where: { id: execution.id }, data: { cStat: response.cStat, quantidadeDocumentosEncontrados: { increment: response.documents.length }, quantidadeXmlsArmazenados: { increment: xmls }, quantidadeErros: { increment: errors } } }),
          ]);
          if (exhausted) break;
          await new Promise(resolve => setTimeout(resolve, 1100));
        }
        const updated = await prisma.historicoSincronizacao.findUnique({ where: { id: execution.id } });
        await prisma.$transaction([
          prisma.historicoSincronizacao.update({ where: { id: execution.id }, data: { status: updated.quantidadeErros ? 'COM_ERROS' : 'CONCLUIDA', dataFim: now() } }),
          prisma.empresa.update({ where: { id: empresa.id }, data: { ultimaSincronizacao: now() } }),
        ]);
        logger.info({ executionId: execution.id }, 'Sincronização concluída');
      } catch (error) {
        await assertLock();
        const control = await prisma.controleDistribuicao.findUnique({ where: { empresaId: empresa.id } });
        await prisma.$transaction([
          prisma.controleDistribuicao.update({ where: { empresaId: empresa.id }, data: { status: control.status === 'RECONCILIAR' ? 'RECONCILIAR' : 'ERRO', mensagemErro: safeError(error), falhasSeguidas: { increment: 1 }, proximaConsulta: new Date(Math.max(+(control.proximaConsulta ?? 0), +now() + retryDelay(control.falhasSeguidas))) } }),
          prisma.historicoSincronizacao.update({ where: { id: execution.id }, data: { status: 'FALHOU', dataFim: now(), mensagemErro: safeError(error), quantidadeErros: { increment: 1 } } }),
        ]);
        logger.error({ executionId: execution.id, code: error instanceof AppError ? error.code : 'INTERNO' }, 'Sincronização falhou');
      }
    });
  }
  return { request, execute, processDocument };
}
