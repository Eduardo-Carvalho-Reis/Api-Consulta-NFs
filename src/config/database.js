import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

export function createDatabase(url) {
  const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 10000 });
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 10, connectionTimeoutMillis: 10000 }) });
  // Session locks survive transactions but release automatically when the process/connection dies.
  async function withCompanyLock(id, fn) {
    const client = await pool.connect();
    let lost = false;
    const onError = () => { lost = true; };
    client.on('error', onError);
    let locked = false;
    try {
      const result = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [id]);
      locked = result.rows[0].locked;
      if (!locked) return { acquired: false };
      const assertLock = async () => {
        if (lost) throw new Error('Database lock connection lost');
        await client.query('SELECT 1');
      };
      return { acquired: true, value: await fn(assertLock) };
    } finally {
      if (locked && !lost) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [id]).catch(() => { lost = true; });
      client.removeListener('error', onError);
      client.release(lost);
    }
  }
  return { prisma, withCompanyLock, close: async () => { await prisma.$disconnect(); await pool.end(); } };
}
