# API de automação de NF-e recebidas

API REST independente em **JavaScript ES Modules, Node 24, Express 5, PostgreSQL e Prisma 7**. Consulta a distribuição oficial do Ambiente Nacional por `distNSU`, preserva XMLs, gera DANFE para os leiautes suportados e disponibiliza downloads autenticados por empresa.

**A integração de produção é real, não simulada.** Não foi feita chamada à SEFAZ com certificado real. A comunicação externa só fica habilitada após cadastro ativo e configuração de A1 válido da empresa. Não há manifestação automática do destinatário. O escopo é NF-e modelo 55, não NFS-e de serviços, apesar do nome do diretório original.

## 1. Instalação

Requisitos: Node.js 24.x, npm, PostgreSQL 18 (testado), OpenSSL 3 e acesso HTTPS aos serviços oficiais. No Windows, o OpenSSL do Git for Windows é detectado em `C:/Program Files/Git/usr/bin/openssl.exe`; alternativamente configure `OPENSSL_BIN`. Em Linux, instale o pacote `openssl`.

```powershell
npm ci
npm run db:generate
Copy-Item .env.example .env
```

Em Linux, use `cp .env.example .env`. Preencha o arquivo **localmente**, sem versioná-lo. `npm ci` aplica o patch de layout do DANFE, mantido em `patches/`.

Gere seu próprio segredo para `JWT_SECRET`, por exemplo:

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Não use esse segredo em logs, tickets ou exemplos compartilhados. Em produção, prefira variáveis injetadas por gerenciador de segredos. A aplicação não imprime valores inválidos de configuração.

## 2. PostgreSQL e migrations

Com uma conta administradora no seu PostgreSQL, crie um usuário e um banco exclusivos. Os valores abaixo são **marcadores a substituir**, não credenciais prontas:

```sql
CREATE ROLE notas_api LOGIN PASSWORD '<senha-aleatoria-local>';
CREATE DATABASE notas_fiscais OWNER notas_api;
```

Configure `DATABASE_URL=postgresql://<usuario>:<senha-url-encoded>@<host>:5432/notas_fiscais?schema=public`. Caracteres especiais de usuário/senha devem ser codificados para URL. Para serviço remoto, habilite TLS e valide sua CA; não desabilite a validação do certificado do banco.

```sh
npm run db:generate
npm run db:migrate
```

As duas migrations criam tabelas, chaves estrangeiras, índices, restrição de NSU e um índice parcial que permite **somente uma execução PENDENTE/EXECUTANDO por empresa**. `migrate deploy` pode ser repetido sem recriar dados. Em produção, separe a identidade que executa migrations daquela usada pela API, limitando esta a DML nas tabelas necessárias.

Não há senha de PostgreSQL real nem `.env` preenchido no projeto. Os testes usam um cluster novo e descartável em porta local distinta; não alteram o serviço PostgreSQL já instalado.

## 3. Cadastro e certificados de empresas

Preencha estas variáveis no `.env`:

```dotenv
EMPRESA_NOME=<nome-cadastrado>
EMPRESA_CNPJ=<CNPJ-sem-pontuacao>
EMPRESA_UF_AUTOR=35
EMPRESA_ATIVA=false
EMPRESA_CERT_PATH_ENV=CERTIFICADO_PATH
EMPRESA_CERT_SENHA_ENV=CERTIFICADO_SENHA
CERTIFICADO_PATH=<caminho-absoluto-do-arquivo-A1.pfx>
CERTIFICADO_SENHA=<senha-do-A1>
SEFAZ_AMBIENTE=2
```

```sh
npm run empresa
```

O cadastro é feito por comando local de operador. Guarda somente **nomes de variáveis** do caminho/senha do certificado, nunca o segredo ou o arquivo. Cada empresa pode apontar para variáveis diferentes, como `EMPRESA_X_CERT_PATH` e `EMPRESA_X_CERT_PASSWORD`, injetadas no processo do servidor. O comando valida CNPJ e UF; o certificado é verificado ao solicitar e executar a sincronização.

