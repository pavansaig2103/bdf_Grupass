const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { openDatabase, seedDatabase } = require('../app');

test('schema constraints protect direct SQL writes', t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name), ['gardeners', 'leases', 'plots']);
  assert.equal(seedDatabase(db), true);
  assert.equal(seedDatabase(db), false);
  assert.throws(() => db.prepare("INSERT INTO leases(gardener_id,plot_id,status) VALUES(1,2,'active')").run(), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
  assert.throws(() => db.prepare("INSERT INTO leases(gardener_id,plot_id,status) VALUES(999,1,'active')").run(), { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
  assert.throws(() => db.prepare("INSERT INTO leases(gardener_id,plot_id,status) VALUES(1,1,'invalid')").run(), { code: 'SQLITE_CONSTRAINT_CHECK' });
  assert.throws(() => db.prepare('DELETE FROM plots WHERE plot_id=2').run(), /FOREIGN KEY constraint failed/);
  db.prepare("UPDATE leases SET status='released' WHERE plot_id=2").run();
  db.prepare("INSERT INTO leases(gardener_id,plot_id,status) VALUES(1,2,'active')").run();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM leases WHERE plot_id=2').get().n, 3);
});

test('fresh disk database initializes, seeds and persists across restart', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seedshare-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'garden.db');
  let db = openDatabase(filename);
  assert.equal(seedDatabase(db), true);
  db.close();
  db = openDatabase(filename);
  try {
    assert.equal(seedDatabase(db), false);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM plots').get().n, 4);
  } finally { db.close(); }
});
