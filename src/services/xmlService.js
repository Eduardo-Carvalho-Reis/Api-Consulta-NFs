import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { validateXML } from 'xmllint-wasm';
import { gunzipSync } from 'node:zlib';
import { AppError } from '../utils/errors.js';
import { chaveSchema, nsuSchema } from '../utils/validation.js';

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false, processEntities: false });
const namespace = 'http://www.portalfiscal.inf.br/nfe';
const schemaCache = new Map();
export function parseXml(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 5 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new AppError(422, 'XML_INVALIDO', 'XML inválido, excessivo ou com entidades não permitidas.');
  return parser.parse(xml);
}
export async function validateSchema(xml, name, group = 'nfe') {
  parseXml(xml);
  const directory = group === 'nfe' ? 'nfe/PL_010f_v1.04' : group === 'eventos' ? 'eventos/PL_Evento' : 'distribuicao/PL_NFeDistDFe_104';
  if (!schemaCache.has(directory)) {
    const dir = fileURLToPath(new URL(`../../schemas/${directory}/`, import.meta.url));
    const files = await fs.readdir(dir);
    const loaded = await Promise.all(files.filter(f => f.endsWith('.xsd')).map(async fileName => ({ fileName, contents: await fs.readFile(`${dir}/${fileName}`, 'utf8') })));
    if (!loaded.some(f => f.fileName === 'xmldsig-core-schema_v1.01.xsd')) loaded.push({ fileName: 'xmldsig-core-schema_v1.01.xsd', contents: await fs.readFile(new URL('../../schemas/nfe/PL_010f_v1.04/xmldsig-core-schema_v1.01.xsd', import.meta.url), 'utf8') });
    schemaCache.set(directory, loaded);
  }
  const files = schemaCache.get(directory);
  const main = files.find(f => f.fileName === name);
  if (!main) throw new AppError(422, 'SCHEMA_NAO_SUPORTADO', 'Schema fiscal ainda não suportado.');
  const result = await validateXML({ xml: [{ fileName: 'documento.xml', contents: xml }], schema: [main], preload: files.filter(f => f !== main), maxMemoryPages: 1024 });
  if (!result.valid) throw new AppError(422, 'XML_SCHEMA_INVALIDO', 'XML incompatível com o schema fiscal suportado.');
}
export function inflateDocument(doc) {
  const encoded = String(doc['#text'] ?? '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0 || encoded.length > 4 * 1024 * 1024) throw new AppError(422, 'DOCZIP_INVALIDO', 'Documento compactado inválido.');
  try { return gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 5 * 1024 * 1024 }); }
  catch { throw new AppError(422, 'DOCZIP_INVALIDO', 'Falha ao descompactar documento fiscal.'); }
}
export function parseResponse(soap, ambiente) {
  const parsed = parseXml(soap);
  const body = parsed.Envelope?.Body;
  if (body?.Fault) throw new AppError(502, 'SOAP_FAULT', 'O serviço da SEFAZ retornou uma falha SOAP.');
  let result = body?.nfeDistDFeInteresseResponse?.nfeDistDFeInteresseResult;
  if (typeof result === 'string') result = parseXml(result);
  const ret = result?.retDistDFeInt;
  if (!ret || ret.tpAmb !== ambiente || !/^\d{3}$/.test(ret.cStat) || ret['@_versao'] !== '1.01') throw new AppError(502, 'RESPOSTA_INVALIDA', 'Resposta inesperada da SEFAZ.');
  const normalizeNsu = s => { if (s == null) return null; return nsuSchema.parse(String(s).padStart(15, '0')); };
  const docs = ret.loteDistDFeInt?.docZip;
  const documents = docs ? (Array.isArray(docs) ? docs : [docs]) : [];
  if (documents.length > 50 || (ret.cStat === '138' && !documents.length) || (ret.cStat !== '138' && documents.length)) throw new AppError(502, 'LOTE_INVALIDO', 'Lote incompatível com o retorno da SEFAZ.');
  return { cStat: ret.cStat, ultimoNsu: normalizeNsu(ret.ultNSU), maiorNsu: normalizeNsu(ret.maxNSU), documents: documents.map(doc => ({ ...doc, nsu: normalizeNsu(doc['@_NSU']), schema: doc['@_schema'] })) };
}
const state = sit => ({ '1': 'AUTORIZADA', '2': 'DENEGADA', '3': 'CANCELADA' }[sit] ?? 'DESCONHECIDA');
export async function inspectDocument(xml, schema, empresa) {
  const parsed = parseXml(xml);
  if (schema === 'resNFe_v1.01.xsd' && parsed.resNFe) {
    await validateSchema(xml, schema, 'distribuicao');
    const n = parsed.resNFe;
    const chave = chaveSchema.parse(n.chNFe);
    return { tipo: 'RESUMO', chave, nota: { chaveAcesso: chave, cnpjEmitente: n.CNPJ ?? null, cpfEmitente: n.CPF ?? null, cnpjDestinatario: empresa.cnpj, numero: String(Number(chave.slice(25, 34))), serie: String(Number(chave.slice(22, 25))), dataEmissao: new Date(n.dhEmi), emissaoOriginal: n.dhEmi, valorTotal: n.vNF, statusDocumento: state(n.cSitNFe) } };
  }
  if (schema === 'procNFe_v4.00.xsd' && parsed.nfeProc) {
    await validateSchema(xml, schema);
    const proc = parsed.nfeProc;
    const n = proc.NFe?.infNFe;
    const p = proc.protNFe?.infProt;
    const chave = chaveSchema.parse(n?.['@_Id']?.replace(/^NFe/, ''));
    if (n['@_versao'] !== '4.00' || n.ide.mod !== '55' || p?.chNFe !== chave || n.dest?.CNPJ !== empresa.cnpj || n.ide.tpAmb !== empresa.ambiente || p.tpAmb !== empresa.ambiente || !['100', '150'].includes(p.cStat) || !p.nProt || !proc.NFe.Signature) throw new AppError(422, 'NFE_INCONSISTENTE', 'NF-e sem autorização, de outro destinatário/ambiente ou com dados inconsistentes.');
    const issuer = n.emit.CNPJ ?? n.emit.CPF?.padStart(14, '0');
    const emissionPeriod = n.ide.dhEmi.slice(2, 4) + n.ide.dhEmi.slice(5, 7);
    if (chave.slice(0, 2) !== n.ide.cUF || chave.slice(2, 6) !== emissionPeriod ||
        chave.slice(6, 20) !== issuer || chave.slice(20, 22) !== n.ide.mod ||
        Number(chave.slice(25,34)) !== Number(n.ide.nNF) || Number(chave.slice(22,25)) !== Number(n.ide.serie) ||
        chave[34] !== n.ide.tpEmis || chave.slice(35,43) !== n.ide.cNF || chave[43] !== n.ide.cDV) {
      throw new AppError(422, 'CHAVE_DIVERGENTE', 'Chave de acesso incompatível com os dados da NF-e.');
    }
    return { tipo: 'NFE', chave, parsed, nota: { chaveAcesso: chave, cnpjEmitente: n.emit.CNPJ ?? null, cpfEmitente: n.emit.CPF ?? null, cnpjDestinatario: n.dest.CNPJ, numero: n.ide.nNF, serie: n.ide.serie, dataEmissao: new Date(n.ide.dhEmi), emissaoOriginal: n.ide.dhEmi, valorTotal: n.total.ICMSTot.vNF, statusDocumento: 'AUTORIZADA' } };
  }
  if (schema === 'resEvento_v1.01.xsd' && parsed.resEvento) {
    await validateSchema(xml, schema, 'distribuicao');
    return { tipo: 'RESUMO_EVENTO', chave: chaveSchema.parse(parsed.resEvento.chNFe), cancelamento: parsed.resEvento.tpEvento === '110111' };
  }
  if (schema === 'procEventoNFe_v1.00.xsd' && parsed.procEventoNFe) {
    await validateSchema(xml, schema, 'eventos');
    const proc = parsed.procEventoNFe;
    const event = proc.evento?.infEvento;
    const ret = proc.retEvento?.infEvento;
    if (!event || !ret || event.chNFe !== ret.chNFe || event.tpEvento !== ret.tpEvento || event.tpAmb !== empresa.ambiente || ret.tpAmb !== empresa.ambiente || !['135','136','155'].includes(ret.cStat)) throw new AppError(422, 'EVENTO_INVALIDO', 'Evento fiscal inconsistente.');
    return { tipo: 'EVENTO', chave: chaveSchema.parse(event.chNFe), cancelamento: event.tpEvento === '110111' && ['135','155'].includes(ret.cStat) };
  }
  if (!xml.includes(namespace)) throw new AppError(422, 'XML_NAMESPACE', 'Namespace fiscal ausente.');
  return { tipo: 'NAO_SUPORTADO', chave: null };
}