Para alterar o cadastro ou ativá-lo após configurar o A1, ajuste as variáveis e execute:

```sh
npm run empresa -- --atualizar
```

É possível cadastrar e testar metadados com consulta desativada. A empresa pertence ao ambiente fiscal definido no cadastro e esse ambiente não é alterável pelo comando. Use **bancos e diretórios de storage distintos** para produção e homologação.

O A1 é relido a cada nova consulta. Substitua o arquivo de maneira atômica e mantenha as permissões privadas; não é necessário mudar o código. Se mudar senha ou variáveis injetadas, reinicie o serviço com a nova configuração. São verificados presença, formato PKCS#12, senha, validade temporal, chave privada utilizável e CNPJ base extraído da extensão ICP-Brasil. O CNPJ base (primeiros 8 caracteres) precisa corresponder ao consultado.

OpenSSL recebe a senha por stdin. Não são exportadas chaves privadas para arquivos temporários. A cadeia/revogação do certificado cliente é validada pelo serviço oficial durante a autenticação; esta versão não faz consulta OCSP/CRL local. PFX com algoritmos legados rejeitados pelo OpenSSL 3 deve ser reexportado de forma compatível pelo responsável pelo certificado; não se ativa `legacy` ou TLS inseguro automaticamente. Senhas com quebra de linha não são suportadas.

**A3 não é suportado**: depende de token/cartão, middleware, driver e integração criptográfica específica, não implementada/testada aqui.

## 4. Inicialização e automação

```sh
npm start
# Desenvolvimento:
npm run dev
```

Padrão: `http://127.0.0.1:3000`. `GET /health` só verifica a conexão ao banco e retorna `{"status":"ok"}`; os endpoints fiscais exigem token. A API falha com mensagem genérica quando falta configuração ou banco.

O worker verifica a fila persistida a cada 5 segundos. Uma solicitação manual funciona com `SYNC_ENABLED=false`. Para também agendar consultas periódicas:

```dotenv
SYNC_ENABLED=true
SYNC_INTERVAL_MS=3600000
SYNC_MAX_BATCHES=10
```

Intervalo mínimo configurável: uma hora. Se houver mais NSUs, o worker consome lotes sequenciais, com pausa de pelo menos 1 segundo, até o limite por execução. Havendo saldo, uma execução automática posterior pode continuar antes do intervalo periódico; o cursor e a disponibilidade da SEFAZ controlam essa continuação.

Após `137`, `ultNSU == maxNSU` ou `656`, persiste espera de pelo menos uma hora. Falhas de transporte/serviço têm backoff de 1h, 2h, 4h etc., limitado a 24h, sem repetição imediata. Essa escolha conservadora evita reconsulta de uma requisição cujo resultado possa ter sido perdido. Após reinício, tanto o NSU quanto os bloqueios continuam válidos.

## 5. Autenticação, autorização e Postman

Não existe login público que emita acesso arbitrário. O operador emite um JWT limitado a empresas e escopos:

```dotenv
TOKEN_SUBJECT=<identificador-do-operador>
TOKEN_CNPJS=<CNPJ-autorizado>,<outro-CNPJ-autorizado>
TOKEN_SCOPES=notas:ler,notas:download,notas:sincronizar,notas:gerar,empresas:ler
TOKEN_TTL_SECONDS=3600
```

```sh
npm run token --silent
```

O token é exibido **somente pelo comando solicitado**; copie-o para o cofre local do Postman, não para arquivos versionados. Expiração máxima do comando: 24h. Para revogar todos os tokens, rotacione `JWT_SECRET`; esta versão não tem lista de revogação por token.

No Postman, importe `docs/postman_collection.json`. Configure `baseUrl`, `cnpj`, `chave` e o segredo local `token`. A coleção usa `Authorization: Bearer {{token}}` e `X-Empresa-CNPJ: {{cnpj}}`. O cabeçalho de empresa pode ser omitido se o JWT contiver um único CNPJ.

