import { gerarPDF } from '@alexssmusica/node-pdf-nfe';
import { inspectDocument } from './xmlService.js';
import { AppError, safeError } from '../utils/errors.js';

export async function generatePdf(xml, empresa, cancelada = false) {
  const inspection = await inspectDocument(xml, 'procNFe_v4.00.xsd', empresa);
  const n = inspection.parsed.nfeProc.NFe.infNFe;
  // Fail closed for layouts not yet validated visually with this renderer.
  const items = Array.isArray(n.det) ? n.det : [n.det];
  if (n.ide.tpImp !== '1' || n.total.IBSCBSTot || n.total.ISTot || items.some(i => i.imposto?.IBSCBS || i.imposto?.IS) || /[A-Z]/.test(inspection.chave)) throw new AppError(422, 'DANFE_LEIAUTE_NAO_SUPORTADO', 'DANFE disponível apenas para NF-e 4.00 retrato, chave numérica e sem grupos IBS/CBS/IS. XML preservado.');
  try {
    const stream = await gerarPDF(xml, { cancelada });
    const chunks = []; let size = 0;
    for await (const chunk of stream) { size += chunk.length; if (size > 20 * 1024 * 1024) { stream.destroy(); throw new Error(); } chunks.push(chunk); }
    const pdf = Buffer.concat(chunks);
    if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error();
    return pdf;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(422, 'DANFE_GERACAO', 'Falha ao gerar o DANFE a partir deste XML. XML original preservado.');
  }
}

export function createDanfeService({ prisma, storage, withCompanyLock, renderer = generatePdf }) {
  async function generateUnlocked(empresa, nota, force = false) {
    if (!nota.caminhoXml) throw new AppError(409, 'XML_INDISPONIVEL', 'XML completo ainda indisponível; resumo não permite gerar DANFE.');
    if (nota.caminhoDanfe && !force) return nota;
    try {
      const xml = await storage.readNote(empresa, nota.caminhoXml, 'xml', nota.hashXml);
      const pdf = await renderer(xml.toString('utf8'), empresa, nota.statusDocumento === 'CANCELADA');
      const target = nota.caminhoXml.replace('/xml/', '/pdf/').replace(/\.xml$/, '.pdf');
      const hashDanfe = await storage.save(target, pdf, nota.hashDanfe);
      return await prisma.notaFiscal.update({ where: { id: nota.id }, data: { caminhoDanfe: target, hashDanfe, statusImportacao: 'DANFE_DISPONIVEL', mensagemErro: null } });
    } catch (error) {
      await prisma.notaFiscal.update({ where: { id: nota.id }, data: { statusImportacao: 'ERRO_DANFE', mensagemErro: safeError(error) } });
      throw error;
    }
  }
  async function generate(empresa, chave, force = false) {
    const result = await withCompanyLock(empresa.id, async () => {
      const nota = await prisma.notaFiscal.findUnique({ where: { empresaId_chaveAcesso: { empresaId: empresa.id, chaveAcesso: chave } } });
      if (!nota) throw new AppError(404, 'NOTA_NAO_ENCONTRADA', 'Nota fiscal não encontrada.');
      return generateUnlocked(empresa, nota, force);
    });
    if (!result.acquired) throw new AppError(409, 'EMPRESA_OCUPADA', 'Há processamento em andamento para esta empresa.');
    return result.value;
  }
  return { generate, generateUnlocked };
}
