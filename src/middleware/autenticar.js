import { jwtVerify } from 'jose';
import { cnpjSchema } from '../utils/validation.js';
import { AppError } from '../utils/errors.js';

export function autenticar(config) {
  return async (req, res, next) => {
    try {
      const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(req.headers.authorization ?? '');
      if (!match) throw new Error();
      const { payload } = await jwtVerify(match[1], new TextEncoder().encode(config.JWT_SECRET), { algorithms: ['HS256'], issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE, requiredClaims: ['exp', 'sub', 'iat'] });
      if (!Array.isArray(payload.cnpjs) || !payload.cnpjs.length || payload.cnpjs.some(c => !cnpjSchema.safeParse(c).success) || !Array.isArray(payload.scopes) || payload.scopes.some(s => typeof s !== 'string')) throw new Error();
      req.auth = payload; next();
    } catch { next(new AppError(401, 'NAO_AUTENTICADO', 'Token ausente, inválido ou expirado.')); }
  };
}
export function requireScope(scope) {
  return (req, res, next) => req.auth.scopes.includes(scope) ? next() : next(new AppError(403, 'SEM_ESCOPO', 'Token sem permissão para esta operação.'));
}
export function authorizeCompany(prisma) {
  return async (req, res, next) => {
    const selected = req.get('X-Empresa-CNPJ') ?? (req.auth.cnpjs.length === 1 ? req.auth.cnpjs[0] : null);
    if (!selected) throw new AppError(400, 'EMPRESA_OBRIGATORIA', 'Informe X-Empresa-CNPJ para selecionar a empresa.');
    cnpjSchema.parse(selected);
    if (!req.auth.cnpjs.includes(selected)) throw new AppError(403, 'EMPRESA_NAO_AUTORIZADA', 'Token não autorizado para esta empresa.');
    req.empresa = await prisma.empresa.findUnique({ where: { cnpj: selected } });
    if (!req.empresa) throw new AppError(404, 'EMPRESA_NAO_ENCONTRADA', 'Empresa não cadastrada.');
    next();
  };
}