| Endpoint | Escopo | Resultado |
| --- | --- | --- |
| `POST /api/notas/sincronizar` | `notas:sincronizar` | 202, identificador e estado da execução; reusa execução ativa |
| `GET /api/notas` | `notas:ler` | Listagem paginada |
| `GET /api/notas/status` | `notas:ler` | Última execução, cursores, próximo horário permitido |
| `GET /api/notas/sincronizacoes` | `notas:ler` | Histórico paginado |
| `GET /api/notas/sincronizacoes/:id` | `notas:ler` | Progresso/resultado da execução pelo UUID, limitado à empresa selecionada |
| `GET /api/notas/:chave` | `notas:ler` | Metadados e disponibilidade dos arquivos |
| `GET /api/notas/:chave/xml` | `notas:download` | XML original, `application/xml` |
| `GET /api/notas/:chave/danfe` | `notas:download` | PDF disponível, `application/pdf` |
| `POST /api/notas/:chave/danfe` | `notas:gerar` | Gera/regenera DANFE sob lock da empresa |
| `GET /api/empresas` | `empresas:ler` | Cadastros autorizados, sem configurações secretas |
| `PATCH /api/empresa` | `empresas:editar` | Atualiza `nome`, `ufAutor`, `ativa` da empresa selecionada |

Exemplo de sincronização, com valores substituídos pelo operador:

```http
POST /api/notas/sincronizar
Authorization: Bearer <token>
X-Empresa-CNPJ: <CNPJ>
```

```json
{
  "dados": {
    "id": "<uuid-da-execucao>",
    "status": "PENDENTE",
    "reutilizada": false,
    "mensagem": "Solicitação registrada; o resultado depende do processamento da resposta da SEFAZ."
  }
}
```

Esse 202 **não significa que notas foram encontradas**. O cabeçalho `Location` indica `GET /api/notas/sincronizacoes/:id` para acompanhar o UUID; a listagem do histórico também permanece disponível. Na coleção Postman, copie o UUID retornado para `execucaoId`. Execuções podem terminar `CONCLUIDA`, `COM_ERROS`, `FALHOU` ou `ADIADA`.

Filtros da listagem:

```http
GET /api/notas?pagina=1&limite=20&inicio=2026-10-01&fim=2026-10-31&emitente=<CNPJ>&numero=1234&status=DANFE_DISPONIVEL&ordem=desc
```

Todos os filtros são opcionais; `chave` também é aceito. Datas são `YYYY-MM-DD`, com período de calendário interpretado em UTC-03:00 (Brasília); início inclusivo e fim inclusivo. `ordem=asc|desc`, limite de 1 a 100. Desempate pelo ID mantém ordem estável. Histórico aceita `pagina`, `limite` e `status`.

Estados de importação: `RESUMO`, `XML_DISPONIVEL`, `DANFE_DISPONIVEL`, `ERRO_DANFE`. Situação fiscal é separada: `AUTORIZADA`, `DENEGADA`, `CANCELADA` ou `DESCONHECIDA`. Valores monetários são decimais serializados como strings, sem perda por ponto flutuante.

Formato de erro:

```json
{"erro":{"codigo":"XML_INDISPONIVEL","mensagem":"Somente resumo disponível; XML completo pode depender de manifestação ou distribuição posterior.","requestId":"<uuid>"}}
```

Respostas: 400 entrada inválida; 401 token; 403 escopo/empresa; 404 não encontrado; 409 indisponível/conflito; 422 XML/PDF incompatível; 429 limite de requisições/espera SEFAZ; 502 comunicação/retorno SEFAZ; 503 certificado/configuração. Falhas assíncronas ficam no histórico, não mudam retroativamente o 202.

## 6. Arquivos privados por empresa, ano e mês

`STORAGE_DIR` é a raiz absoluta ou relativa configurada. Padrão: `./storage/notas-fiscais`. No banco ficam **somente caminhos relativos** e hashes; nenhum XML/PDF inteiro é gravado no banco.

