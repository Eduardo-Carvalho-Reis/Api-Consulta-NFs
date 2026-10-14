import { z } from 'zod';

export function validCnpj(value) {
  if (!/^[A-Z\d]{12}\d{2}$/.test(value) || /^(.)\1+$/.test(value)) return false;
  const digits = [...value].map(c => c.charCodeAt(0) - 48);
  for (const length of [12, 13]) {
    let weight = length - 7;
    let sum = 0;
    for (let i = 0; i < length; i++) {
      sum += digits[i] * weight;
      if (--weight === 1) weight = 9;
    }
    const rest = sum % 11;
    if (digits[length] !== (rest < 2 ? 0 : 11 - rest)) return false;
  }
  return true;
}

export const cnpjSchema = z.string().regex(/^[A-Z\d]{12}\d{2}$/).refine(validCnpj, 'CNPJ inválido');
export function validNumericChave(value) {
  if (!/^\d{44}$/.test(value)) return false;
  let sum = 0, weight = 2;
  for (let i = 42; i >= 0; i--) {
    sum += Number(value[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  return Number(value[43]) === (remainder < 2 ? 0 : 11 - remainder);
}
// The numeric modulus-11 rule must not be applied to new alphanumeric layouts.
export const chaveSchema = z.string().regex(/^\d{6}[A-Z\d]{12}\d{26}$/)
  .refine(value => /[A-Z]/.test(value) || validNumericChave(value), 'Dígito verificador da chave inválido');
export const ufSchema = z.enum(['11','12','13','14','15','16','17','21','22','23','24','25','26','27','28','29','31','32','33','35','41','42','43','50','51','52','53']);
export const envName = z.string().regex(/^[A-Z][A-Z0-9_]{2,99}$/);
export const empresaSchema = z.object({
  nome: z.string().trim().min(2).max(120), cnpj: cnpjSchema, ufAutor: ufSchema,
  certificadoPathEnv: envName, certificadoSenhaEnv: envName, ativa: z.boolean().default(false),
}).strict();
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s);
export const pagination = {
  pagina: z.coerce.number().int().min(1).max(100000).default(1),
  limite: z.coerce.number().int().min(1).max(100).default(20),
};
export const listSchema = z.object({
  ...pagination, inicio: dateOnly.optional(), fim: dateOnly.optional(),
  emitente: cnpjSchema.optional(), numero: z.string().regex(/^\d{1,9}$/).optional(),
  chave: chaveSchema.optional(), status: z.enum(['RESUMO', 'XML_DISPONIVEL', 'DANFE_DISPONIVEL', 'ERRO_DANFE']).optional(),
  ordem: z.enum(['asc', 'desc']).default('desc'),
}).strict().refine(v => !v.inicio || !v.fim || v.inicio <= v.fim, 'Período inválido');
export const historySchema = z.object({ ...pagination, status: z.enum(['PENDENTE','EXECUTANDO','CONCLUIDA','COM_ERROS','FALHOU','ADIADA']).optional() }).strict();
export const nsuSchema = z.string().regex(/^\d{15}$/);
export const executionIdSchema = z.uuid();
