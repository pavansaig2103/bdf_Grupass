// Regenerate the importable collection after editing this request workflow.
const fs = require('node:fs');
const path = require('node:path');
const items = [];
function add(name, method, route, body, status = 200, extra = []) {
  const request = { method, header: [], url: '{{baseUrl}}' + route };
  if (body) {
    request.header.push({ key: 'Content-Type', value: 'application/json' });
    request.body = { mode: 'raw', raw: JSON.stringify(body, null, 2), options: { raw: { language: 'json' } } };
  }
  items.push({ name, request, event: [{ listen: 'test', script: { type: 'text/javascript', exec: [
    `pm.test('HTTP ${status}', () => pm.response.to.have.status(${status}));`, ...extra
  ] } }] });
}
const gardener = { name: 'Postman Gardener', email: 'garden-{{runId}}@example.com', phone: '9876543210' };
const plot = { name: 'Postman Plot {{runId}}', soil: 'clay' };
const lease = { gardener_id: '{{gardenerId}}', plot_id: '{{plotId}}', status: 'active' };
add('Health check', 'GET', '/health', null, 200, ["pm.test('API is healthy', () => pm.expect(pm.response.json().message).to.eql('SeedShare Garden API is running'));"]);
add('Create gardener', 'POST', '/gardeners', gardener, 201, ["pm.collectionVariables.set('gardenerId', pm.response.json().gardener_id);"]);
add('List gardeners', 'GET', '/gardeners');
add('Get gardener', 'GET', '/gardeners/{{gardenerId}}');
add('Update gardener', 'PUT', '/gardeners/{{gardenerId}}', { ...gardener, name: 'Updated Postman Gardener' });
add('Create plot', 'POST', '/plots', plot, 201, ["pm.collectionVariables.set('plotId', pm.response.json().plot_id);"]);
add('List plots', 'GET', '/plots');
add('Get plot', 'GET', '/plots/{{plotId}}');
add('Update plot', 'PUT', '/plots/{{plotId}}', { ...plot, soil: 'loam' });
add('Soil search', 'GET', '/plots?soil=LOAM', null, 200, ["pm.test('Soil matches', () => { const rows = pm.response.json(); pm.expect(rows.length).to.be.above(0); rows.forEach(p => pm.expect(p.soil.toLowerCase()).to.eql('loam')); });"]);
for (const order of ['asc', 'desc']) add(`Assignment sort ${order}`, 'GET', `/plots?sort=name&order=${order}`, null, 200, [
  "const names = pm.response.json().map(p => p.name.toLowerCase());",
  "const sorted = [...names].sort((a,b) => a < b ? -1 : a > b ? 1 : 0);",
  ...(order === 'desc' ? ['sorted.reverse();'] : []),
  "pm.test('Names sorted correctly', () => pm.expect(names).to.eql(sorted));"
]);
add('Assignment invalid sort', 'GET', '/plots?sort=colour', null, 400, ["pm.test('Exact error', () => pm.expect(pm.response.json()).to.eql({error: 'Cannot sort by that field'}));"]);
add('Soil with sorting', 'GET', '/plots?soil=loam&sort=name&order=asc');
add('Create lease', 'POST', '/leases', lease, 201, ["pm.collectionVariables.set('leaseId', pm.response.json().lease_id);"]);
add('List leases', 'GET', '/leases');
add('Get lease', 'GET', '/leases/{{leaseId}}');
add('JOIN lease details', 'GET', '/leases/join', null, 200, ["pm.test('Joined names and soil', () => { const row = pm.response.json().find(r => r.lease_id === Number(pm.collectionVariables.get('leaseId'))); pm.expect(row.gardener_name).to.eql('Updated Postman Gardener'); pm.expect(row.soil).to.eql('loam'); pm.expect(row.status).to.eql('active'); });"]);
add('Duplicate active lease rejected', 'POST', '/leases', lease, 409, ["pm.test('Allocation conflict', () => pm.expect(pm.response.json().error).to.eql('Plot already has an active lease'));"]);
add('Plot deletion blocked by history', 'DELETE', '/plots/{{plotId}}', null, 409);
add('Release lease using PUT', 'PUT', '/leases/{{leaseId}}', { ...lease, status: 'released' }, 200, ["pm.test('Released', () => pm.expect(pm.response.json().status).to.eql('released'));"]);
add('Reallocate released plot', 'POST', '/leases', lease, 201, ["pm.collectionVariables.set('nextLeaseId', pm.response.json().lease_id);"]);
add('Delete new lease', 'DELETE', '/leases/{{nextLeaseId}}');
add('Delete original lease (explicit cleanup)', 'DELETE', '/leases/{{leaseId}}');
add('Delete plot', 'DELETE', '/plots/{{plotId}}');
add('Delete gardener', 'DELETE', '/gardeners/{{gardenerId}}');
const collection = {
  info: { name: 'SeedShare Garden', description: 'Run in order against a running API. Creates unique records and cleans up its own data.', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  variable: [{ key: 'baseUrl', value: 'http://localhost:3000' }],
  event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: ["if (pm.info.requestName === 'Health check') pm.collectionVariables.set('runId', Date.now().toString() + Math.random().toString(16).slice(2));"] } }],
  item: items
};
fs.writeFileSync(path.join(__dirname, 'SeedShare.postman_collection.json'), JSON.stringify(collection, null, 2) + '\n');
