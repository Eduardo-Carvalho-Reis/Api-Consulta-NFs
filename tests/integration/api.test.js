import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import request from 'supertest';
import { SignJWT } from 'jose';
import { createDatabase } from '../../src/config/database.js';
import { createLogger } from '../../src/config/logger.js';
import { loadConfig } from '../../src/config/env.js';
import { StorageService } from '../../src/services/storageService.js';
import { createDanfeService } from '../../src/services/danfeService.js';
import { createDistribuicaoService, HOUR } from '../../src/services/distribuicaoService.js';
import { cadastrarEmpresa } from '../../src/repositories/empresaRepository.js';
import { createApp } from '../../src/app.js';
import { AppError } from '../../src/utils/errors.js';
import { nfeXml, resumoXml, eventoXml, response, chaveFor, cnpj, emitente } from '../fixtures/fiscal.js';

const config = loadConfig({ ...process.env, STORAGE_DIR:process.env.TEST_STORAGE, LOG_LEVEL:'silent', SYNC_MAX_BATCHES:'1' });
const db = createDatabase(config.DATABASE_URL);
const { prisma } = db;
const storage = new StorageService(config.STORAGE_DIR);
const logger = createLogger('silent');
const base = {...db,storage,logger,config};
let counter=10;
function syntheticCnpj() {
  let base = `99999999${String(counter++).padStart(4,'0')}`;
  for(const len of [12,13]) { let weight=len-7,sum=0; for(const c of base) {sum+=Number(c)*weight;if(--weight===1)weight=9;} base+=(sum%11<2?0:11-sum%11); }
  return base;
}
async function company({name='Empresa Teste',id=syntheticCnpj()}={}) {
  return cadastrarEmpresa(prisma,{nome:name,cnpj:id,ufAutor:'35',certificadoPathEnv:'CERT_PATH',certificadoSenhaEnv:'CERT_PASS',ativa:true},'2');
}
function services(transport, additions={}) {
  const s={...base,...additions};
  s.danfe=createDanfeService(s);
  s.distribuicao=createDistribuicaoService({...s,transport,certificateLoader:async()=>({}),...additions});
  return s;
}
async function synchronize(s, e) {
  const {execution}=await s.distribuicao.request(e);await s.distribuicao.execute(execution);
  return prisma.historicoSincronizacao.findUnique({where:{id:execution.id}});
}
async function token(e,scopes=['notas:ler','notas:download','notas:sincronizar','notas:gerar','empresas:ler'],options={}) {
  return new SignJWT({cnpjs:[e.cnpj],scopes}).setProtectedHeader({alg:'HS256'}).setSubject('teste').setIssuer(config.JWT_ISSUER).setAudience(config.JWT_AUDIENCE).setIssuedAt().setExpirationTime(options.expired?'0s':'1h').sign(new TextEncoder().encode(config.JWT_SECRET));
}
before(async()=>{await prisma.$connect();await storage.init();});
after(()=>db.close());

test('cadastro: CNPJ único e nomes de pasta sem colisão por maiúsculas',async()=>{
  const a=await company({name:'Empresa ABC'}), b=await company({name:'EMPRESA ABC'});
  assert.equal(a.pasta,'Empresa ABC');assert.ok(b.pasta.endsWith(b.cnpj));
  await assert.rejects(company({id:a.cnpj}),{code:'EMPRESA_EXISTENTE'});
});

test('resumo → XML: progresso NSU, arquivos e DANFE real',async()=>{
  const e=await company({id:cnpj});let calls=0;let time=Date.now();
  const s=services(async(_,nsu)=>{calls++;return calls===1?response({ultimo:'1',docs:[{xml:resumoXml(),nsu:'1',schema:'resNFe_v1.01.xsd'}]}):response({ultimo:'2',docs:[{xml:nfeXml(),nsu:'2',schema:'procNFe_v4.00.xsd'}]});},{now:()=>new Date(time)});
  const first=await synchronize(s,e);assert.equal(first.status,'CONCLUIDA');
  let nota=await prisma.notaFiscal.findFirst({where:{empresaId:e.id}});assert.equal(nota.statusImportacao,'RESUMO');assert.equal(nota.caminhoXml,null);
  await assert.rejects(s.distribuicao.request(e),{code:'SEFAZ_AGUARDAR'});time+=HOUR+1000;
  const second=await synchronize(s,e);assert.equal(second.quantidadeXmlsArmazenados,1);
  nota=await prisma.notaFiscal.findFirst({where:{empresaId:e.id}});
  assert.equal(nota.statusImportacao,'DANFE_DISPONIVEL');assert.equal(nota.nsu,'000000000000002');
  assert.match(nota.caminhoXml,/2026\/10- Outubro\/xml\/Empresa Teste - NF 1234.xml$/);
  assert.equal((await storage.read(nota.caminhoXml,nota.hashXml)).toString(),nfeXml());
  assert.equal((await storage.read(nota.caminhoDanfe,nota.hashDanfe)).subarray(0,5).toString(),'%PDF-');
  const control=await prisma.controleDistribuicao.findUnique({where:{empresaId:e.id}});assert.equal(control.ultimoNsu,'000000000000002');assert.equal(control.maiorNsu,control.ultimoNsu);
});

