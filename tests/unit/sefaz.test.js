import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { consultarSefaz } from '../../src/services/sefazService.js';
import { empresa, response } from '../fixtures/fiscal.js';

test('transporte envia SOAP/mTLS oficial sem fallback e trata indisponibilidade', async t => {
  let statusCode = 200, interrupted = false;
  const certificate = { pfx: Buffer.from('sintetico'), passphrase: 'somente-teste' };
  t.mock.method(https, 'request', (url, options, onResponse) => {
    assert.equal(url, 'https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx');
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.minVersion, 'TLSv1.2');
    assert.equal(options.pfx, certificate.pfx);
    assert.equal(options.method, 'POST');
    assert.match(options.headers.SOAPAction, /nfeDistDFeInteresse/);
    const req = new EventEmitter();
    req.end = body => {
      assert.match(body, /<soap:Envelope/);
      assert.match(body, /<ultNSU>000000000000000<\/ultNSU>/);
      queueMicrotask(() => {
        if (interrupted) req.emit('error', new Error('network unavailable'));
        else {
          const res = new EventEmitter(); res.statusCode = statusCode;
          onResponse(res); res.emit('data', response()); res.emit('end');
        }
        req.emit('close');
      });
    };
    return req;
  });
  assert.deepEqual(await consultarSefaz(empresa, '000000000000000', certificate), response());
  statusCode = 503;
  await assert.rejects(consultarSefaz(empresa, '000000000000000', certificate), { code: 'SEFAZ_HTTP' });
  interrupted = true;
  await assert.rejects(consultarSefaz(empresa, '000000000000000', certificate), { code: 'SEFAZ_COMUNICACAO' });
});
