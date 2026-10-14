# Relatório da API de automação de NF-e

Data da revisão e validação: 14/10/2026.

## Resultado

A API está implementada em JavaScript ES Modules com Express, PostgreSQL e Prisma. Os fluxos locais foram validados com banco PostgreSQL real isolado, XMLs sintéticos, geração real de DANFE e transporte SEFAZ substituído exclusivamente nos testes. A execução normal utiliza SOAP e HTTPS com certificado A1 nos serviços oficiais: não existe fallback de sucesso fictício.

O diretório já continha a estrutura da API, bibliotecas instaladas, migrations, documentação e testes. Essa implementação foi preservada, revisada e ampliada; arquivos alheios ao projeto não foram removidos. Não havia repositório Git inicializado nesta pasta.

**Validação final: 31 testes aprovados, sendo 15 unitários e 16 de integração; nenhuma falha.** As duas migrations foram aplicadas a um PostgreSQL novo e reaplicadas sem alterações pendentes. O servidor HTTP foi iniciado durante os testes, verificando `/health` e bloqueio de acesso sem token. `npm audit` não encontrou vulnerabilidades conhecidas na árvore instalada na data da execução.

Não foi feita consulta à SEFAZ com certificado empresarial real, não foi configurado banco de produção e não foi utilizado certificado real. O resultado comprova o funcionamento local; a homologação fiscal com credenciais autorizadas permanece uma etapa externa necessária.

## Funcionalidades disponíveis

- Cadastro de empresas por comando local, com CNPJ único, nome, pasta exclusiva, ambiente, UF, ativação e data da última sincronização. O banco guarda os nomes das variáveis do certificado e da senha, nunca a senha em texto simples.
- Autenticação JWT, autorização por CNPJ e por escopo, validação de entradas e limitação de requisições.
- Solicitação manual persistida e execução em segundo plano, com identificador, estado e histórico. O HTTP 202 registra o pedido; documentos só são contabilizados após resposta efetivamente processada.
- Serviço oficial `NFeDistribuicaoDFe` com `distNSU`, leiaute de mensagem 1.01, SOAP e autenticação mTLS com A1.
- Preservação do último NSU processado, maior NSU informado, próximo horário permitido e histórico. Respostas recebidas são arquivadas para retomar lotes pendentes sem nova chamada externa.
- Tratamento de resumo de NF-e, XML completo, eventos e documentos não suportados. Resumo não é convertido em XML completo nem em DANFE.
- Espera de pelo menos uma hora após esgotamento/137/656, tentativas com espera progressiva e reconciliação explícita quando o NSU local divergir do informado em 656.
- Controle de concorrência com advisory lock PostgreSQL por empresa e índice parcial para impedir duas execuções ativas da mesma empresa.
- Listagem paginada, filtros, consulta individual, download protegido do XML/PDF, geração e regeneração do DANFE e consulta do histórico/progresso.
- Logs estruturados e tratamento centralizado de erros, sem retornar stack traces, caminhos internos ou segredos.

## Organização dos arquivos

O diretório-base é configurado em `STORAGE_DIR`; o padrão é `./storage/notas-fiscais`.

```text
notas-fiscais/
  Empresa ABC/
    2026/
      10- Outubro/
        xml/
          Empresa ABC - NF 1234.xml
        pdf/
          Empresa ABC - NF 1234.pdf
  Empresa ABC - <CNPJ-da-segunda-empresa>/
    ...
  .distribuicao/
    <CNPJ>/documentos/<NSU-ou-hash>.xml
    <CNPJ>/respostas/<UUID>.xml
```

Ano e mês usam a data de emissão original do documento, inclusive quando a conversão UTC mudaria o mês. São criadas `xml` e `pdf` somente no mês em que um XML completo validado é processado; a pasta PDF pode ficar vazia se a geração falhar. Resumos e arquivos operacionais permanecem em `.distribuicao`, separados dos XMLs completos.

Os nomes são normalizados para uso seguro. Nomes de pasta iguais, inclusive com diferença de maiúsculas/minúsculas, recebem sufixo com o CNPJ da empresa adicional. Para notas diferentes com o mesmo número, usa-se a chave de acesso como sufixo no nome-base da nota adicional. Essa exceção preserva o nome solicitado quando não há colisão e impede sobrescrita de documentos distintos. XML e PDF correspondentes sempre têm o mesmo nome-base.

O banco guarda caminhos relativos e hashes SHA-256. A raiz pode ser alterada sem regravar os caminhos no banco, desde que o volume seja transferido preservando a estrutura. A pasta cadastrada permanece estável ao renomear uma empresa; arquivos históricos não são movidos automaticamente.

