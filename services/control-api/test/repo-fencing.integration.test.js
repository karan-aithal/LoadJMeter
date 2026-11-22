'use strict';

// Real-Postgres check of the fencing SQL (mocks can't prove it). Runs in a throwaway schema, skipped without
// TEST_DATABASE_URL:  TEST_DATABASE_URL=postgres://... npx jest test/repo-fencing
const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;

d('test-run-repo fencing (postgres)', () => {
  const fs = require('fs');
  const path = require('path');
  const { Client } = require('pg');
  const schema = `fence_test_${process.pid}`;
  let admin; let repo; let pool;
  const OLD = '2000-01-01T00:00:00Z';

  async function seed(id, status = 'running', epoch = 1, updatedAt = OLD) {
    await admin.query(
      `INSERT INTO ${schema}.test_runs (id, idempotency_key, status, config, epoch, updated_at)
       VALUES ($1::uuid, $1::text, $2, '{}', $3, $4)`, [id, status, epoch, updatedAt]);
  }
  const uuid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

  beforeAll(async () => {
    admin = new Client({ connectionString: URL }); await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}, public`);
    for (const f of ['001_init.sql', '002_test_runs.sql', '004_fencing_epoch.sql']) { // 001 creates uuid-ossp, which 002 needs
      await admin.query(fs.readFileSync(path.join(__dirname, '../migrations', f), 'utf8'));
    }
    // repo uses the shared pool: point it at the throwaway schema
    const sep = URL.includes('?') ? '&' : '?';
    process.env.DATABASE_URL = `${URL}${sep}options=-csearch_path%3D${schema}%2Cpublic`;
    pool = require('../src/db/client');
    repo = require('../src/db/repositories/test-run-repo');
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it('accepts the current owner and rejects an older epoch', async () => {
    const id = uuid(1); await seed(id, 'running', 2);
    expect(await repo.updateStatus(id, { workerId: 'w', epoch: 1 })).toBeNull();          // stale
    expect((await repo.updateStatus(id, { workerId: 'w', epoch: 2 })).worker_id).toBe('w'); // owner
    expect((await repo.updateStatus(id, { workerId: 'w', epoch: 3 })).epoch).toBe(3);      // newer owner raises epoch
    expect(await repo.updateStatus(id, { workerId: 'w', epoch: 2 })).toBeNull();           // now stale
  });

  it('unfenced callers still work, and terminal rows are immutable', async () => {
    const id = uuid(2); await seed(id, 'running', 5);
    expect((await repo.updateStatus(id, { status: 'completed' })).status).toBe('completed');
    expect(await repo.updateStatus(id, { status: 'running', epoch: 9 })).toBeNull();
    expect(await repo.cancel(id)).toBeNull();
  });

  it('nextEpoch fences the writer itself (worker re-queueing its own retry)', async () => {
    const id = uuid(3); await seed(id, 'running', 1);
    const row = await repo.updateStatus(id, { status: 'pending', epoch: 1, nextEpoch: 2 });
    expect(row.epoch).toBe(2);
    expect(await repo.updateStatus(id, { status: 'completed', epoch: 1 })).toBeNull();
  });

  it('claimStale fences the old owner and queues nothing if the worker got there first', async () => {
    const id = uuid(4); await seed(id, 'running', 1);
    const cutoff = new Date().toISOString();
    const claimed = await repo.claimStale(id, { newEpoch: 2, cutoff, errorMessage: 'lost' });
    expect(claimed).toMatchObject({ status: 'pending', epoch: 2 });
    expect(await repo.updateStatus(id, { status: 'completed', epoch: 1 })).toBeNull(); // stale worker fenced
    expect(await repo.claimStale(id, { newEpoch: 2, cutoff, errorMessage: 'x' })).toBeNull(); // not claimed twice

    const done = uuid(5); await seed(done, 'running', 1);
    await repo.updateStatus(done, { status: 'completed', epoch: 1 });          // worker won the race
    expect(await repo.claimStale(done, { newEpoch: 2, cutoff, errorMessage: 'x' })).toBeNull();

    const fresh = uuid(6); await seed(fresh, 'running', 1, new Date().toISOString());
    expect(await repo.claimStale(fresh, { newEpoch: 2, cutoff: OLD, errorMessage: 'x' })).toBeNull(); // heartbeated
  });

  it('claimStale recovers a pending row (popped, worker died before reporting running)', async () => {
    const id = uuid(8); await seed(id, 'pending', 0);
    expect(await repo.claimStale(id, { newEpoch: 2, cutoff: OLD, errorMessage: 'lost' })).toMatchObject({ status: 'pending', epoch: 2 });
  });

  it('claimStale with dead marks the run failed atomically', async () => {
    const id = uuid(7); await seed(id, 'running', 3);
    const row = await repo.claimStale(id, { newEpoch: 4, cutoff: new Date().toISOString(), errorMessage: 'lost',
      dead: true, completedAt: new Date().toISOString() });
    expect(row).toMatchObject({ status: 'failed', verdict: 'FAIL', epoch: 4 });
    expect(row.completed_at).not.toBeNull();
  });
});
