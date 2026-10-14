CREATE UNIQUE INDEX "Historico_uma_execucao_ativa_por_empresa"
ON "HistoricoSincronizacao" ("empresaId")
WHERE "status" IN ('PENDENTE', 'EXECUTANDO');

ALTER TABLE "ControleDistribuicao"
ADD CONSTRAINT "controle_nsu_valido" CHECK (
  "ultimoNsu" ~ '^[0-9]{15}$' AND "maiorNsu" ~ '^[0-9]{15}$'
);
ALTER TABLE "Empresa"
ADD CONSTRAINT "empresa_ambiente_valido" CHECK ("ambiente" IN ('1', '2'));