test('API: autenticação, autorização, filtros, downloads, histórico e status',async()=>{
  const e=await prisma.empresa.findUnique({where:{cnpj}});const s=services(async()=>{throw new Error('must not call SEFAZ');});const app=createApp(s);const jwt=await token(e);
  await request(app).get('/api/notas').expect(401);
  await request(app).get('/api/notas').set('Authorization','Bearer invalid').expect(401);
  await request(app).get('/api/notas').set('Authorization',`Bearer ${await token(e,[],{expired:true})}`).expect(401);
  await request(app).get('/api/notas').set('Authorization',`Bearer ${await token(e,[])}`).expect(403);
  const auth=req=>req.set('Authorization',`Bearer ${jwt}`);
  await auth(request(app).get('/api/notas')).set('X-Empresa-CNPJ',syntheticCnpj()).expect(403);
  for(const q of ['?pagina=0','?limite=999','?inicio=not-a-date','?chave=123','?numero=../../','?status=unknown']) await auth(request(app).get(`/api/notas${q}`)).expect(400);
  const list=await auth(request(app).get(`/api/notas?pagina=1&limite=1&emitente=${emitente}&numero=1234&inicio=2026-10-01&fim=2026-10-01&status=DANFE_DISPONIVEL`)).expect(200);
  assert.equal(list.body.paginacao.total,1);assert.equal(list.body.dados.length,1);assert.ok(!JSON.stringify(list.body).includes('caminhoXml'));
  const empty=await auth(request(app).get('/api/notas?pagina=2&limite=1')).expect(200);assert.equal(empty.body.dados.length,0);
  const item=await auth(request(app).get(`/api/notas/${chaveFor()}`)).expect(200);assert.equal(item.body.dados.xmlDisponivel,true);
  const xml=await auth(request(app).get(`/api/notas/${chaveFor()}/xml`)).expect(200).expect('Content-Type',/application\/xml/);assert.equal(xml.text,nfeXml());assert.match(xml.headers['content-disposition'],/attachment/);
  await auth(request(app).get(`/api/notas/${chaveFor()}/danfe`)).expect(200).expect('Content-Type',/application\/pdf/);
  const status=await auth(request(app).get('/api/notas/status')).expect(200);assert.equal(status.body.dados.controle.ultimoNsu,'000000000000002');assert.ok(!JSON.stringify(status.body).includes('hashResposta'));
  const history=await auth(request(app).get('/api/notas/sincronizacoes?limite=1&status=CONCLUIDA')).expect(200);assert.equal(history.body.paginacao.total,2);
  const executionId = history.body.dados[0].id;
  const execution = await auth(request(app).get(`/api/notas/sincronizacoes/${executionId}`)).expect(200);
  assert.equal(execution.body.dados.status, 'CONCLUIDA');
  await auth(request(app).get('/api/notas/sincronizacoes/id-invalido')).expect(400);
  await auth(request(app).post('/api/notas/sincronizar')).expect(429);
  await auth(request(app).post(`/api/notas/${chaveFor()}/danfe`)).expect(200);
  const other=await company();const otherJwt=await token(other);
  await request(app).get(`/api/notas/sincronizacoes/${executionId}`).set('Authorization',`Bearer ${otherJwt}`).expect(404);
  await request(app).get(`/api/notas/${chaveFor()}/xml`).set('Authorization',`Bearer ${otherJwt}`).expect(404);
  await request(app).get('/storage/notas-fiscais').expect(404);
});

