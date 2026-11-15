const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { openDatabase, createApp } = require('../app');

test('complete API workflow in an isolated database', async t => {
  const db = openDatabase(':memory:');
  const server = createApp(db).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(method, path, data, status = 200) {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    const body = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(body)}`);
    return body;
  }
  let gardener, a, b, lease;
  await t.test('health, empty lists and empty JOIN', async () => {
    assert.deepEqual(await request('GET', '/health'), { message: 'SeedShare Garden API is running' });
    for (const path of ['/gardeners', '/plots', '/leases', '/leases/join']) assert.deepEqual(await request('GET', path), []);
  });
  await t.test('gardener creation, read, update and validation', async () => {
    gardener = await request('POST', '/gardeners', { name: 'Pavan', email: 'pavan@example.com' }, 201);
    assert.equal((await request('GET', `/gardeners/${gardener.gardener_id}`)).name, 'Pavan');
    assert.equal((await request('GET', '/gardeners')).length, 1);
    await request('PUT', `/gardeners/${gardener.gardener_id}`, { name: 'Pavan Rao', email: 'pavan@example.com', phone: '123' });
    await request('POST', '/gardeners', { name: 'Other', email: 'PAVAN@example.com' }, 409);
    for (const data of [{ name: 'A', email: 'bad' }, { name: ' ', email: 'a@b.com' }, {}, [], null]) await request('POST', '/gardeners', data, 400);
    await request('GET', '/gardeners/99999', undefined, 404);
  });
  await t.test('plot CRUD, duplicate names and validation', async () => {
    b = await request('POST', '/plots', { name: 'Beta', soil: 'clay' }, 201);
    a = await request('POST', '/plots', { name: 'Alpha', soil: 'clay' }, 201);
    assert.equal((await request('GET', `/plots/${a.plot_id}`)).name, 'Alpha');
    await request('PUT', `/plots/${b.plot_id}`, { name: 'Beta', soil: 'loam' });
    await request('POST', '/plots', { name: 'alpha', soil: 'sand' }, 409);
    await request('POST', '/plots', { name: 'Blank', soil: ' ' }, 400);
    await request('PUT', `/plots/${a.plot_id}`, { soil: 'clay' }, 400);
  });
  await t.test('assignment test 1: ascending sorting', async () => {
    assert.deepEqual((await request('GET', '/plots?sort=name&order=asc')).map(p => p.name), ['Alpha', 'Beta']);
  });
  await t.test('assignment test 2: descending sorting', async () => {
    assert.deepEqual((await request('GET', '/plots?sort=name&order=desc')).map(p => p.name), ['Beta', 'Alpha']);
  });
  await t.test('assignment test 3: invalid sorting exact error', async () => {
    assert.deepEqual(await request('GET', '/plots?sort=colour', undefined, 400), { error: 'Cannot sort by that field' });
  });
  await t.test('soil search, combined sorting and injection rejection', async () => {
    assert.deepEqual((await request('GET', '/plots?soil=CLAY&sort=name&order=desc')).map(p => p.name), ['Alpha']);
    assert.deepEqual(await request('GET', '/plots?soil=unknown'), []);
    assert.deepEqual(await request('GET', '/plots?soil=%27%20OR%201%3D1--'), []);
    for (const query of ['order=sideways', 'sort=name%3BDROP%20TABLE%20plots', 'sort=name&sort=soil', 'soil=clay&soil=loam']) await request('GET', `/plots?${query}`, undefined, 400);
  });
  await t.test('leases: create, read, JOIN and duplicate allocation', async () => {
    lease = await request('POST', '/leases', { gardener_id: gardener.gardener_id, plot_id: a.plot_id, status: 'active' }, 201);
    assert.equal((await request('GET', `/leases/${lease.lease_id}`)).status, 'active');
    assert.equal((await request('GET', '/leases')).length, 1);
    assert.deepEqual(await request('GET', '/leases/join'), [{ lease_id: lease.lease_id, gardener_name: 'Pavan Rao', plot_name: 'Alpha', soil: 'clay', status: 'active' }]);
    await request('POST', '/leases', { gardener_id: gardener.gardener_id, plot_id: a.plot_id, status: 'active' }, 409);
    await request('DELETE', `/gardeners/${gardener.gardener_id}`, undefined, 409);
    await request('DELETE', `/plots/${a.plot_id}`, undefined, 409);
  });
  await t.test('release preserves history; reallocations and updates stay protected', async () => {
    const data = { gardener_id: gardener.gardener_id, plot_id: a.plot_id, status: 'released' };
    await request('PUT', `/leases/${lease.lease_id}`, data);
    const next = await request('POST', '/leases', { ...data, status: 'active' }, 201);
    await request('PUT', `/leases/${lease.lease_id}`, { ...data, status: 'active' }, 409);
    const other = await request('POST', '/leases', { ...data, plot_id: b.plot_id, status: 'active' }, 201);
    await request('PUT', `/leases/${other.lease_id}`, { ...data, status: 'active' }, 409);
    assert.equal((await request('GET', `/leases/${other.lease_id}`)).plot_id, b.plot_id);
    assert.equal((await request('GET', `/leases/${lease.lease_id}`)).status, 'released');
    await request('DELETE', `/leases/${next.lease_id}`);
    await request('DELETE', `/leases/${other.lease_id}`);
    await request('DELETE', `/plots/${a.plot_id}`, undefined, 409);
  });
  await t.test('missing foreign keys and bad lease values', async () => {
    const data = { gardener_id: gardener.gardener_id, plot_id: a.plot_id, status: 'active' };
    await request('POST', '/leases', { ...data, gardener_id: 99999 }, 404);
    await request('POST', '/leases', { ...data, plot_id: 99999 }, 404);
    await request('POST', '/leases', { ...data, status: 'pending' }, 400);
    await request('POST', '/leases', { ...data, plot_id: 1.5 }, 400);
  });
  await t.test('malformed JSON, bad IDs, missing resources and routes', async () => {
    const response = await fetch(base + '/plots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Malformed JSON body' });
    for (const resource of ['gardeners', 'plots', 'leases']) {
      await request('GET', `/${resource}/-1`, undefined, 400);
      await request('GET', `/${resource}/1.5`, undefined, 400);
      await request('GET', `/${resource}/99999`, undefined, 404);
      await request('PUT', `/${resource}/99999`, {}, 404);
      await request('DELETE', `/${resource}/99999`, undefined, 404);
    }
    await request('GET', '/missing', undefined, 404);
  });
  await t.test('explicit deletion CRUD and historical deletion restrictions', async () => {
    await request('DELETE', `/leases/${lease.lease_id}`);
    await request('DELETE', `/plots/${a.plot_id}`);
    await request('DELETE', `/plots/${b.plot_id}`);
    await request('DELETE', `/gardeners/${gardener.gardener_id}`);
    assert.deepEqual(await request('GET', '/leases/join'), []);
  });
});
