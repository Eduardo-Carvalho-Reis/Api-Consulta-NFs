import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { startWorker } from '../../src/jobs/sincronizarNotas.js';

const logger = { warn() {}, error() {} };
const config = { SYNC_ENABLED: 'true', SYNC_INTERVAL_MS: 3600000, SEFAZ_AMBIENTE: '2' };

test('worker respeita bloqueio, intervalo, saldo NSU e reconciliação', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const now = Date.now();
  const common = { ultimaSincronizacao: new Date(now - 7200000), controle: { proximaConsulta: null, status: 'PRONTO', ultimoNsu: '0', maiorNsu: '0' } };
  const companies = [
    { ...common, id: 'permitida' },
    { ...common, id: 'bloqueada', controle: { ...common.controle, proximaConsulta: new Date(now + 3600000) } },
    { ...common, id: 'recente', ultimaSincronizacao: new Date(now) },
    { ...common, id: 'saldo', ultimaSincronizacao: new Date(now), controle: { ...common.controle, maiorNsu: '1' } },
    { ...common, id: 'reconciliar', controle: { ...common.controle, status: 'RECONCILIAR' } },
  ];
  const scheduled = [], executed = [];
  const prisma = {
    empresa: { findMany: async args => { assert.deepEqual(args.where, { ativa: true, ambiente: '2' }); return companies; } },
    historicoSincronizacao: { findMany: async () => [{ id: 'execucao-retomada', status: 'EXECUTANDO' }] },
  };
  const stop = startWorker({ prisma, config, logger, distribuicao: {
    request: async (company, origin) => scheduled.push([company.id, origin]),
    execute: async execution => executed.push(execution.id),
  } });
  t.mock.timers.tick(5000); await setImmediate();
  assert.deepEqual(scheduled, [['permitida', 'AUTOMATICA'], ['saldo', 'AUTOMATICA']]);
  assert.deepEqual(executed, ['execucao-retomada']);
  await stop(); t.mock.timers.tick(5000); await setImmediate();
  assert.equal(executed.length, 1);
});

test('automação desativada mantém fila manual e impede ticks simultâneos', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const stop = startWorker({ config: { ...config, SYNC_ENABLED: 'false' }, logger,
    prisma: {
      empresa: { findMany: async () => assert.fail('agendamento automático desativado') },
      historicoSincronizacao: { findMany: async () => [{ id: 'manual', status: 'PENDENTE' }] },
    },
    distribuicao: { execute: async () => { calls++; await gate; } },
  });
  t.mock.timers.tick(5000); await setImmediate();
  t.mock.timers.tick(15000); await setImmediate();
  assert.equal(calls, 1);
  release(); await stop();
});
