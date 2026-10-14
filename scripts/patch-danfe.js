import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Reproducible, narrowly scoped upstream layout correction. No third-party patch runner.
const root=fileURLToPath(new URL('../',import.meta.url));
const patch=JSON.parse(await fs.readFile(path.join(root,'patches/danfe-frete.json'),'utf8'));
const packageDir=path.join(root,'node_modules',patch.package);
const metadata=JSON.parse(await fs.readFile(path.join(packageDir,'package.json'),'utf8'));
if(metadata.version!==patch.version) throw new Error('Revisar patch do DANFE para a nova versão antes de instalar.');
const target=path.join(packageDir,patch.file);
const source=(await fs.readFile(target,'utf8')).replace(/\r\n/g,'\n');
if(source.includes(patch.after)) console.log('Correção do campo de frete do DANFE já aplicada.');
else {
  if(source.split(patch.before).length!==2) throw new Error('Fonte do DANFE inesperada. Patch não aplicado.');
  await fs.writeFile(target,source.replace(patch.before,patch.after));
  console.log('Correção do campo de frete do DANFE aplicada.');
}
