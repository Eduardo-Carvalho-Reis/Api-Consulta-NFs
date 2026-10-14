import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../utils/errors.js';

export const hash = data => createHash('sha256').update(data).digest('hex');
export const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
export function normalizeName(name) {
  let value = name.normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '').slice(0, 80).replace(/[. ]+$/g, '');
  if (!value || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)) value = `Empresa ${value || 'sem nome'}`;
  return value;
}
export function notePaths(empresa, nota, suffix = '') {
  if (!/^\d{4}-(0[1-9]|1[0-2])-\d{2}T/.test(nota.emissaoOriginal) || !/^\d{1,9}$/.test(nota.numero)) throw new AppError(422, 'DADOS_ARQUIVO_INVALIDOS', 'Data de emissão ou número inválido.');
  if (suffix && !/^[A-Z\d]{44}$/.test(suffix)) throw new AppError(422, 'CHAVE_INVALIDA', 'Chave de acesso inválida.');
  const year = nota.emissaoOriginal.slice(0, 4);
  const month = nota.emissaoOriginal.slice(5, 7);
  const base = `${normalizeName(empresa.nome)} - NF ${nota.numero}${suffix ? ` - ${suffix}` : ''}`;
  const folder = `${empresa.pasta}/${year}/${month}- ${meses[Number(month) - 1]}`;
  return { xml: `${folder}/xml/${base}.xml`, pdf: `${folder}/pdf/${base}.pdf` };
}

export function assertNotePath(empresa, relative, kind) {
  const parts = typeof relative === 'string' ? relative.split('/') : [];
  const month = Number(parts[2]?.slice(0, 2));
  if (!['xml', 'pdf'].includes(kind) || parts.length !== 5 || parts[0] !== empresa.pasta ||
      !/^\d{4}$/.test(parts[1]) || month < 1 || month > 12 ||
      parts[2] !== `${String(month).padStart(2, '0')}- ${meses[month - 1]}` ||
      parts[3] !== kind || !parts[4].endsWith(`.${kind}`)) {
    throw new AppError(403, 'ARQUIVO_NAO_AUTORIZADO', 'Arquivo fora da estrutura autorizada desta empresa.');
  }
}

export class StorageService {
  constructor(root) { this.root = path.resolve(root); }
  async init() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(this.root)).isSymbolicLink()) throw new Error('Storage root cannot be a symlink');
    this.root = await fs.realpath(this.root);
  }
  async resolve(relative, create = false) {
    if (typeof relative !== 'string' || relative.includes('\\') || relative.includes(':') || path.isAbsolute(relative) || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new AppError(400, 'CAMINHO_INVALIDO', 'Caminho de arquivo inválido.');
    const absolute = path.resolve(this.root, relative);
    if (!absolute.startsWith(this.root + path.sep)) throw new AppError(400, 'CAMINHO_INVALIDO', 'Caminho de arquivo inválido.');
    const parts = relative.split('/');
    let current = this.root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      if (create && i < parts.length - 1) await fs.mkdir(current, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
      const stat = await fs.lstat(current).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (stat?.isSymbolicLink() || (i < parts.length - 1 && stat && !stat.isDirectory())) throw new AppError(403, 'CAMINHO_INSEGURO', 'O armazenamento contém um caminho inseguro.');
    }
    return absolute;
  }
  async read(relative, expectedHash) {
    const filename = await this.resolve(relative);
    const data = await fs.readFile(filename).catch(e => { if (e.code === 'ENOENT') throw new AppError(404, 'ARQUIVO_AUSENTE', 'Arquivo não localizado no armazenamento.'); throw e; });
    if (expectedHash && hash(data) !== expectedHash) throw new AppError(409, 'INTEGRIDADE', 'A integridade do arquivo não confere.');
    return data;
  }
  async readNote(empresa, relative, kind, expectedHash) {
    assertNotePath(empresa, relative, kind);
    return this.read(relative, expectedHash);
  }
  async ensureNoteDirectories(empresa, nota) {
    const targets = notePaths(empresa, nota);
    // Only called after validating a complete invoice; no unused months are created.
    await this.resolve(targets.xml, true);
    await this.resolve(targets.pdf, true);
  }
  async save(relative, data, replaceHash = null) {
    const filename = await this.resolve(relative, true);
    const digest = hash(data);
    const existing = await fs.readFile(filename).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (existing) {
      if (hash(existing) === digest) return digest;
      if (!replaceHash || hash(existing) !== replaceHash) throw new AppError(409, 'COLISAO_ARQUIVO', 'Já existe outro conteúdo neste caminho.');
    }
    const temporary = `${filename}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      if (existing && replaceHash) await fs.rename(temporary, filename);
      else {
        try { await fs.link(temporary, filename); }
        catch (e) {
          if (e.code !== 'EEXIST') throw e;
          if (hash(await fs.readFile(filename)) !== digest) throw new AppError(409, 'COLISAO_ARQUIVO', 'Já existe outro conteúdo neste caminho.');
        }
      }
    } finally { await fs.unlink(temporary).catch(() => {}); }
    return digest;
  }
}
