# SeedShare Garden

A single-file CommonJS backend for allocating community garden plots, tracking soil and preserving lease history. It replaces word-of-mouth allocations with a relational database that prevents two active leases on the same plot.

## Quick start

Install a supported Node.js release (Node 24 LTS is a suitable baseline), npm and Git. SQLite is bundled by better-sqlite3; no separate database server is needed.

```sh
npm install
```

Copy `.env.example` to `.env` (PowerShell: `Copy-Item .env.example .env`; macOS/Linux: `cp .env.example .env`), then:

```sh
npm run db:init
npm start
```

On Windows with script execution disabled, use `npm.cmd` instead of `npm` for all commands. The project `.npmrc` disables dependency install hooks: better-sqlite3 13 includes native prebuilt binaries, so no compiler is required on supported platforms. Explicit commands such as `npm start` and `npm test` still run normally. For a platform without a bundled binary, install C++ build tools and explicitly rebuild with `npm rebuild better-sqlite3 --ignore-scripts=false`.

The server defaults to `http://localhost:3000`. `GET /health` returns:

```json
{"message":"SeedShare Garden API is running"}
```

`npm run dev` starts nodemon. `npm test` runs isolated HTTP and database tests using Node's built-in test runner, without changing development data.

If port 3000 is already occupied, stop the other server or use a temporary port in PowerShell: `$env:PORT='3001'; npm.cmd run dev`. Set Postman's `baseUrl` to `http://localhost:3001` when using that port.

## Configuration and initialization

| Variable | Default | Purpose |
| --- | --- | --- |
| PORT | 3000 | HTTP port |
| DB_PATH | database/seedshare.db | SQLite file, relative to working directory, or absolute |
| NODE_ENV | development | Runtime environment |

Run commands from the project root. Starting the application creates the directory and schema if missing, but does not insert demo data. `npm run db:init` also inserts sample gardeners, plots and leases only when **all three tables are empty**. Repeating initialization preserves existing records. `.env` and database files are ignored by Git.

## Features and stack

Node.js, Express, better-sqlite3, SQLite, cors, dotenv and nodemon. The API provides full CRUD for gardeners, plots and leases; case-insensitive soil search; deterministic plot sorting; SQL JOIN output; validation and centralized JSON errors. No frontend or ORM is required.

## Project structure

```text
SeedShare-Garden/
  app.js
  database/seedshare.db
  tests/api.test.js
  tests/database.test.js
  postman/SeedShare.postman_collection.json
  .npmrc
  .env.example
  .gitignore
  package.json
  package-lock.json
  README.md
```

All backend logic lives in `app.js`: Express configuration, SQLite connection, embedded schema and seeds, validation, CRUD routes, filtering, sorting, JOIN, errors and startup. Tests import `createApp`, `openDatabase` and `seedDatabase` from this file; importing it does not open a database or start a server. `npm run db:init` executes `node app.js --init-db`.

The existing `database/seedshare.db` name and `.env` path are retained to preserve your data. You can configure another filename with `DB_PATH`. The obsolete `backups/before-single-file/` copy was removed after both versions passed their tests and their schema and sample data were compared. The Postman generator is a development utility, not part of the running backend.

## Database architecture

There are exactly three application tables (SQLite also maintains its internal `sqlite_sequence` for autoincrement IDs).

| Table | Columns |
| --- | --- |
| gardeners | gardener_id INTEGER primary key autoincrement, name TEXT required, email TEXT required unique case-insensitively, phone TEXT optional |
| plots | plot_id INTEGER primary key autoincrement, name TEXT required unique case-insensitively, soil TEXT required |
| leases | lease_id INTEGER primary key autoincrement, gardener_id INTEGER required foreign key, plot_id INTEGER required foreign key, status TEXT active/released, created_at DATETIME default current timestamp |

A gardener has many leases, and a plot has many historical leases. Each lease references one gardener and one plot. Foreign keys are enabled on every connection. Deleting a referenced gardener or plot returns 409, including when leases are released.

```sql
CREATE UNIQUE INDEX one_active_lease_per_plot
ON leases(plot_id) WHERE status = 'active';
```

The partial unique index enforces the allocation rule within SQLite, including concurrent writes and direct SQL. Released records remain in history and do not prevent a new active lease. Updating a lease to another occupied plot or reactivating conflicting history also returns 409.

## API reference

Use `Content-Type: application/json` for writes. Lists return JSON arrays directly. Creates return the created row with its generated ID (201); reads and updates return rows (200); deletes return `{"message":"Plot deleted"}` or the corresponding resource name (200).

| Method | Endpoint | Behavior |
| --- | --- | --- |
| GET | /health | Health check |
| GET | /gardeners | List gardeners |
| GET | /gardeners/:id | Get gardener |
| POST | /gardeners | Create gardener |
| PUT | /gardeners/:id | Replace editable gardener fields |
| DELETE | /gardeners/:id | Delete unreferenced gardener |
| GET | /plots | List, filter and sort plots |
| GET | /plots/:id | Get plot |
| POST | /plots | Create plot |
| PUT | /plots/:id | Replace name and soil |
| DELETE | /plots/:id | Delete unreferenced plot |
| GET | /leases | List leases including history |
| GET | /leases/join | Joined lease, gardener and plot information |
| GET | /leases/:id | Get lease |
| POST | /leases | Create lease |
| PUT | /leases/:id | Replace gardener_id, plot_id and status |
| DELETE | /leases/:id | Explicitly delete a lease record |