```text
notas-fiscais/
  Empresa ABC/
    2026/
      10- Outubro/
        xml/Empresa ABC - NF 1234.xml
        pdf/Empresa ABC - NF 1234.pdf
  Empresa ABC - <CNPJ-da-segunda-empresa>/
    ...
  .distribuicao/
    <CNPJ>/documentos/<NSU-ou-hash>.xml
    <CNPJ>/respostas/<UUID>.xml
```

O ano/mês é extraído da **data de emissão e seu mês original**, sem conversão UTC que deslocaria documentos na virada do mês. Os meses usam `01- Janeiro` até `12- Dezembro`. Ao processar um XML completo validado, são criadas as duas subpastas `xml` e `pdf` daquele mês. A pasta `pdf` pode ficar vazia enquanto a geração estiver pendente ou tiver falhado; não são criadas pastas para meses sem documentos completos.

Nomes de empresa são normalizados para evitar separadores, nomes reservados do Windows e caracteres de controle. A primeira empresa reserva a pasta pelo nome; nomes iguais, inclusive variação de maiúsculas, recebem sufixo CNPJ. O caminho da pasta é estável após cadastro: renomear a empresa não move arquivos históricos.

Quando duas notas têm o mesmo número no mesmo mês, a primeira mantém `Empresa - NF Numero`; a outra usa `Empresa - NF Numero - ChaveDeAcesso`. XML e PDF têm sempre o mesmo nome-base. A identidade fiscal no banco é `(empresa, chaveAcesso)`: a mesma chave pode ter vínculos de interesse em empresas distintas, com arquivos isolados.

O XML é salvo sem reserialização, com hash SHA-256. A escrita usa arquivo temporário privado, flush e publicação sem sobrescrever outro conteúdo. Temporários são removidos também quando a gravação falha. PDFs só podem ser substituídos sob lock, verificando o hash anterior. Downloads verificam o hash novamente e exigem que o caminho pertença à pasta da empresa autorizada e ao tipo solicitado. Travessia de diretórios, caminhos absolutos no banco e symlinks/junctions são rejeitados pelo armazenamento.

Resumos, eventos, documentos ainda não suportados e respostas SOAP originais ficam no arquivo operacional privado `.distribuicao`. Não são apresentados como XML completo da nota. O arquivo operacional permite investigar/reprocessar respostas preservadas; não há endpoint público de upload, leitura arbitrária ou exclusão desses arquivos.

## 7. Consistência e recuperação

1. JWT seleciona uma empresa autorizada; o pedido cria uma execução na fila PostgreSQL.
2. O worker obtém advisory lock de sessão por empresa. Outras instâncias não consultam esse CNPJ simultaneamente.
3. Antes de enviar SOAP, persiste um bloqueio conservador de uma hora para cobrir falhas de processo/rede com resultado incerto.
4. A resposta original é salva e referenciada pelo controle antes de ser processada. Após reinício, um lote pendente é retomado **sem nova chamada externa**.
5. Cada `docZip` é descompactado com limite, validado, arquivado e identificado por NSU. Quando NSU é omitido pelo serviço, usa hash como identidade técnica sem inventar NSU.
6. O maior NSU informado é registrado assim que a resposta válida é interpretada, inclusive se ocorrer falha posterior de processamento. Só após armazenar/processar o lote, uma transação avança o último NSU e os contadores. Repetições reutilizam arquivos e registros. Falha de PDF preserva XML e pode ser resolvida pelo POST de geração.

XML inválido/schema desconhecido é arquivado e marcado, e o lote pode avançar com `COM_ERROS`; gzip inválido, divergência de conteúdo no mesmo NSU, erro de disco/banco ou resposta inconsistente mantêm o cursor e o lote para recuperação. Não descarte manualmente um lote pendente para destravar a fila.

