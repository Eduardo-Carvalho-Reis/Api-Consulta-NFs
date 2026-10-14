import fs from 'node:fs/promises';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { generatePdf } from '../src/services/danfeService.js';
import { nfeXml, empresa } from '../tests/fixtures/fiscal.js';

const output=path.resolve('.tmp/danfe-preview');await fs.mkdir(output,{recursive:true});
for(const [name,items] of [['simples',1],['multipagina',70]]) {
  const pdf=await generatePdf(nfeXml({items}),empresa);await fs.writeFile(path.join(output,`${name}.pdf`),pdf);
  const document=await getDocument({data:new Uint8Array(pdf)}).promise;
  for(let p=1;p<=document.numPages;p++) {
    const page=await document.getPage(p), viewport=page.getViewport({scale:1.5});const canvas=createCanvas(viewport.width,viewport.height);
    await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
    await fs.writeFile(path.join(output,`${name}-${p}.png`),canvas.toBuffer('image/png'));
  }
}
console.log(`DANFEs sintéticos e imagens de conferência: ${output}`);
