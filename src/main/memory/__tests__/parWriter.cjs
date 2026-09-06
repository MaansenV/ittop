// Test-only concurrent writer: CLI writes (vault entities) plus
// scratch-table churn through a held-open connection plus an EXPLICIT
// checkpoint call per iteration from a second connection (each invocation
// is logged as CKPT — execution proof; frame-level effect is proven
// separately in the deterministic checkpoint test). Separate process,
// like a live vault. Args: <db> <key> <count>. Prints READY, CKPT lines,
// DONE.
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const [db, key, countRaw] = process.argv.slice(2);
const count = Number(countRaw) || 15;
const cli = (...a) => execFileSync('perseus-vault', a, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
const w = new DatabaseSync(db);
w.exec('CREATE TABLE IF NOT EXISTS par_junk (i INTEGER)');
const c = new DatabaseSync(db);
console.log('READY');
for (let i = 1; i <= count; i++) {
  cli(
    'write',
    '--db',
    db,
    '--encryption-key',
    key,
    '--category',
    'decision',
    '--key',
    `par key ${i}`,
    '--body',
    JSON.stringify({ content: `par body ${i}` }),
  );
  w.prepare('INSERT INTO par_junk VALUES (?)').run(i);
  c.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  console.log('CKPT ' + i);
}
console.log('DONE');
w.close();
c.close();
