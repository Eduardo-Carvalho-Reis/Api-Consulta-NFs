import fs from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fromBER, ObjectIdentifier, OctetString } from 'asn1js';
import { AppError } from '../utils/errors.js';

export async function opensslPath(env = process.env) {
  if (env.OPENSSL_BIN) return env.OPENSSL_BIN;
  const gitOpenSsl = 'C:/Program Files/Git/usr/bin/openssl.exe';
  if (process.platform === 'win32' && await fs.access(gitOpenSsl).then(() => true, () => false)) return gitOpenSsl;
  return 'openssl';
}
function children(node) { return Array.isArray(node?.valueBlock?.value) ? node.valueBlock.value : []; }
function findOidParent(node, oid) {
  const nodes = children(node);
  if (nodes[0] instanceof ObjectIdentifier && nodes[0].valueBlock.toString() === oid) return nodes;
  for (const child of nodes) { const found = findOidParent(child, oid); if (found) return found; }
}
export function certificateCnpj(certificate) {
  const parsed = fromBER(certificate.raw);
  if (parsed.offset === -1) return null;
  const extension = findOidParent(parsed.result, '2.5.29.17');
  const octet = extension?.find(n => n instanceof OctetString);
  if (!octet) return null;
  const san = fromBER(octet.valueBlock.valueHexView);
  const otherName = findOidParent(san.result, '2.16.76.1.3.3');
  const strings = node => typeof node?.valueBlock?.value === 'string' ? [node.valueBlock.value] : children(node).flatMap(strings);
  return otherName?.slice(1).flatMap(strings).find(s => /^[A-Z\d]{12}\d{2}$/.test(s)) ?? null;
}
async function readLeafCertificate(filename, passphrase, env) {
  const binary = await opensslPath(env);
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, ['pkcs12', '-in', filename, '-clcerts', '-nokeys', '-passin', 'stdin'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let size = 0;
    const timeout = setTimeout(() => proc.kill(), 10000);
    proc.stdout.on('data', c => { size += c.length; if (size > 1024 * 1024) proc.kill(); else chunks.push(c); });
    proc.stderr.resume();
    proc.stdin.on('error', () => {});
    proc.on('error', () => reject(new AppError(503, 'OPENSSL_AUSENTE', 'OpenSSL 3 não encontrado. Configure OPENSSL_BIN.')));
    proc.on('close', code => {
      clearTimeout(timeout);
      const pem = Buffer.concat(chunks).toString().match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
      if (code !== 0 || !pem) reject(new AppError(503, 'CERTIFICADO_INVALIDO', 'Certificado A1 inválido, senha incorreta ou formato não suportado pelo OpenSSL 3.'));
      else { try { resolve(new X509Certificate(pem[0])); } catch { reject(new AppError(503, 'CERTIFICADO_INVALIDO', 'Certificado X.509 inválido.')); } }
    });
    // Password is sent through stdin, never a command argument or temporary file.
    proc.stdin.end(`${passphrase}\n`);
  });
}
export async function loadCertificate(empresa, env = process.env, now = new Date()) {
  const configuredPath = env[empresa.certificadoPathEnv];
  const passphrase = env[empresa.certificadoSenhaEnv];
  if (!configuredPath || passphrase === undefined) throw new AppError(503, 'CERTIFICADO_AUSENTE', 'Configure o arquivo A1 e o segredo da senha desta empresa.');
  if (/[\r\n]/.test(passphrase)) throw new AppError(503, 'CERTIFICADO_SENHA', 'Senha do A1 não pode conter quebra de linha.');
  const filename = path.resolve(configuredPath);
  let pfx;
  try { const stat = await fs.stat(filename); if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error(); pfx = await fs.readFile(filename); }
  catch { throw new AppError(503, 'CERTIFICADO_AUSENTE', 'Certificado A1 não encontrado ou inacessível.'); }
  try {
    const certificate = await readLeafCertificate(filename, passphrase, env);
    if (new Date(certificate.validTo) <= now) throw new AppError(503, 'CERTIFICADO_EXPIRADO', 'Certificado digital expirado. Substitua o A1.');
    if (new Date(certificate.validFrom) > now) throw new AppError(503, 'CERTIFICADO_INVALIDO', 'Certificado digital ainda não está válido.');
    const identity = certificateCnpj(certificate);
    if (!identity || identity.slice(0,8) !== empresa.cnpj.slice(0,8)) throw new AppError(503, 'CERTIFICADO_CNPJ', 'O CNPJ base do certificado não corresponde à empresa consultada.');
    if (!pfx.equals(await fs.readFile(filename))) throw new AppError(503, 'CERTIFICADO_ALTERADO', 'Certificado substituído durante a leitura. Repita a operação.');
    tls.createSecureContext({ pfx, passphrase, minVersion: 'TLSv1.2' });
    return { pfx, passphrase };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'CERTIFICADO_INVALIDO', 'Certificado A1 inválido, senha incorreta ou formato criptográfico não suportado.');
  }
}
