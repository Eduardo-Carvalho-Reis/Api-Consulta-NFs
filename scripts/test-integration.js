import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// Own disposable cluster; no connection to the user's installed PostgreSQL service.
const pgBin = process.env.PG_BIN || (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/18/bin' : '/usr/lib/postgresql/18/bin');
const tempRoot = path.resolve('.tmp'); await fs.mkdir(tempRoot, { recursive: true });
const folder = await fs.mkdtemp(path.join(tempRoot, 'integration-'));
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const command = (file, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { env, stdio: 'inherit', windowsHide: true });
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Process exited ${code}`)));
});
const binary = name => path.join(pgBin, name + (process.platform === 'win32' ? '.exe' : ''));
let started = false;
try {
  await command(binary('initdb'), ['-D', path.join(folder, 'pgdata'), '-U', 'test_operator', '--auth=trust', '--encoding=UTF8', '--locale=C']);
  await command(binary('pg_ctl'), ['-D', path.join(folder, 'pgdata'), '-l', path.join(folder, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']); started = true;
  await command(binary('createdb'), ['-h','127.0.0.1','-p',String(port),'-U','test_operator','api_nfe_test']);
  const env = { ...process.env, DATABASE_URL: `postgresql://test_operator@127.0.0.1:${port}/api_nfe_test`, TEST_STORAGE: path.join(folder,'notas-fiscais'), NODE_ENV: 'test', JWT_SECRET: randomBytes(32).toString('hex'), SYNC_ENABLED: 'false', SEFAZ_AMBIENTE: '2' };
  await command(process.execPath, ['node_modules/prisma/build/index.js','migrate','deploy'], env);
  await command(process.execPath, ['node_modules/prisma/build/index.js','migrate','deploy'], env);
  await command(process.execPath, ['--test','--test-concurrency=1','tests/integration/api.test.js'], env);
} catch (error) { console.error('Teste de integração falhou:', error.message); process.exitCode = 1; }
finally {
  if (started) await command(binary('pg_ctl'), ['-D',path.join(folder,'pgdata'),'-m','fast','-w','stop']);
  console.log(`Artefatos de teste isolados preservados em ${folder}`);
}