Uma falha entre receber a resposta na rede e persistir sua referência ainda é uma janela de resultado incerto; nesse caso a aplicação espera uma hora e tenta o cursor persistido. Não existe garantia de transação distribuída entre SEFAZ, PostgreSQL e filesystem. Backups devem abranger banco **e storage** de maneira coerente. Em falha entre publicar PDF e registrar seu hash, um PDF órfão divergente é bloqueado; o operador deve verificar e mover o órfão para quarentena privada antes de regenerar, nunca substituir XML original.

O advisory lock exige conexão PostgreSQL dedicada, não PgBouncer em modo transaction pooling. Em múltiplas instâncias, todas devem compartilhar banco **e o mesmo volume privado**. O lock e a fila não coordenam sistemas externos de terceiros que consultem o mesmo CNPJ. Use uma única fonte responsável pela distribuição.

## 8. Regras fiscais e limitações

A [NT oficial 2014.002 v1.40](https://hom.nfe.fazenda.gov.br/PORTAL/exibirArquivo.aspx?conteudo=G3fIxJUvAD8%3D) define a distribuição; as fontes e versões de schemas/bibliotecas estão detalhadas em [DEPENDENCIAS-E-FONTES.md](docs/DEPENDENCIAS-E-FONTES.md).

O certificado precisa habilitar o ator interessado no documento; certificado válido não autoriza consultar qualquer empresa. Verifique a situação cadastral e os requisitos da SEFAZ/UF aplicáveis ao contribuinte. O serviço de distribuição não exige inventar um cadastro de API particular, nem fornece histórico ilimitado: documentos recebidos no Ambiente Nacional estão disponíveis por até 90 dias, e novos usuários ou usuários sem consultas por mais de 60 dias podem não receber NSU retroativo. O primeiro acesso pode retornar 137.

Um resumo não dá direito técnico a reconstruir o XML. Para destinatários, a disponibilização pode depender de manifestação fiscal conforme o papel, tipo de documento e regras oficiais. Esta API não envia ciência, confirmação, desconhecimento ou operação não realizada. A empresa deve decidir e executar o evento adequado em sistema autorizado, com seu responsável fiscal. A distribuição posterior pode entregar o XML com novo NSU; não há garantia de disponibilização instantânea. PDF não substitui XML fiscal.

Implementado somente o consumo sequencial `distNSU`; `consNSU` pontual e `consChNFe` não estão expostos. A NT limita essas consultas pontuais a 20/h; não são utilizadas como contorno aos bloqueios. Em 656 com NSU servidor diferente, o sistema guarda `nsuInformadoSefaz` e exige reconciliação, sem pular documentos automaticamente. Antes de ajustar qualquer cursor, suspenda outros consumidores, concilie arquivos/NSUs e faça backup; não zere o NSU indiscriminadamente.

Suporte de DANFE nesta versão: **NF-e 4.00, modelo 55, retrato, chave numérica e sem grupos IBS/CBS/IS**. Outras variantes registram erro de PDF e mantêm o XML autorizado para download. O XSD fiscal atual é mais amplo que o suporte visual validado do gerador. A validação local é estrutural/XSD e de integridade; não verifica independentemente assinatura XML, regras tributárias ou revogação ICP-Brasil. Leia os limites em `docs/DEPENDENCIAS-E-FONTES.md` antes de implantar.

Cancelamentos recebidos invalidam o PDF anterior; o próximo POST de geração inclui a marca de cancelamento. Eventos recebidos antes do XML também são considerados. Outros eventos são arquivados, sem automatizar obrigações fiscais ou alterar valores da nota.

## 9. Testes

```sh
npm test
npm run test:integration
npm run test:all
npm audit
```

Testes unitários usam XMLs/certificados sintéticos e não acessam SEFAZ. A geração do PDF é real, não mockada; há verificação de texto, chave, total e múltiplas páginas. A integração usa PostgreSQL real, migrations aplicadas duas vezes, HTTP, concorrência entre conexões, cursor persistido, retomada, isolamento, colisões, downloads e falhas. Apenas o transporte SEFAZ e a seleção de certificado da integração são substituídos por mocks.

O runner de integração cria banco/cluster próprio sob `.tmp/integration-*`, usa porta livre em `127.0.0.1`, inicia/encerra seu PostgreSQL e preserva os artefatos para diagnóstico. **Nunca aponte esse runner para um cluster existente.** Ele usa os executáveis em `PG_BIN` (Windows padrão `C:/Program Files/PostgreSQL/18/bin`; Linux padrão `/usr/lib/postgresql/18/bin`). No Linux execute com usuário sem root. Para conferir o PDF visualmente: `node scripts/preview-danfe.js`; PDFs e PNGs ficam em `.tmp/danfe-preview`.

Um teste fiscal real deve ser realizado separadamente, em ambiente autorizado, começando pela configuração da empresa/A1 e uma solicitação autenticada manual. Não existe opção `MOCK_SEFAZ=true` ou fallback de sucesso na execução normal. Testes automáticos não habilitam produção nem usam certificados instalados de empresas.

## 10. Erros comuns e implantação

| Sintoma | Ação |
| --- | --- |
| Configuração inválida ao iniciar | Preencha `DATABASE_URL`, `JWT_SECRET` com ao menos 32 caracteres e variáveis válidas. |
| Banco indisponível/tabelas ausentes | Confirme host/porta/usuário/banco e execute migrations antes de iniciar. |
| `CERTIFICADO_AUSENTE` | Confira as variáveis cujo nome está no cadastro e a permissão do usuário do serviço. |
| `CERTIFICADO_INVALIDO` | Confirme senha/formato PKCS#12, OpenSSL 3 e exportação compatível. |
| `CERTIFICADO_EXPIRADO` / `CERTIFICADO_CNPJ` | Substitua pelo A1 válido da mesma base CNPJ; não contorne a validação. |
| `SEFAZ_AGUARDAR` / 656 | Respeite `proximaConsulta`; não tente repetidamente, pois o bloqueio pode ser renovado. |
| `NSU_RECONCILIACAO` | Investigue outro consumidor do mesmo CNPJ e concilie o cursor antes de retomar. |
| Somente `RESUMO` | Verifique manifestação, elegibilidade e disponibilidade posterior com o responsável fiscal. |
| `ERRO_DANFE` | Leia `mensagemErro`; corrija suporte/configuração e use POST de geração. Não edite o XML. |
| `INTEGRIDADE` / `COLISAO_ARQUIVO` | Investigue corrupção, backup inconsistente ou alteração manual. Restaure a cópia correta. |
| HTTP 401/403 | Verifique expiração, issuer/audience, escopos e CNPJ no JWT/cabeçalho. |

Implante atrás de proxy HTTPS, mantenha o bind privado e libere somente a rede necessária. Os limites por IP são locais a cada processo; em cluster, aplique também um limite global no proxy. Configure proxy/IP confiável de forma explícita se adaptar `trust proxy` (não habilitado por padrão).

Execute com usuário de sistema sem privilégios, concedendo acesso somente ao certificado e storage necessários. No Windows, ajuste ACLs NTFS: modos POSIX `0600/0700` não substituem ACL. Não permita escrita no volume por usuários externos; validação de symlink não protege contra um administrador local hostil alterando o filesystem durante a operação. Nunca publique `storage`, `.distribuicao`, `.env` ou certificados em servidor estático.

Mantenha backups criptografados e política de retenção fiscal definida pela empresa. Restrinja PostgreSQL por rede, mantenha relógio sincronizado, supervisione o processo para reinício e alerte para execução falha, CNPJ sem consulta e vencimento de certificado. Os logs não incluem conteúdo fiscal, senha, token, certificado ou stack trace. A API retorna caminhos apenas internamente ao banco, nunca nos metadados HTTP.

Antes de habilitar produção: configure banco e diretório separados, A1 autorizado, cadastro ativo, token com escopos mínimos, valide em homologação e confirme que nenhum outro sistema disputa o cursor. Só depois escolha `SEFAZ_AMBIENTE=1` na implantação de produção correspondente. Nenhuma alteração em produção foi feita durante o desenvolvimento.
