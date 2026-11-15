// 1. Imports and configuration
require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

// 2. Express application initialization
function initializeExpressApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));
  app.get('/health', (req, res) => res.json({ message: 'SeedShare Garden API is running' }));
  return app;
}

// 3. SQLite database connection
function openDatabase(filename = process.env.DB_PATH || 'database/seedshare.db') {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  return db;
}

// 4. Database schema initialization
const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS gardeners (
  gardener_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK(length(trim(email)) > 0),
  phone TEXT
);
CREATE TABLE IF NOT EXISTS plots (
  plot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK(length(trim(name)) > 0),
  soil TEXT NOT NULL CHECK(length(trim(soil)) > 0)
);
CREATE TABLE IF NOT EXISTS leases (
  lease_id INTEGER PRIMARY KEY AUTOINCREMENT,
  gardener_id INTEGER NOT NULL REFERENCES gardeners(gardener_id) ON DELETE RESTRICT,
  plot_id INTEGER NOT NULL REFERENCES plots(plot_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('active', 'released')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- Released history remains unrestricted; allocation is protected even outside the API.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_lease_per_plot ON leases(plot_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS leases_gardener ON leases(gardener_id);
`;
function initializeSchema(db) {
  db.exec(SCHEMA_SQL);
}

// 5. Database seed data (explicit initialization only; existing data is preserved)
const SEED_SQL = `INSERT INTO gardeners (name, email, phone) VALUES
('Pavan', 'pavan@example.com', '9876543210'),
('Asha Rao', 'asha@example.com', '9876543211'),
('Neha Shah', 'neha@example.com', NULL);
INSERT INTO plots (name, soil) VALUES
('Plot C', 'sandy'), ('Plot A', 'clay'), ('Plot B', 'loam'), ('Plot D', 'clay');
INSERT INTO leases (gardener_id, plot_id, status) VALUES
(1, 2, 'released'), (2, 2, 'active'), (3, 3, 'active');
`;
function seedDatabase(db) {
  // Never append sample records to an existing user's database.
  const populated = ['gardeners', 'plots', 'leases'].some(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
  if (populated) return false;
  db.transaction(() => db.exec(SEED_SQL))();
  return true;
}

// 6. Reusable validation functions
function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}
function validateId(value, field = 'id') {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) fail(`${field} must be a positive integer`);
  return Number(value);
}
function validateBody(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Request body must be a JSON object');
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('Request body contains unknown fields');
}
function validateText(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a non-empty string`);
  return value.trim();
}
function validateGardener(value) {
  validateBody(value, ['name', 'email', 'phone']);
  const name = validateText(value.name, 'name');
  const email = validateText(value.email, 'email').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('email must be a valid email address');
  const phone = value.phone == null ? null : validateText(value.phone, 'phone');
  return { name, email, phone };
}
function validatePlot(value) {
  validateBody(value, ['name', 'soil']);
  return { name: validateText(value.name, 'name'), soil: validateText(value.soil, 'soil').toLowerCase() };
}
function validateLease(value) {
  validateBody(value, ['gardener_id', 'plot_id', 'status']);
  if (!['active', 'released'].includes(value.status)) fail('status must be active or released');
  return { gardener_id: validateId(value.gardener_id, 'gardener_id'), plot_id: validateId(value.plot_id, 'plot_id'), status: value.status };
}

// 7. Error handling helpers
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  let status = err.status || 500;
  let message = err.message;
  if (err.type === 'entity.parse.failed') { status = 400; message = 'Malformed JSON body'; }
  else if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    status = 409;
    message = err.message.includes('leases.plot_id') ? 'Plot already has an active lease'
      : err.message.includes('gardeners.email') ? 'Email already exists' : 'Plot name already exists';
  } else if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || (err.code === 'SQLITE_CONSTRAINT_TRIGGER' && err.message === 'FOREIGN KEY constraint failed')) {
    status = 409; message = 'Cannot delete a gardener or plot referenced by lease history';
  } else if (err.code?.startsWith('SQLITE_CONSTRAINT')) {
    status = 400; message = 'Database constraint validation failed';
  }
  if (status >= 500) { console.error(err); message = 'Internal server error'; }
  res.status(status).json({ error: message });
}
function createApp(db) {
  const app = initializeExpressApp();

  // 8. Gardener CRUD endpoints
  {
    const findGardener = value => {
      const row = db.prepare('SELECT * FROM gardeners WHERE gardener_id = ?').get(validateId(value));
      if (!row) fail('Gardener not found', 404);
      return row;
    };
    const handlers = {
      list: (req, res) => res.json(db.prepare('SELECT * FROM gardeners ORDER BY gardener_id').all()),
      get: (req, res) => res.json(findGardener(req.params.id)),
      create: (req, res) => {
        const data = validateGardener(req.body);
        const result = db.prepare('INSERT INTO gardeners (name, email, phone) VALUES (@name, @email, @phone)').run(data);
        res.status(201).json(findGardener(result.lastInsertRowid));
      },
      update: (req, res) => {
        const old = findGardener(req.params.id);
        const data = validateGardener(req.body);
        db.prepare('UPDATE gardeners SET name=@name, email=@email, phone=@phone WHERE gardener_id=@id').run({ ...data, id: old.gardener_id });
        res.json(findGardener(old.gardener_id));
      },
      remove: (req, res) => {
        const old = findGardener(req.params.id);
        db.prepare('DELETE FROM gardeners WHERE gardener_id=?').run(old.gardener_id);
        res.json({ message: 'Gardener deleted' });
      }
    };
    app.route('/gardeners').get(handlers.list).post(handlers.create);
    app.route('/gardeners/:id').get(handlers.get).put(handlers.update).delete(handlers.remove);
  }

  // 9. Plot CRUD endpoints
  {
    const findPlot = value => {
      const row = db.prepare('SELECT * FROM plots WHERE plot_id=?').get(validateId(value));
      if (!row) fail('Plot not found', 404);
      return row;
    };
    const handlers = {
      // 10. Soil search and sorting
      list: (req, res) => {
        const { sort, order = 'asc', soil } = req.query;
        if (sort !== undefined && sort !== 'name') fail('Cannot sort by that field');
        if (!['asc', 'desc'].includes(order)) fail('order must be asc or desc');
        const params = [];
        let sql = 'SELECT * FROM plots';
        if (soil !== undefined) { sql += ' WHERE soil = ? COLLATE NOCASE'; params.push(validateText(soil, 'soil')); }
        // Identifiers and direction come only from fixed, validated choices.
        sql += sort === 'name' ? ` ORDER BY name COLLATE NOCASE ${order === 'asc' ? 'ASC' : 'DESC'}, plot_id ASC` : ' ORDER BY plot_id ASC';
        res.json(db.prepare(sql).all(...params));
      },
      get: (req, res) => res.json(findPlot(req.params.id)),
      create: (req, res) => {
        const result = db.prepare('INSERT INTO plots (name, soil) VALUES (@name, @soil)').run(validatePlot(req.body));
        res.status(201).json(findPlot(result.lastInsertRowid));
      },
      update: (req, res) => {
        const old = findPlot(req.params.id);
        db.prepare('UPDATE plots SET name=@name, soil=@soil WHERE plot_id=@id').run({ ...validatePlot(req.body), id: old.plot_id });
        res.json(findPlot(old.plot_id));
      },
      remove: (req, res) => {
        const old = findPlot(req.params.id);
        db.prepare('DELETE FROM plots WHERE plot_id=?').run(old.plot_id);
        res.json({ message: 'Plot deleted' });
      }
    };
    app.route('/plots').get(handlers.list).post(handlers.create);
    app.route('/plots/:id').get(handlers.get).put(handlers.update).delete(handlers.remove);
  }

  // 11. Lease CRUD endpoints
  {
    const findLease = value => {
      const row = db.prepare('SELECT * FROM leases WHERE lease_id=?').get(validateId(value));
      if (!row) fail('Lease not found', 404);
      return row;
    };
    const validateLeaseReferences = body => {
      const data = validateLease(body);
      if (!db.prepare('SELECT 1 FROM gardeners WHERE gardener_id=?').get(data.gardener_id)) fail('Gardener not found', 404);
      if (!db.prepare('SELECT 1 FROM plots WHERE plot_id=?').get(data.plot_id)) fail('Plot not found', 404);
      return data;
    };
    const handlers = {
      list: (req, res) => res.json(db.prepare('SELECT * FROM leases ORDER BY lease_id').all()),
      get: (req, res) => res.json(findLease(req.params.id)),
      create: (req, res) => {
        const result = db.prepare('INSERT INTO leases (gardener_id, plot_id, status) VALUES (@gardener_id, @plot_id, @status)').run(validateLeaseReferences(req.body));
        res.status(201).json(findLease(result.lastInsertRowid));
      },
      update: (req, res) => {
        const old = findLease(req.params.id);
        db.prepare('UPDATE leases SET gardener_id=@gardener_id, plot_id=@plot_id, status=@status WHERE lease_id=@id').run({ ...validateLeaseReferences(req.body), id: old.lease_id });
        res.json(findLease(old.lease_id));
      },
      remove: (req, res) => {
        const old = findLease(req.params.id);
        db.prepare('DELETE FROM leases WHERE lease_id=?').run(old.lease_id);
        res.json({ message: 'Lease deleted' });
      }
    };
    app.route('/leases').get(handlers.list).post(handlers.create);

    // 12. SQL JOIN endpoint (registered before /:id)
    app.get('/leases/join', (req, res) => res.json(db.prepare(`SELECT l.lease_id, g.name AS gardener_name,
      p.name AS plot_name, p.soil, l.status FROM leases l
      JOIN gardeners g ON g.gardener_id=l.gardener_id
      JOIN plots p ON p.plot_id=l.plot_id ORDER BY l.lease_id`).all()));
    app.route('/leases/:id').get(handlers.get).put(handlers.update).delete(handlers.remove);
  }

  // 13. Not-found handler and centralized error middleware
  app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
  app.use(errorHandler);
  return app;
}

// 14. Server startup and explicit database initialization command
if (require.main === module) {
  const db = openDatabase();
  if (process.argv.includes('--init-db')) {
    console.log(seedDatabase(db) ? 'Database initialized with sample data.' : 'Database initialized; existing data preserved.');
    db.close();
  } else {
    const server = createApp(db).listen(process.env.PORT || 3000);
    server.once('listening', () => console.log(`SeedShare Garden API listening on port ${server.address().port}`));
    server.on('error', err => { console.error(err.message); db.close(); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
  }
}
module.exports = { createApp, openDatabase, seedDatabase };
