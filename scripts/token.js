import 'dotenv/config';
import { SignJWT } from 'jose';
import { cnpjSchema } from '../src/utils/validation.js';

try {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error();
  const cnpjs = (process.env.TOKEN_CNPJS || '').split(',').map(c => cnpjSchema.parse(c.trim()));
  const scopes = (process.env.TOKEN_SCOPES || 'notas:ler').split(',').map(s => s.trim());
  const ttl = Number(process.env.TOKEN_TTL_SECONDS || 3600);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) throw new Error();
  const token = await new SignJWT({ cnpjs, scopes }).setProtectedHeader({ alg: 'HS256' }).setSubject(process.env.TOKEN_SUBJECT || 'operador-local').setIssuer(process.env.JWT_ISSUER || 'api-notas-fiscais').setAudience(process.env.JWT_AUDIENCE || 'api-notas-fiscais').setIssuedAt().setExpirationTime(`${ttl}s`).sign(new TextEncoder().encode(process.env.JWT_SECRET));
  console.log(token);
} catch { console.error('Configure JWT_SECRET, TOKEN_CNPJS, TOKEN_SCOPES e TOKEN_TTL_SECONDS válidos.'); process.exitCode = 1; }
