# Compatibilidade e fontes consultadas em 13/10/2026

Revisão em 14/10/2026: documentação oficial novamente consultada, NT 2014.002 v1.40 lida, instalação reproduzida com `npm ci`, Prisma validado e testes executados em PostgreSQL isolado. O relatório desta revisão está em [RELATORIO-IMPLEMENTACAO.md](../RELATORIO-IMPLEMENTACAO.md).

Ambiente verificado: Windows, Node.js 24.14.0, npm 11.9.0 e PostgreSQL 18. O código da aplicação, das configurações e dos testes é JavaScript ES Modules; não requer compilação TypeScript. Dependências podem conter declarações de tipos próprias.

## Serviço e schemas oficiais

- [Relação de Web Services de produção](https://www.nfe.fazenda.gov.br/portal/WebServices.aspx): Ambiente Nacional, NFeDistribuicaoDFe.
- [Relação de homologação](https://hom.nfe.fazenda.gov.br/portal/webServices.aspx).
- [NT 2014.002 v1.40, julho/2026](https://hom.nfe.fazenda.gov.br/PORTAL/exibirArquivo.aspx?conteudo=G3fIxJUvAD8%3D): alteração para CNPJ alfanumérico; leiaute de mensagem continua 1.01. Serviço publicado como versão 1.00 não é a versão do XML.
- [Lista oficial de schemas](https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=BMPFMBoln3w=).
- [Distribuição PL_NFeDistDFe_104](https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=IzuP2y0G6hk=), 03/07/2026: arquivos em `schemas/distribuicao`.
- [Pacote NF-e 010f](https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=8ITFuBLltXs=), anunciado em 31/08/2026; o ZIP entregue contém `PL_010f_v1.04`. Arquivos em `schemas/nfe`.
- [Pacote de eventos atualizado para CNPJ alfanumérico](https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=FOEnx2KAsCk=), 08/06/2026: `PL_Evento.zip` extraído para `schemas/eventos`.

Os XSD oficiais estão incluídos para validação sem acesso à rede. O pacote 010f não traz o ponto de entrada `procNFe_v4.00.xsd`; o projeto acrescenta somente esse invólucro, referenciando o tipo **TNfeProc original**, sem alterar regras fiscais. O XSD de assinatura necessário ao resumo é carregado do pacote NF-e. Não se baixam schemas de URLs fornecidas por XMLs.

Algumas consultas do navegador ao Portal tiveram redirecionamento circular. Os documentos e ZIPs foram obtidos diretamente por HTTPS do Portal. Os endereços dos web services são fixos no código; nenhum scraping é usado pela aplicação.

## Bibliotecas

| Componente | Decisão e referência |
| --- | --- |
| Prisma 7.10.0 + adapter-pg | Versão estável compatível com Node 24; generator `prisma-client-js` mantém consumo JavaScript. Configuração em `prisma.config.js`. [Documentação](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql). Não foi adotado o Prisma 8 RC anunciado pelo npm. |
| `node:https`, `node:tls` e OpenSSL 3 | SOAP 1.1 conforme exemplo da NT, autenticação mTLS A1, timeout total, validação TLS ativa. [Node HTTPS](https://nodejs.org/api/https.html), [OpenSSL PKCS12](https://docs.openssl.org/3.5/man1/openssl-pkcs12/). |
| ASN1js 3.0.10 | Decodifica somente a identidade CNPJ na extensão SAN OID 2.16.76.1.3.3. [Documentação](https://github.com/PeculiarVentures/ASN1.js). A criptografia fica no OpenSSL/Node. |
| `fast-xml-parser` 5.11.2 | Leitura estrutural, valores sempre strings, DTD/entidades rejeitados antes do parser. [Documentação](https://github.com/NaturalIntelligence/fast-xml-parser). |
| `xmllint-wasm` 5.3.0 | libxml2 em WebAssembly para validar contra XSDs oficiais. Sem busca de entidades/esquemas na rede. [API](https://github.com/noppa/xmllint-wasm). |
| `@alexssmusica/node-pdf-nfe` 1.3.1 | `gerarPDF(xml, opções)` retorna stream PDFKit finalizado. Verificado com NF-e 4.00 e uma/múltiplas páginas. [Repositório e API](https://github.com/Alexssmusica/node-pdf-nfe). |
| Express 5, jose 6, Zod 4 | API assíncrona, JWT HS256 com issuer/audience/exp obrigatórios e validação de entradas. |
| pino, helmet, express-rate-limit | Logs estruturados sem XML/token, cabeçalhos HTTP e limites por IP. |
| node:test, supertest, pdfjs-dist | Testes unitários, HTTP, extração e renderização visual do PDF. |

Todas as versões exatas estão em `package.json` e `package-lock.json`. As dependências transitivas `deepmerge-ts` e `mysql2` do ferramental Prisma têm overrides para versões corrigidas; `prisma generate` e migrations foram verificados após a atualização. Não há acesso MySQL neste projeto.

Foi removido `node-forge` após a auditoria indicar vulnerabilidade sem correção disponível. Leitura do A1 usa OpenSSL e Node X509Certificate; a senha passa por stdin. Nenhuma chave privada é exportada para arquivo intermediário.

O patch versionado em `patches/` corrige o campo de frete do DANFE 1.3.1: largura, posição e fonte, sem alterar dados fiscais. É reaplicado por `postinstall`; uma atualização da biblioteca exige revisar esse patch e repetir a conferência visual.

## Limites de validação

- XML: XSD, estrutura, vínculo de chave/destinatário/ambiente/protocolo e hash SHA-256. Não há verificação independente da assinatura XML nem consulta local de revogação do certificado. A origem fiscal é o canal mTLS com a SEFAZ; o serviço oficial autentica o certificado. Não existe upload/importação pública de XML.
- Chaves numéricas: dígito verificador módulo 11 validado nas entradas. No XML completo também se comparam UF, ano/mês da emissão, emitente, modelo, série, número, forma de emissão, código numérico e DV. Chaves alfanuméricas têm validação de formato e vínculo; não se aplica a elas a regra de DV numérica nem se declara validação completa desse novo DV.
- Eventos: validação do envelope pelo XSD genérico oficial e coerência evento/retorno. O schema genérico usa `xs:any` no detalhamento; esta API não valida todos os detalhes de todos os tipos de evento. Só aplica mudança de situação para cancelamento vinculado ou resumo de cancelamento.
- DANFE: suportado NF-e modelo 55 v4.00, impressão retrato, chave numérica, sem IBS/CBS/IS. Embora a biblioteca possua código para RTC, esse suporte não foi homologado aqui com uma matriz fiscal completa; o adaptador bloqueia esses grupos preservando o XML. Não há DANFE para resumos, NFC-e, NF-e antiga, NFS-e ou XML denegado.
- CNPJ alfanumérico: aceito no cadastro, JWT, SAN, SOAP e schemas atuais. Nenhuma chamada com certificado ICP-Brasil alfanumérico real foi realizada. DANFE de chave alfanumérica é bloqueado explicitamente.

Fixtures são sintéticas, têm assinatura/protocolo de teste e **não são documentos fiscais válidos para uso empresarial**. Validam o schema e o fluxo local; não demonstram autorização fiscal nem homologação na SEFAZ.
