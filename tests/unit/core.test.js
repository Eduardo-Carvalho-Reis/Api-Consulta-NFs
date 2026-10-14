import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StorageService, notePaths, hash, normalizeName, assertNotePath } from '../../src/services/storageService.js';
import { parseXml, parseResponse, inflateDocument, inspectDocument, validateSchema } from '../../src/services/xmlService.js';
import { validCnpj, listSchema, chaveSchema } from '../../src/utils/validation.js';
import { buildRequest } from '../../src/services/sefazService.js';
import { loadCertificate } from '../../src/services/certificateService.js';
import { retryDelay, HOUR } from '../../src/services/distribuicaoService.js';
import { nfeXml, resumoXml, empresa, response, chaveFor } from '../fixtures/fiscal.js';
import { generatePdf } from '../../src/services/danfeService.js';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

test('entradas: CNPJ, paginação, filtros e período', () => {
  assert.ok(validCnpj(empresa.cnpj));
  assert.equal(validCnpj('00000000000000'), false);
  assert.equal(validCnpj('99999999000192'), false);
  assert.equal(listSchema.parse({}).limite, 20);
  assert.ok(chaveSchema.safeParse(chaveFor()).success);
  assert.equal(chaveSchema.safeParse(chaveFor().slice(0, 43) + ((Number(chaveFor().at(-1)) + 1) % 10)).success, false);
  for (const q of [{pagina:'0'}, {limite:'101'}, {inicio:'2026-02-30'}, {inicio:'2026-10-02', fim:'2026-10-01'}, {emitente:'../../secret'}, {numero:'<xml>'}, {ordem:'drop table'}, {desconhecido:1}]) assert.equal(listSchema.safeParse(q).success,false);
});
test('estrutura por emissão local, sem converter para mês UTC', () => {
  const paths = notePaths(empresa, { numero:'1234', emissaoOriginal:'2026-10-31T23:59:00-03:00' });
  assert.equal(paths.xml, 'Empresa Teste/2026/10- Outubro/xml/Empresa Teste - NF 1234.xml');
  assert.equal(paths.pdf, 'Empresa Teste/2026/10- Outubro/pdf/Empresa Teste - NF 1234.pdf');
  assert.equal(normalizeName('../../Empresa:<ABC>'), 'Empresa ABC');
  assert.match(normalizeName('CON'), /^Empresa/);
  assert.equal(normalizeName('A'.repeat(79) + '.mais'), 'A'.repeat(79));
});

test('arquivo deve pertencer à pasta e ao tipo da empresa autorizada', () => {
  const paths = notePaths(empresa, { numero: '1234', emissaoOriginal: '2026-10-01T00:00:00-03:00' });
  assert.doesNotThrow(() => assertNotePath(empresa, paths.xml, 'xml'));
  for (const relative of [paths.pdf, paths.xml.replace('Empresa Teste/', 'Outra Empresa/'), paths.xml.replace('10- Outubro', '10- Novembro'), '.distribuicao/segredo.xml']) {
    assert.throws(() => assertNotePath(empresa, relative, 'xml'), { code: 'ARQUIVO_NAO_AUTORIZADO' });
  }
});

test('meses com XML completo criam xml/pdf e nenhum outro mês', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nfe-month-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = new StorageService(root); await storage.init();
  await storage.ensureNoteDirectories(empresa, { numero: '1234', emissaoOriginal: '2026-10-31T23:59:00-03:00' });
  assert.deepEqual((await fs.readdir(path.join(root, empresa.pasta, '2026', '10- Outubro'))).sort(), ['pdf', 'xml']);
  assert.deepEqual(await fs.readdir(path.join(root, empresa.pasta, '2026')), ['10- Outubro']);
});