Downloads conferem empresa, tipo do arquivo, estrutura e hash. Caminhos absolutos, travessia de diretórios e symlinks/junctions são bloqueados. O armazenamento não é servido como diretório público. A escrita evita sobrescrita e remove arquivos temporários também em falhas de gravação.

## Arquivos e módulos

| Local | Responsabilidade |
| --- | --- |
| `src/app.js`, `src/server.js` | Aplicação Express, inicialização e encerramento |
| `src/routes/`, `src/controllers/` | Endpoints, filtros, metadados e downloads |
| `src/services/sefazService.js` | SOAP/HTTPS oficial e timeout |
| `src/services/certificateService.js` | Leitura A1 com OpenSSL, validade e identificação CNPJ |
| `src/services/distribuicaoService.js` | Cursor NSU, arquivo de respostas, processamento e recuperação |
| `src/services/xmlService.js` | Gzip, XML, XSDs oficiais e coerência dos dados |
| `src/services/storageService.js` | Estrutura física, integridade e escrita privada |
| `src/services/danfeService.js` | Geração/regeneração real de PDF e registro de falhas |
| `src/jobs/sincronizarNotas.js` | Fila manual e agendamento periódico |
| `src/repositories/empresaRepository.js` | Cadastro e prevenção de colisões de pastas |
| `src/config/`, `src/middleware/`, `src/utils/` | Configuração, banco, logs, segurança e validação |
| `prisma/schema.prisma`, `prisma/migrations/` | Empresas, notas, documentos distribuídos, controle e histórico |
| `schemas/` | Schemas fiscais usados para validação local |
| `scripts/` | Cadastro, emissão local de JWT, testes de banco e preview de DANFE |
| `patches/` | Correção reproduzível do campo de frete na biblioteca de DANFE |
| `tests/` | Fixtures sintéticas e testes automatizados |
| `docs/postman_collection.json` | Coleção importável no Postman, sem credenciais |
| `.env.example`, `.gitignore` | Configuração documentada e exclusão de segredos/arquivos privados |
| `README.md`, `docs/DEPENDENCIAS-E-FONTES.md` | Instalação, operação, fontes e limitações |

Nesta revisão foram criados `tests/unit/worker.test.js`, `tests/unit/sefaz.test.js` e este relatório. Foram ampliados os testes existentes, os serviços de armazenamento/XML/distribuição/DANFE, a validação de entradas, os controllers/routes e a documentação/coleção Postman.

Os reforços incluem as duas subpastas mensais, a validação do proprietário do caminho nos downloads, limpeza de temporários em falhas, prevenção de colisão em gravações simultâneas, persistência antecipada do maior NSU, verificação do DV de chaves numéricas e coerência dos componentes da chave no XML completo.

Também foi acrescentado `GET /api/notas/sincronizacoes/:id`: o cabeçalho `Location` da solicitação 202 aponta para ele, permitindo acompanhar diretamente a execução autorizada.

## Comandos executados e verificações

```powershell
node --version
npm --version
npm ci
npm run db:generate
npx prisma validate
npm test
npm run test:integration
npm run test:all
npm audit
node scripts/preview-danfe.js
```

Ambiente verificado: Windows, Node.js 24.14.0, npm 11.9.0 e PostgreSQL 18. O `npm ci` instalou as dependências travadas e aplicou o patch versionado do DANFE; o Prisma Client foi gerado novamente. O runner de integração executou `prisma migrate deploy` duas vezes no cluster isolado e encerrou seu PostgreSQL ao concluir.

Os testes cobrem entradas, paginação/filtros, JWT/escopos/CNPJ, certificado sintético válido/inválido/expirado, SOAP/mTLS configurado corretamente, indisponibilidade HTTP e de rede, gzip, XML/XSD, resumo e XML completo, PDF de uma/várias páginas, duplicidade, colisão, isolamento entre empresas, downloads, cancelamento, NSU, recuperação de lote, espera progressiva e concorrência.

O worker foi testado quanto a bloqueio persistido, intervalo, saldo NSU, reconciliação, fila manual com automação desativada e prevenção de ticks sobrepostos. A API também foi testada quanto ao 202 sem chamada antecipada à SEFAZ e à consulta da execução por UUID.

Pré-visualizações sintéticas em `.tmp/danfe-preview/` foram geradas e conferidas visualmente. O último conjunto de artefatos do banco/testes está em `.tmp/integration-ICNE47/`; são dados artificiais e não documentos fiscais empresariais.

## Dependências utilizadas