Request bodies (also required in full for PUT):

```json
{"name":"Pavan","email":"pavan@example.com","phone":"9876543210"}
```

```json
{"name":"Plot E","soil":"clay"}
```

```json
{"gardener_id":1,"plot_id":1,"status":"active"}
```

Phone may be omitted or null. Omitting it in a gardener PUT clears it. Soil is free text, trimmed and stored lowercase; there is no controlled soil vocabulary. IDs must be positive safe integers. Email and plot names are unique without ASCII case sensitivity. Unknown write fields are rejected, including generated IDs and timestamps.

Example PowerShell request:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/plots -ContentType application/json -Body '{"name":"Plot E","soil":"clay"}'
```

Example response on a freshly seeded database:

```json
{"plot_id":5,"name":"Plot E","soil":"clay"}
```

## Sorting and soil search

| Query | Result |
| --- | --- |
| /plots?sort=name&order=asc | 200, names A to Z |
| /plots?sort=name&order=desc | 200, names Z to A |
| /plots?sort=colour | 400, exact error below |
| /plots?soil=CLAY | Case-insensitive exact soil matches |
| /plots?soil=clay&sort=name&order=desc | Filtered list sorted descending |

```json
{"error":"Cannot sort by that field"}
```

Only `name` is an allowed sorting field. `order` accepts lowercase `asc` or `desc`, defaults to `asc`, and invalid orders return 400. Without `sort`, rows are ordered by ID. Name sorting uses SQLite NOCASE with ID as a stable secondary key. Soil search uses a bound parameter and returns `[]` when unmatched. SQLite NOCASE supports ASCII case folding; full Unicode linguistic sorting is outside this assignment.

## JOIN endpoint

`GET /leases/join` executes an actual three-table SQL JOIN:

```sql
SELECT l.lease_id, g.name AS gardener_name,
       p.name AS plot_name, p.soil, l.status
FROM leases l
JOIN gardeners g ON g.gardener_id = l.gardener_id
JOIN plots p ON p.plot_id = l.plot_id
ORDER BY l.lease_id;
```

Example row in the returned array:

```json
{"lease_id":1,"gardener_name":"Pavan","plot_name":"Plot A","soil":"clay","status":"released"}
```

Empty databases return `[]`.

## Validation and errors

All errors have the shape `{"error":"message"}`. Required strings cannot be blank. Email syntax, IDs, lease statuses, JSON bodies and referenced resources are validated. SQL values use prepared parameters; sorting identifiers and direction use fixed allowlisted SQL fragments. Unexpected errors are logged on the server and return a generic message without stack traces.

| Status | Meaning |
| --- | --- |
| 200 | Successful read, update or deletion |
| 201 | Created |
| 400 | Invalid fields, body, JSON, ID, sort or order |
| 404 | Resource, referenced gardener/plot, or route missing |
| 409 | Duplicate email/name, occupied plot, or deletion blocked by lease history |
| 413 | Request body exceeds 100 KB |
| 500 | Unexpected server error |

Releasing a lease uses PUT with `status: "released"` and preserves its ID and timestamp. DELETE is provided for explicit record correction and permanently removes history, so use release for normal termination.

## Tests and Postman

```sh
npm test
```

Tests exercise all CRUD routes, the three required twist cases, search with sorting, invalid JSON and IDs, validation, duplicate constraints, JOIN aliases, release/reallocation, conflicting updates and foreign-key history restrictions. Database tests exercise direct SQL enforcement and fresh disk initialization with restart persistence. Each test uses its own in-memory database or automatically cleaned temporary directory.

Import `postman/SeedShare.postman_collection.json` into Postman. The collection includes a `baseUrl` variable, defaulting to `http://localhost:3000`, and captures created resource IDs automatically. Start the API, then run the collection in its listed order using Collection Runner. It creates unique demo records, checks sorting and conflicts, releases a lease, reallocates, and deletes its own records. The timestamp suffix makes repeated complete runs independent. A stopped run can leave demo records behind; use the API to inspect and clean them up.

### Run every Postman request together

1. In a terminal in this project, run `npm.cmd run db:init`, then `npm.cmd run dev`. Keep that terminal running. Initialization preserves existing records.
2. In Postman, click **Import**, choose **Files**, and select `postman/SeedShare.postman_collection.json`.
3. Open the imported **SeedShare Garden** collection and its **Variables** tab. Set `baseUrl` to the address printed by the server, normally `http://localhost:3000`, and save.
4. Click **Run collection** (or the collection menu, then **Run**). Select all 26 requests, keep their existing order, choose one iteration, and start the run. Do not enable parallel request execution because later requests use IDs created by earlier ones.
5. Check the results: **26 requests and 34 assertions should pass**. The invalid-sort request intentionally returns 400, and duplicate-allocation and protected-deletion requests intentionally return 409; their assertions treat these as successful checks.