test('solicitação HTTP retorna 202/Location sem antecipar resultado ou chamar SEFAZ', async () => {
  const e = await company();
  let calls = 0;
  const s = services(async () => { calls++; return response({ cStat: '137', ultimo: '0', docs: [] }); });
  const app = createApp(s), jwt = await token(e);
  const auth = req => req.set('Authorization', `Bearer ${jwt}`);
  const submitted = await auth(request(app).post('/api/notas/sincronizar')).expect(202);
  assert.equal(calls, 0);
  assert.equal(submitted.body.dados.status, 'PENDENTE');
  assert.equal(submitted.headers.location, `/api/notas/sincronizacoes/${submitted.body.dados.id}`);
  const reused = await auth(request(app).post('/api/notas/sincronizar')).expect(202);
  assert.equal(reused.body.dados.id, submitted.body.dados.id);
  assert.equal(reused.body.dados.reutilizada, true);
  const execution = await prisma.historicoSincronizacao.findUnique({ where: { id: submitted.body.dados.id } });
  await s.distribuicao.execute(execution);
  const completed = await auth(request(app).get(submitted.headers.location)).expect(200);
  assert.equal(completed.body.dados.quantidadeDocumentosEncontrados, 0);
  assert.equal(completed.body.dados.status, 'CONCLUIDA');
  assert.equal(calls, 1);
});

test('repetição de XML e mesmo número de emitentes diferentes não sobrescrevem',async()=>{
  const e=await company();
  const xml=nfeXml({destinatario:e.cnpj});const second=nfeXml({destinatario:e.cnpj,issuer:'77777777000191'});
  const s=services(async()=>response({ultimo:'3',docs:[{nsu:'1',schema:'procNFe_v4.00.xsd',xml},{nsu:'2',schema:'procNFe_v4.00.xsd',xml},{nsu:'3',schema:'procNFe_v4.00.xsd',xml:second}]}));
  const result=await synchronize(s,e);assert.equal(result.status,'CONCLUIDA');assert.equal(result.quantidadeXmlsArmazenados,2);
  const notes=await prisma.notaFiscal.findMany({where:{empresaId:e.id},orderBy:{dataRecebimento:'asc'}});assert.equal(notes.length,2);assert.notEqual(notes[0].caminhoXml,notes[1].caminhoXml);
  assert.match(notes[1].caminhoXml,new RegExp(chaveFor('1234','77777777000191')));
  assert.equal(await prisma.documentoDistribuido.count({where:{empresaId:e.id}}),3);
});

test('concorrência: fila e lock PostgreSQL entre instâncias',async()=>{
  const e=await company();let calls=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const s=services(async()=>{calls++;await gate;return response({cStat:'137',ultimo:'0',docs:[]});});
  const results=await Promise.all(Array.from({length:8},()=>s.distribuicao.request(e)));
  assert.equal(new Set(results.map(r=>r.execution.id)).size,1);
  const running=s.distribuicao.execute(results[0].execution);
  while(!calls) await new Promise(r=>setTimeout(r,10));
  const secondDb=createDatabase(config.DATABASE_URL);
  try { const lock=await secondDb.withCompanyLock(e.id,()=>assert.fail('lock acquired concurrently'));assert.equal(lock.acquired,false); }
  finally {await secondDb.close();release();await running;}
  assert.equal(calls,1);
});

test('resposta 656 preserva NSU local, persiste bloqueio e pede reconciliação',async()=>{
  const e=await company();const s=services(async()=>response({cStat:'656',ultimo:'50',maior:'60',docs:[]}));
  const result=await synchronize(s,e);assert.equal(result.status,'FALHOU');
  const control=await prisma.controleDistribuicao.findUnique({where:{empresaId:e.id}});assert.equal(control.ultimoNsu,'000000000000000');assert.equal(control.nsuInformadoSefaz,'000000000000050');assert.equal(control.status,'RECONCILIAR');assert.ok(+control.proximaConsulta>Date.now()+HOUR-1000);
  await assert.rejects(s.distribuicao.request(e),{code:'NSU_RECONCILIACAO'});
});

test('falha de transporte aplica espera progressiva persistente sem perder NSU',async()=>{
  const e=await company();let time=Date.now();let calls=0;
  const s=services(async()=>{calls++;throw new AppError(502,'SEFAZ_COMUNICACAO','Comunicação interrompida.');},{now:()=>new Date(time)});
  assert.equal((await synchronize(s,e)).status,'FALHOU');
  await assert.rejects(s.distribuicao.request(e),{code:'SEFAZ_AGUARDAR'});assert.equal(calls,1);
  time+=HOUR+1000;await synchronize(s,e);
  const control=await prisma.controleDistribuicao.findUnique({where:{empresaId:e.id}});assert.equal(control.ultimoNsu,'000000000000000');assert.equal(control.falhasSeguidas,2);assert.equal(+control.proximaConsulta,time+2*HOUR);
});