Versões fixadas no `package.json` e no lockfile: Express 5.3.0, Prisma Client/CLI/adapter-pg 7.10.0, pg 8.23.1, dotenv 18.0.7, jose 6.2.12, Zod 4.6.7, pino 10.4.0, helmet 8.3.0 e express-rate-limit 8.7.1.

XML: fast-xml-parser 5.11.2 e xmllint-wasm 5.3.0. A1: ASN1js 3.0.10 para identificação SAN e OpenSSL 3/Node para a criptografia. SOAP: implementação explícita sobre `node:https`, compatível com o envelope documentado na NT.

DANFE: `@alexssmusica/node-pdf-nfe` 1.3.1. Testes: `node:test`, supertest 7.3.1 e pdfjs-dist 6.4.299. As versões e as referências de cada escolha constam em [DEPENDENCIAS-E-FONTES.md](docs/DEPENDENCIAS-E-FONTES.md).

## Documentação fiscal e limites

Foram conferidos a [relação oficial de Web Services](https://www.nfe.fazenda.gov.br/portal/WebServices.aspx), o [aviso oficial da NT 2014.002 v1.40](https://www.nfe.fazenda.gov.br/portal/informe.aspx?AspxAutoDetectCookieSupport=1&Informe=9ydmiExbDZM%3D&ehCTG=false) e o conteúdo da [NT oficial](https://hom.nfe.fazenda.gov.br/PORTAL/exibirArquivo.aspx?conteudo=G3fIxJUvAD8%3D), também disponível localmente em `.tmp/NT2014.002-v1.40.pdf`. A documentação das bibliotecas foi consultada. Alguns acessos ao Portal pelo navegador retornaram redirecionamento circular; o conteúdo local da NT foi lido e a publicação confirmada no Portal.

A distribuição tem janela de até 90 dias após recepção no Ambiente Nacional e regras de geração de NSU para usuários ativos nos últimos 60 dias; não equivale a um arquivo histórico ilimitado. O certificado deve corresponder à base CNPJ consultada, e os documentos devem ser de interesse do ator autorizado. Para destinatários, a disponibilização do XML completo depende das regras de manifestação. Nenhum evento de manifestação é enviado automaticamente por esta API.

Suporte de PDF validado: NF-e modelo 55, versão 4.00, retrato, chave numérica e sem grupos IBS/CBS/IS. Outros leiautes registram falha de DANFE e preservam o XML. Não há suporte declarado a certificado A3, NFC-e, NFS-e, PDF a partir de resumo nem validação fiscal/tributária completa.

A validação local inclui XSD, coerência, integridade e DV numérico, mas não uma verificação independente da assinatura XML ou consulta local de revogação ICP-Brasil. Chaves alfanuméricas têm validação de formato e vínculo; seu novo DV não foi homologado aqui. A autenticação fiscal real fica a cargo do canal oficial com certificado autorizado.

Há uma janela inevitável entre receber a resposta remota e persistir sua referência. Banco, SEFAZ e filesystem não participam de uma única transação; o sistema aplica espera conservadora e preserva lotes já referenciados. Backups precisam abranger banco e volume juntos. Não há limpeza automática do arquivo operacional: definir retenção é responsabilidade da implantação.

## Como habilitar a integração real

1. Leia o [README](README.md), crie um PostgreSQL exclusivo e copie `.env.example` para `.env` localmente. Preencha banco, segredo JWT, ambiente fiscal e storage privado.
2. Execute `npm ci`, `npm run db:generate` e `npm run db:migrate` no banco escolhido.
3. Configure um A1 autorizado e compatível com OpenSSL 3, caminho/senha privados e UF/CNPJ da empresa. Cadastre com `npm run empresa`, inicialmente com consulta desativada.
4. Confirme situação cadastral, papel autorizado e regras fiscais com o responsável da empresa. Combine quem será o único consumidor responsável pelo cursor daquele CNPJ.
5. Ative o cadastro após validação da configuração, usando `npm run empresa -- --atualizar`. Emita JWT limitado aos CNPJs e escopos necessários com `npm run token --silent`.
6. Inicie com `npm start`, importe a coleção Postman e faça uma solicitação manual autorizada. Acompanhe o UUID em `Location`, os status, NSUs e bloqueios. Um retorno 137 ou somente resumos é possível e não significa erro do código.
7. Após validar o ambiente autorizado, habilite `SYNC_ENABLED=true`. Use bancos/storage distintos para homologação e produção, proxy HTTPS, ACLs privadas, backups e monitoramento.

O segredo JWT, senha do certificado e credenciais do banco devem ser preenchidos pelo operador; este trabalho não criou nem solicitou credenciais empresariais reais.
