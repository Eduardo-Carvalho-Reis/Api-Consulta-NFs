import 'dotenv/config';
import { createDatabase } from '../src/config/database.js';
import { cadastrarEmpresa, publicEmpresa } from '../src/repositories/empresaRepository.js';
import { empresaSchema } from '../src/utils/validation.js';
import { safeError } from '../src/utils/errors.js';

if (!process.env.DATABASE_URL || !['1','2'].includes(process.env.SEFAZ_AMBIENTE)) throw new Error('Configure DATABASE_URL e SEFAZ_AMBIENTE.');
const db = createDatabase(process.env.DATABASE_URL);
try {
  const data = empresaSchema.parse({ nome: process.env.EMPRESA_NOME, cnpj: process.env.EMPRESA_CNPJ, ufAutor: process.env.EMPRESA_UF_AUTOR, certificadoPathEnv: process.env.EMPRESA_CERT_PATH_ENV || 'CERTIFICADO_PATH', certificadoSenhaEnv: process.env.EMPRESA_CERT_SENHA_ENV || 'CERTIFICADO_SENHA', ativa: process.env.EMPRESA_ATIVA === 'true' });
  let company;
  if (process.argv.includes('--atualizar')) {
    const existing = await db.prisma.empresa.findUniqueOrThrow({ where: { cnpj: data.cnpj } });
    if (existing.ambiente !== process.env.SEFAZ_AMBIENTE) throw new Error('Ambiente do cadastro não pode ser alterado.');
    const result = await db.withCompanyLock(existing.id, () => db.prisma.empresa.update({ where: { id: existing.id }, data }));
    if (!result.acquired) throw new Error('Empresa ocupada.');
    company = result.value;
  } else company = await cadastrarEmpresa(db.prisma, data, process.env.SEFAZ_AMBIENTE);
  console.log(JSON.stringify(publicEmpresa(company), null, 2));
} catch (error) { console.error(error.name === 'ZodError' ? 'Cadastro inválido. Verifique as variáveis EMPRESA_*.' : safeError(error)); process.exitCode = 1; }
finally { await db.close(); }
