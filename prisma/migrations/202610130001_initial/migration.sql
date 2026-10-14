-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Empresa" (
    "id" UUID NOT NULL,
    "cnpj" VARCHAR(14) NOT NULL,
    "nome" VARCHAR(120) NOT NULL,
    "pasta" VARCHAR(160) NOT NULL,
    "pastaNormalizada" VARCHAR(160) NOT NULL,
    "ambiente" VARCHAR(1) NOT NULL,
    "ufAutor" VARCHAR(2) NOT NULL,
    "certificadoPathEnv" VARCHAR(100) NOT NULL,
    "certificadoSenhaEnv" VARCHAR(100) NOT NULL,
    "ativa" BOOLEAN NOT NULL DEFAULT false,
    "ultimaSincronizacao" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Empresa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotaFiscal" (
    "id" UUID NOT NULL,
    "empresaId" UUID NOT NULL,
    "chaveAcesso" VARCHAR(44) NOT NULL,
    "cnpjEmitente" VARCHAR(14),
    "cpfEmitente" VARCHAR(11),
    "cnpjDestinatario" VARCHAR(14),
    "numero" VARCHAR(9),
    "serie" VARCHAR(3),
    "dataEmissao" TIMESTAMP(3),
    "emissaoOriginal" VARCHAR(35),
    "valorTotal" DECIMAL(15,2),
    "statusDocumento" VARCHAR(30) NOT NULL DEFAULT 'RESUMO',
    "statusImportacao" VARCHAR(30) NOT NULL DEFAULT 'RESUMO',
    "caminhoXml" TEXT,
    "caminhoDanfe" TEXT,
    "hashXml" VARCHAR(64),
    "hashDanfe" VARCHAR(64),
    "nsu" VARCHAR(15),
    "mensagemErro" TEXT,
    "dataRecebimento" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataUltimaAtualizacao" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotaFiscal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ControleDistribuicao" (
    "id" UUID NOT NULL,
    "empresaId" UUID NOT NULL,
    "ultimoNsu" VARCHAR(15) NOT NULL DEFAULT '000000000000000',
    "maiorNsu" VARCHAR(15) NOT NULL DEFAULT '000000000000000',
    "ultimaConsulta" TIMESTAMP(3),
    "proximaConsulta" TIMESTAMP(3),
    "status" VARCHAR(30) NOT NULL DEFAULT 'PRONTO',
    "cStat" VARCHAR(3),
    "falhasSeguidas" INTEGER NOT NULL DEFAULT 0,
    "mensagemErro" TEXT,
    "respostaPendente" TEXT,
    "hashResposta" VARCHAR(64),
    "nsuInformadoSefaz" VARCHAR(15),

    CONSTRAINT "ControleDistribuicao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricoSincronizacao" (
    "id" UUID NOT NULL,
    "empresaId" UUID NOT NULL,
    "origem" VARCHAR(15) NOT NULL DEFAULT 'MANUAL',
    "dataInicio" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataFim" TIMESTAMP(3),
    "status" VARCHAR(30) NOT NULL DEFAULT 'PENDENTE',
    "quantidadeDocumentosEncontrados" INTEGER NOT NULL DEFAULT 0,
    "quantidadeXmlsArmazenados" INTEGER NOT NULL DEFAULT 0,
    "quantidadeErros" INTEGER NOT NULL DEFAULT 0,
    "mensagemErro" TEXT,
    "cStat" VARCHAR(3),

    CONSTRAINT "HistoricoSincronizacao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentoDistribuido" (
    "id" UUID NOT NULL,
    "empresaId" UUID NOT NULL,
    "nsu" VARCHAR(15),
    "identificador" TEXT NOT NULL,
    "schema" VARCHAR(100) NOT NULL,
    "tipo" VARCHAR(30) NOT NULL,
    "chaveAcesso" VARCHAR(44),
    "caminho" TEXT NOT NULL,
    "hash" VARCHAR(64) NOT NULL,
    "mensagemErro" TEXT,
    "recebidoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentoDistribuido_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Empresa_cnpj_key" ON "Empresa"("cnpj");

-- CreateIndex
CREATE UNIQUE INDEX "Empresa_pasta_key" ON "Empresa"("pasta");

-- CreateIndex
CREATE UNIQUE INDEX "Empresa_pastaNormalizada_key" ON "Empresa"("pastaNormalizada");

-- CreateIndex
CREATE UNIQUE INDEX "NotaFiscal_caminhoXml_key" ON "NotaFiscal"("caminhoXml");

-- CreateIndex
CREATE UNIQUE INDEX "NotaFiscal_caminhoDanfe_key" ON "NotaFiscal"("caminhoDanfe");

-- CreateIndex
CREATE INDEX "NotaFiscal_empresaId_dataEmissao_id_idx" ON "NotaFiscal"("empresaId", "dataEmissao", "id");

-- CreateIndex
CREATE INDEX "NotaFiscal_empresaId_cnpjEmitente_idx" ON "NotaFiscal"("empresaId", "cnpjEmitente");

-- CreateIndex
CREATE INDEX "NotaFiscal_empresaId_numero_idx" ON "NotaFiscal"("empresaId", "numero");

-- CreateIndex
CREATE INDEX "NotaFiscal_empresaId_statusImportacao_idx" ON "NotaFiscal"("empresaId", "statusImportacao");

-- CreateIndex
CREATE UNIQUE INDEX "NotaFiscal_empresaId_chaveAcesso_key" ON "NotaFiscal"("empresaId", "chaveAcesso");

-- CreateIndex
CREATE UNIQUE INDEX "ControleDistribuicao_empresaId_key" ON "ControleDistribuicao"("empresaId");

-- CreateIndex
CREATE INDEX "HistoricoSincronizacao_empresaId_dataInicio_idx" ON "HistoricoSincronizacao"("empresaId", "dataInicio");

-- CreateIndex
CREATE INDEX "HistoricoSincronizacao_status_dataInicio_idx" ON "HistoricoSincronizacao"("status", "dataInicio");

-- CreateIndex
CREATE INDEX "DocumentoDistribuido_empresaId_chaveAcesso_idx" ON "DocumentoDistribuido"("empresaId", "chaveAcesso");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentoDistribuido_empresaId_nsu_key" ON "DocumentoDistribuido"("empresaId", "nsu");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentoDistribuido_empresaId_identificador_key" ON "DocumentoDistribuido"("empresaId", "identificador");

-- AddForeignKey
ALTER TABLE "NotaFiscal" ADD CONSTRAINT "NotaFiscal_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "Empresa"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControleDistribuicao" ADD CONSTRAINT "ControleDistribuicao_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "Empresa"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricoSincronizacao" ADD CONSTRAINT "HistoricoSincronizacao_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "Empresa"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentoDistribuido" ADD CONSTRAINT "DocumentoDistribuido_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "Empresa"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