test('gravações concorrentes não sobrescrevem conteúdo e removem temporários', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nfe-write-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = new StorageService(root); await storage.init();
  const results = await Promise.allSettled(['primeiro', 'segundo'].map(data => storage.save('empresa/nota.xml', Buffer.from(data))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'COLISAO_ARQUIVO');
  assert.deepEqual(await fs.readdir(path.join(root, 'empresa')), ['nota.xml']);
  const content = await storage.read('empresa/nota.xml');
  assert.ok(['primeiro', 'segundo'].includes(content.toString()));
  await assert.rejects(storage.save('empresa/erro.xml', {}));
  assert.deepEqual(await fs.readdir(path.join(root, 'empresa')), ['nota.xml']);
});
test('armazenamento: isolamento, deduplicação, integridade e travessia', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nfe-unit-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  const storage = new StorageService(root); await storage.init();
  const target = notePaths(empresa, {numero:'1234',emissaoOriginal:'2026-10-01T12:00:00-03:00'}).xml;
  await storage.save(target, Buffer.from('original'));
  await storage.save(target, Buffer.from('original'));
  assert.equal((await storage.read(target,hash('original'))).toString(),'original');
  await assert.rejects(storage.save(target,Buffer.from('diferente')), {code:'COLISAO_ARQUIVO'});
  await assert.rejects(storage.read(target,hash('outro')), {code:'INTEGRIDADE'});
  for(const unsafe of ['../secret','/absolute','C:/Windows','abc/../../secret','abc\\secret']) await assert.rejects(storage.read(unsafe),{code:'CAMINHO_INVALIDO'});
  assert.deepEqual(await fs.readdir(path.join(root,empresa.pasta,'2026')),['10- Outubro']);
});
test('SOAP real: namespace, versão 1.01 e schema oficial', async () => {
  const xml=buildRequest(empresa,'000000000000123');
  assert.match(xml,/<ultNSU>000000000000123<\/ultNSU>/);
  await validateSchema(xml,'distDFeInt_v1.01.xsd','distribuicao');
  assert.throws(()=>buildRequest({...empresa,cnpj:'"<hack>'},'0'));
});
test('SOAP: 138, 137, 656, gzip e NSU facultativo', () => {
  const ret=parseResponse(response().toString(),'2');
  assert.equal(ret.ultimoNsu,'000000000000001');
  assert.equal(inflateDocument(ret.documents[0]).toString(),nfeXml());
  assert.equal(parseResponse(response({cStat:'137',docs:[]}).toString(),'2').documents.length,0);
  assert.equal(parseResponse(response({cStat:'656',docs:[]}).toString(),'2').cStat,'656');
  assert.equal(parseResponse(response({docs:[{nsu:null,schema:'procNFe_v4.00.xsd',xml:nfeXml()}]}).toString(),'2').documents[0].nsu,null);
  assert.throws(()=>parseResponse(response().toString(),'1'),{code:'RESPOSTA_INVALIDA'});
  assert.throws(()=>inflateDocument({'#text':'AA=='}),{code:'DOCZIP_INVALIDO'});
});
test('XML: XSD, resumo, nota completa e dados inconsistentes', async () => {
  assert.equal((await inspectDocument(nfeXml(),'procNFe_v4.00.xsd',empresa)).tipo,'NFE');
  assert.equal((await inspectDocument(resumoXml(),'resNFe_v1.01.xsd',empresa)).tipo,'RESUMO');
  await assert.rejects(inspectDocument(nfeXml().replace('<vNF>10.00</vNF>','<vNF>abc</vNF>'),'procNFe_v4.00.xsd',empresa),{code:'XML_SCHEMA_INVALIDO'});
  await assert.rejects(inspectDocument(nfeXml({destinatario:'11111111000191'}),'procNFe_v4.00.xsd',empresa),{code:'NFE_INCONSISTENTE'});
  await assert.rejects(inspectDocument(nfeXml({ date: '2026-11-01T00:30:00-03:00' }), 'procNFe_v4.00.xsd', empresa), { code: 'CHAVE_DIVERGENTE' });
  assert.throws(()=>parseXml('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>'),{code:'XML_INVALIDO'});
  assert.throws(()=>parseXml('<a><b></a>'),{code:'XML_INVALIDO'});
});
test('DANFE real: PDF legível, chave, total, homologação e várias páginas', async () => {
  const pdf = await generatePdf(nfeXml(),empresa);
  const document = await getDocument({data:new Uint8Array(pdf)}).promise;
  const text=(await(await document.getPage(1)).getTextContent()).items.map(i=>i.str).join(' ');
  assert.match(text,/DANFE/); assert.match(text,/1234|1\.234/); assert.match(text,/10,00/);
  assert.match(text,/SEM VALOR FISCAL|HOMOLOGA/i);
  assert.ok(text.replace(/\s/g,'').includes(chaveFor()));
  const many=await getDocument({data:new Uint8Array(await generatePdf(nfeXml({items:70}),empresa))}).promise;
  assert.ok(many.numPages>1);
  await assert.rejects(generatePdf(resumoXml(),empresa));
});
test('certificado ausente e inválido, backoff conservador', async t => {
  const company={certificadoPathEnv:'CERT_PATH',certificadoSenhaEnv:'CERT_PASS'};
  await assert.rejects(loadCertificate(company,{}),{code:'CERTIFICADO_AUSENTE'});
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nfe-cert-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const filename=path.join(root,'invalid.pfx'); await fs.writeFile(filename,'invalid');
  await assert.rejects(loadCertificate(company,{CERT_PATH:filename,CERT_PASS:'test'}),{code:'CERTIFICADO_INVALIDO'});
  assert.equal(retryDelay(0),HOUR); assert.equal(retryDelay(1),2*HOUR); assert.equal(retryDelay(100),24*HOUR);
});