test('retomada após reinício processa lote persistido sem chamar SEFAZ',async()=>{
  const e=await company();const xml=nfeXml({destinatario:e.cnpj});const filename=`.distribuicao/${e.cnpj}/respostas/recuperacao.xml`;
  const digest=await storage.save(filename,response({docs:[{nsu:'1',schema:'procNFe_v4.00.xsd',xml}]}));
  await prisma.controleDistribuicao.update({where:{empresaId:e.id},data:{respostaPendente:filename,hashResposta:digest,proximaConsulta:new Date(Date.now()+HOUR)}});
  const execution=await prisma.historicoSincronizacao.create({data:{empresaId:e.id,status:'EXECUTANDO'}});
  const s=services(async()=>assert.fail('Network must not be called during replay'));
  await s.distribuicao.execute(execution);
  assert.equal((await prisma.historicoSincronizacao.findUnique({where:{id:execution.id}})).status,'CONCLUIDA');
  assert.equal((await prisma.controleDistribuicao.findUnique({where:{empresaId:e.id}})).ultimoNsu,'000000000000001');
});

test('falha de PDF mantém XML e permite geração posterior autenticada',async()=>{
  const e=await company();const xml=nfeXml({destinatario:e.cnpj});
  const s=services(async()=>response({docs:[{nsu:'1',schema:'procNFe_v4.00.xsd',xml}]}),{renderer:async()=>{throw new AppError(422,'DANFE_GERACAO','Falha de renderização de teste.');}});
  const result=await synchronize(s,e);assert.equal(result.status,'COM_ERROS');
  let nota=await prisma.notaFiscal.findFirst({where:{empresaId:e.id}});assert.equal(nota.statusImportacao,'ERRO_DANFE');assert.equal((await storage.read(nota.caminhoXml,nota.hashXml)).toString(),xml);
  const month = path.dirname(path.dirname(nota.caminhoXml));
  assert.deepEqual((await fs.readdir(path.join(storage.root, month))).sort(), ['pdf', 'xml']);
  const working=services(async()=>assert.fail());const app=createApp(working);const jwt=await token(e);
  await request(app).post(`/api/notas/${chaveFor()}/danfe`).set('Authorization',`Bearer ${jwt}`).expect(200);
  nota=await prisma.notaFiscal.findFirst({where:{empresaId:e.id}});assert.equal(nota.statusImportacao,'DANFE_DISPONIVEL');
});

test('download rejeita caminho de outra empresa mesmo se metadados forem inconsistentes', async () => {
  const source = await prisma.empresa.findUnique({ where: { cnpj } });
  const original = await prisma.notaFiscal.findFirst({ where: { empresaId: source.id } });
  const owner = await company({ name: 'Empresa isolada' });
  const s = services(async () => assert.fail('download não deve consultar SEFAZ'));
  const foreignPath = `${source.pasta}/2026/10- Outubro/xml/copia.xml`;
  await storage.save(foreignPath, await storage.read(original.caminhoXml, original.hashXml));
  await prisma.notaFiscal.create({ data: { empresaId: owner.id, chaveAcesso: original.chaveAcesso, caminhoXml: foreignPath, hashXml: original.hashXml } });
  const result = await request(createApp(s)).get(`/api/notas/${original.chaveAcesso}/xml`).set('Authorization', `Bearer ${await token(owner)}`).expect(403);
  assert.equal(result.body.erro.codigo, 'ARQUIVO_NAO_AUTORIZADO');
});

test('arquivos de empresas com mesmo nome ficam separados em meses de emissão locais', async () => {
  const a = await company({ name: 'Mesmo Nome' }), b = await company({ name: 'Mesmo Nome' });
  const s = services(async () => assert.fail('processamento local não deve consultar SEFAZ'));
  for (const e of [a, b]) {
    const xml = nfeXml({ destinatario: e.cnpj, date: '2026-10-31T23:59:00-03:00' });
    const document = (await import('../../src/services/xmlService.js')).parseResponse(response({ docs: [{ nsu: '1', schema: 'procNFe_v4.00.xsd', xml }] }).toString(), '2').documents[0];
    await db.withCompanyLock(e.id, async () => { await s.distribuicao.processDocument(e, document); await s.distribuicao.processDocument(e, document); });
    const nota = await prisma.notaFiscal.findFirst({ where: { empresaId: e.id } });
    assert.equal((await storage.readNote(e, nota.caminhoXml, 'xml', nota.hashXml)).toString(), xml);
    assert.equal(path.basename(nota.caminhoXml, '.xml'), path.basename(nota.caminhoDanfe, '.pdf'));
    assert.deepEqual(await fs.readdir(path.join(storage.root, e.pasta, '2026')), ['10- Outubro']);
    assert.equal(await prisma.notaFiscal.count({ where: { empresaId: e.id } }), 1);
    assert.equal(await prisma.documentoDistribuido.count({ where: { empresaId: e.id } }), 1);
  }
  assert.notEqual(a.pasta, b.pasta);
});