To run the same collection from another terminal without opening Postman:

```powershell
npm.cmd exec --yes --package=newman -- newman run postman/SeedShare.postman_collection.json --env-var baseUrl=http://localhost:3000
```

Newman is fetched on demand and does not need to be added to this application's dependencies. `npm.cmd test` runs all automated API and database tests independently, even if the development server is not running.

### Check individual requests manually

Use `{{baseUrl}}` before each endpoint. For POST and PUT requests, choose **Body > raw > JSON**. Copy IDs from create responses and use them in the corresponding URLs; `:id` means an actual positive ID, not the literal text `:id`. PUT requires all editable fields, as shown above.

| Check | Request | Expected |
| --- | --- | --- |
| Health | GET /health | 200 and running message |
| Gardeners | GET /gardeners; POST /gardeners; GET, PUT, DELETE /gardeners/:id | 201 for create, 200 for successful reads/updates/deletes |
| Plots | GET /plots; POST /plots; GET, PUT, DELETE /plots/:id | Same CRUD status codes |
| Leases | GET /leases; POST /leases; GET, PUT, DELETE /leases/:id | Same CRUD status codes |
| Soil search | GET /plots?soil=clay | 200 with matching plots, or [] |
| Combined filter/sort | GET /plots?soil=clay&sort=name&order=desc | 200 with matching plots Z to A |
| Ascending | GET /plots?sort=name&order=asc | 200, A to Z |
| Descending | GET /plots?sort=name&order=desc | 200, Z to A |
| Invalid sort | GET /plots?sort=colour | 400, {"error":"Cannot sort by that field"} |
| JOIN | GET /leases/join | 200 with gardener_name, plot_name, soil and status |
| Duplicate allocation | POST the same active lease twice | First 201, second 409 |
| Release and reallocate | PUT existing lease with status released, then POST a new active lease for its plot | 200 then 201; released history remains |
| Validation | POST a gardener with an invalid email or a plot with blank soil | 400 |
| Referenced resource missing | POST a lease referencing a nonexistent gardener or plot | 404 |
| History protection | DELETE a gardener or plot referenced by any lease | 409 |

Use newly created records for manual write checks. To remove your test data, delete its lease records first, then its plot and gardener. For normal lease termination, use PUT with status released to retain history.

## Demonstration workflow

1. Run `npm run db:init`, then `npm start`.
2. Call `/health`, `/gardeners`, `/plots` and `/leases/join`.
3. Show both name sort directions and `sort=colour` returning the exact 400 error.
4. Show `/plots?soil=clay&sort=name&order=asc`.
5. Create an active lease for a free plot; try another active lease for the same plot and show 409.
6. PUT the existing lease to `released`, then create a new active lease on that plot.
7. Show that both historical and current records appear in the JOIN output.
8. Run `npm test` and show the Postman collection.

## GitHub submission and scope

Commit `app.js`, tests, collection, README, `.env.example`, npm configuration and the lockfile. Never commit `.env`, local databases or `node_modules`. Create your authorized GitHub repository, add its remote and push when ready. This project does not automatically create a remote or publish data.

This is an assignment backend with unrestricted CORS and no authentication. It is intended for local demonstration; it does not implement user accounts, access permissions or a hosted production deployment.

## Refactor verification

- Existing automated suite after module removal: **15 passed, 0 failed**, including CRUD, JOIN, soil search, all three sorting cases, validation, allocation conflicts and direct SQLite foreign-key enforcement.
- Existing Postman collection executed with Newman against the refactored server: **26 requests, 34 assertions, 0 failures**.
- `npm install` completed successfully and reported **0 vulnerabilities**. All required dependencies were retained.
- `npm run dev` started the consolidated application on port **3001**, since port 3000 was occupied. The health endpoint returned HTTP 200.
- `npm run db:init` preserved existing data. All original gardener, plot and lease rows were compared with the pre-refactor snapshot and matched exactly after live testing. Postman created and removed only its own test records; autoincrement counters advanced normally.
- No database reset, remote changes or GitHub push occurred.

Verification used Windows and Node v26.13.0. Other operating systems and Node versions were not executed in this refactor.

### Old-versus-current verification (14 November 2026)

The old modular backup and current single-file version each passed all **15 tests**. A direct comparison also found identical database table definitions, constraints, indexes and seed rows, with foreign keys enabled in both. The current development server was started on **port 3000**, and its Postman run passed **26 requests and 34 assertions**. Existing database rows matched the saved pre-refactor rows after the run. The verified obsolete backup was then removed; the live database, tests and Postman collection remain.

API routes, request/response formats, validation and allocation rules are preserved for the checked cases. The intentional structural differences are that `db:init` now runs `node app.js --init-db`, application/database factories are exported from `app.js` for tests, and port-in-use errors are handled without the old startup callback crash.

