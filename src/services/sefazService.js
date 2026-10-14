import https from 'node:https';
import { AppError } from '../utils/errors.js';
import { cnpjSchema, nsuSchema, ufSchema } from '../utils/validation.js';
import { validateSchema } from './xmlService.js';

const endpoints = {
  '1': 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
  '2': 'https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
};
export function buildRequest(empresa, nsu) {
  cnpjSchema.parse(empresa.cnpj); ufSchema.parse(empresa.ufAutor); nsuSchema.parse(nsu);
  if (!endpoints[empresa.ambiente]) throw new AppError(422, 'AMBIENTE_INVALIDO', 'Ambiente fiscal inválido.');
  return `<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>${empresa.ambiente}</tpAmb><cUFAutor>${empresa.ufAutor}</cUFAutor><CNPJ>${empresa.cnpj}</CNPJ><distNSU><ultNSU>${nsu}</ultNSU></distNSU></distDFeInt>`;
}
export async function consultarSefaz(empresa, nsu, certificate, timeout = 30000) {
  const payload = buildRequest(empresa, nsu);
  await validateSchema(payload, 'distDFeInt_v1.01.xsd', 'distribuicao');
  const soap = `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDadosMsg>${payload}</nfeDadosMsg></nfeDistDFeInteresse></soap:Body></soap:Envelope>`;
  return new Promise((resolve, reject) => {
    const req = https.request(endpoints[empresa.ambiente], {
      method: 'POST', ...certificate, minVersion: 'TLSv1.2', rejectUnauthorized: true, agent: false,
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse"', 'Content-Length': Buffer.byteLength(soap) },
    }, res => {
      const chunks = []; let length = 0;
      res.on('data', chunk => { length += chunk.length; if (length > 5 * 1024 * 1024) req.destroy(new Error('response too large')); else chunks.push(chunk); });
      res.on('error', () => reject(new AppError(502, 'SEFAZ_COMUNICACAO', 'Conexão com a SEFAZ interrompida.')));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new AppError(502, 'SEFAZ_HTTP', `Serviço SEFAZ indisponível (HTTP ${res.statusCode}).`));
        resolve(Buffer.concat(chunks));
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeout);
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => reject(new AppError(502, 'SEFAZ_COMUNICACAO', 'Falha de comunicação segura ou tempo excedido na SEFAZ.')));
    req.end(soap);
  });
}