test('XML inválido e schema desconhecido são arquivados sem DANFE fictício',async()=>{
  const e=await company();const s=services(async()=>response({ultimo:'2',docs:[{nsu:'1',schema:'procNFe_v4.00.xsd',xml:'<invalid>'},{nsu:null,schema:'futuro_v9.00.xsd',xml:'<futuro xmlns="http://www.portalfiscal.inf.br/nfe"/>'}]}));
  const result=await synchronize(s,e);assert.equal(result.status,'COM_ERROS');assert.equal(result.quantidadeErros,2);
  assert.equal(await prisma.notaFiscal.count({where:{empresaId:e.id}}),0);
  const documents=await prisma.documentoDistribuido.findMany({where:{empresaId:e.id}});assert.equal(documents.length,2);assert.ok(documents.some(d=>d.nsu===null));
});

test('servidor real inicia e health verifica o banco',async()=>{
  const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
  const child=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',STORAGE_DIR:config.STORAGE_DIR,LOG_LEVEL:'silent'},stdio:'ignore',windowsHide:true});
  try {
    let ready=false;
    for(let attempt=0;attempt<100;attempt++) {try{const r=await fetch(`http://127.0.0.1:${port}/health`);if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
    assert.ok(ready,'API should start');
    const r=await fetch(`http://127.0.0.1:${port}/api/notas`);assert.equal(r.status,401);
  } finally {child.kill();await new Promise(resolve=>child.once('exit',resolve));}
});

test('cancelamento posterior invalida PDF e anterior ao XML mantém situação cancelada',async()=>{
  for(const beforeXml of [false,true]) {
    const e=await company();const xml=nfeXml({destinatario:e.cnpj});
    const docs=beforeXml?[{nsu:'1',schema:'procEventoNFe_v1.00.xsd',xml:eventoXml()},{nsu:'2',schema:'procNFe_v4.00.xsd',xml}]:[{nsu:'1',schema:'procNFe_v4.00.xsd',xml},{nsu:'2',schema:'procEventoNFe_v1.00.xsd',xml:eventoXml()}];
    const s=services(async()=>response({ultimo:'2',docs}));const result=await synchronize(s,e);assert.equal(result.status,'CONCLUIDA');
    let nota=await prisma.notaFiscal.findFirst({where:{empresaId:e.id}});assert.equal(nota.statusDocumento,'CANCELADA');
    if(!beforeXml) {assert.equal(nota.caminhoDanfe,null);nota=await s.danfe.generate(e,chaveFor(),true);}
    assert.ok(nota.caminhoDanfe);assert.equal((await storage.read(nota.caminhoXml,nota.hashXml)).toString(),xml);
  }
});

test('falha após processamento parcial retoma sem XML duplicado ou nova consulta',async()=>{
  const e=await company();const xml=nfeXml({destinatario:e.cnpj});let calls=0;
  let fail=true;const originalRead=storage.read.bind(storage);
  const brokenStorage=Object.create(storage);
  brokenStorage.save=async(relative,data,...rest)=>{if(fail && relative.endsWith('/000000000000002.xml')) throw new Error('simulated disk error');return storage.save(relative,data,...rest);};
  brokenStorage.read=originalRead;
  const s=services(async()=>{calls++;return response({ultimo:'2',docs:[{nsu:'1',schema:'procNFe_v4.00.xsd',xml},{nsu:'2',schema:'resNFe_v1.01.xsd',xml:resumoXml('4321')} ]});},{storage:brokenStorage});
  assert.equal((await synchronize(s,e)).status,'FALHOU');
  const ctrl=await prisma.controleDistribuicao.findUnique({where:{empresaId:e.id}});assert.equal(ctrl.ultimoNsu,'000000000000000');assert.ok(ctrl.respostaPendente);
  assert.equal(ctrl.maiorNsu, '000000000000002');
  fail=false;assert.equal((await synchronize(s,e)).status,'CONCLUIDA');assert.equal(calls,1);
  assert.equal(await prisma.notaFiscal.count({where:{empresaId:e.id,chaveAcesso:chaveFor()}}),1);
});
