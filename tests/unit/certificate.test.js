import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { loadCertificate, opensslPath } from '../../src/services/certificateService.js';
import { cnpj } from '../fixtures/fiscal.js';

test('A1 sintético: leitura, CNPJ SAN, validade, senha errada e troca de certificado',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nfe-test-pfx-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const binary=await opensslPath();
  const run=(args,input='')=>new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{stdio:['pipe','ignore','ignore'],windowsHide:true});child.on('error',reject);child.on('close',c=>c===0?resolve():reject(new Error('OpenSSL test fixture failed')));child.stdin.end(input);
  });
  const key=path.join(root,'test.key'),cert=path.join(root,'test.crt'),pfx=path.join(root,'test.pfx');
  await run(['req','-x509','-newkey','rsa:2048','-noenc','-keyout',key,'-out',cert,'-days','2','-subj','/CN=SYNTHETIC TEST CERTIFICATE','-addext',`subjectAltName=otherName:2.16.76.1.3.3;UTF8:${cnpj}`]);
  await run(['pkcs12','-export','-inkey',key,'-in',cert,'-out',pfx,'-passout','stdin'],'synthetic-only\n');
  const company={cnpj,certificadoPathEnv:'TEST_PATH',certificadoSenhaEnv:'TEST_PASSWORD'};
  const env={TEST_PATH:pfx,TEST_PASSWORD:'synthetic-only'};
  const loaded=await loadCertificate(company,env);assert.ok(loaded.pfx.length>1000);
  await assert.rejects(loadCertificate(company,{...env,TEST_PASSWORD:'wrong'}),{code:'CERTIFICADO_INVALIDO'});
  await assert.rejects(loadCertificate({...company,cnpj:'88888888000191'},env),{code:'CERTIFICADO_CNPJ'});
  await assert.rejects(loadCertificate(company,env,new Date(Date.now()+10*86400000)),{code:'CERTIFICADO_EXPIRADO'});
  await assert.rejects(loadCertificate(company,env,new Date('2020-01-01')),{code:'CERTIFICADO_INVALIDO'});
  const replacement=path.join(root,'replacement.pfx');await fs.copyFile(pfx,replacement);
  assert.ok((await loadCertificate(company,{...env,TEST_PATH:replacement})).pfx.equals(loaded.pfx));
});
