import { normalizeName } from '../services/storageService.js';
import { empresaSchema } from '../utils/validation.js';
import { AppError } from '../utils/errors.js';

export async function cadastrarEmpresa(prisma, input, ambiente) {
  const data = empresaSchema.parse(input);
  const existing = await prisma.empresa.findUnique({ where: { cnpj: data.cnpj } });
  if (existing) throw new AppError(409, 'EMPRESA_EXISTENTE', 'CNPJ já cadastrado. Use a atualização de cadastro.');
  const base = normalizeName(data.nome);
  for (const pasta of [base, `${base} - ${data.cnpj}`]) {
    try {
      return await prisma.empresa.create({ data: { ...data, ambiente, pasta, pastaNormalizada: pasta.normalize('NFKC').toLocaleLowerCase('pt-BR'), controle: { create: {} } } });
    } catch (error) { if (error.code !== 'P2002') throw error; }
  }
  throw new AppError(409, 'PASTA_EXISTENTE', 'CNPJ ou pasta já cadastrados.');
}
export const publicEmpresa = empresa => ({ id: empresa.id, cnpj: empresa.cnpj, nome: empresa.nome, ativa: empresa.ativa, ambiente: empresa.ambiente, ufAutor: empresa.ufAutor, ultimaSincronizacao: empresa.ultimaSincronizacao });
