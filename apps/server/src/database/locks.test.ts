import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import { getConfig } from '../config.js'
import { useTestDatabase } from '../test/database.js'
import { db, poolSize } from './client.js'
import { trySessionLock, withSessionLock } from './locks.js'

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function* sources(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* sources(file)
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) yield file
  }
}

describe('session locks', () => {
  useTestDatabase()

  it('holds more locks than the pool has connections and leaves the pool free', async () => {
    const keys = Array.from({ length: poolSize() * 2 }, (_, index) => `test.locks.many:${index}`)
    const locks = await Promise.all(keys.map((key) => trySessionLock(key)))
    expect(locks.every(Boolean)).toBe(true)
    try {
      // As many statements at once as the pool has connections, each waiting until all of
      // them run: they get there only if no lock holder kept a pooled connection. The
      // activity view is a snapshot per transaction, hence the clearing; each stays a moment
      // after seeing the others, so the slower ones see it too.
      const barrier = sql.raw(`do $$ declare running int; begin
        for i in 1..250 loop
          perform pg_stat_clear_snapshot();
          select count(*) into running from pg_stat_activity where datname = current_database() and state = 'active'
            and query like '%squirmy-barrier%';
          if running >= ${poolSize()} then
            perform pg_sleep(0.3);
            return;
          end if;
          perform pg_sleep(0.02);
        end loop;
        raise exception 'only % of the pool ran at once', running;
      end $$ -- squirmy-barrier`)
      await Promise.all(Array.from({ length: poolSize() }, () => db.execute(barrier)))
      const [held] = await db.execute<{ count: number }>(sql`
        select count(*)::int as count from pg_locks l join pg_stat_activity a on a.pid = l.pid
        where l.locktype = 'advisory' and a.application_name = 'squirmy-locks' and a.datname = current_database()`)
      expect(held!.count).toBe(keys.length)
    } finally {
      await Promise.all(locks.map((lock) => lock!.release()))
    }
  })

  it('excludes a second holder in this process and in another', async () => {
    const key = 'test.locks.one'
    const other = postgres(getConfig().DATABASE_URL, { max: 1, onnotice: () => {} })
    try {
      const first = await trySessionLock(key)
      expect(first).not.toBeNull()
      // One session holds every lock here, and Postgres would grant it the key again.
      expect(await trySessionLock(key)).toBeNull()
      expect(await withSessionLock(key, async () => 'ran')).toEqual({ locked: false })
      const [elsewhere] = await other<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtext(${key})) as locked`
      expect(elsewhere!.locked).toBe(false)

      await first!.release()
      expect(await withSessionLock(key, async () => 'ran')).toEqual({ locked: true, value: 'ran' })
      const [freed] = await other<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtext(${key})) as locked`
      expect(freed!.locked).toBe(true)
      // Held by the other process now.
      expect(await trySessionLock(key)).toBeNull()
    } finally {
      await other.end()
    }
  })

  it('releases the lock when the work throws', async () => {
    const key = 'test.locks.throws'
    await expect(withSessionLock(key, async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(await withSessionLock(key, async () => 1)).toEqual({ locked: true, value: 1 })
  })

  /**
   * A connection reserved from the query pool for longer than a statement is how imports
   * deadlocked parallel acquisitions: each import held one while waiting for jobs that
   * needed one. Locks go through locks.ts; long work gets a client of its own.
   */
  it('is the only way the server keeps a pooled connection', async () => {
    const offenders: string[] = []
    for await (const file of sources(src)) {
      if (/getSql\(\)\s*\.reserve\(/.test(await readFile(file, 'utf8'))) offenders.push(path.relative(src, file))
    }
    expect(offenders).toEqual([])
  })
})
