export function startWorker({ prisma, distribuicao, config, logger }) {
  let stopped = false, running = null;
  async function tick() {
    // The persistent queue runs even when periodic scheduling is disabled.
    if (config.SYNC_ENABLED === 'true') {
      const companies = await prisma.empresa.findMany({ where: { ativa: true, ambiente: config.SEFAZ_AMBIENTE }, include: { controle: true } });
      for (const company of companies) {
        const eligible = !company.controle.proximaConsulta || company.controle.proximaConsulta <= new Date();
        const intervalPassed = !company.ultimaSincronizacao || +company.ultimaSincronizacao + config.SYNC_INTERVAL_MS <= Date.now() || company.controle.ultimoNsu < company.controle.maiorNsu;
        if (eligible && intervalPassed && company.controle.status !== 'RECONCILIAR') {
          try { await distribuicao.request(company, 'AUTOMATICA'); }
          catch (error) { logger.warn({ empresaId: company.id, code: error.code ?? 'INTERNO' }, 'Agendamento não iniciado'); }
        }
      }
    }
    const pending = await prisma.historicoSincronizacao.findMany({ where: { status: { in: ['PENDENTE','EXECUTANDO'] }, empresa: { ambiente: config.SEFAZ_AMBIENTE } }, orderBy: { dataInicio: 'asc' }, take: 20 });
    for (const execution of pending) {
      if (stopped) break;
      await distribuicao.execute(execution);
    }
  }
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = tick().catch(() => logger.error({ code: 'WORKER_FALHOU' }, 'Falha no processamento da fila')).finally(() => { running = null; });
  }, 5000);
  return async () => { stopped = true; clearInterval(timer); await running; };
}
