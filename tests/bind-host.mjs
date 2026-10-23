// Run in the built image; no Discord credentials or external services needed.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { envSchema } from '/opt/discordinator/dist/src/core/config.js';
import { HttpServer } from '/opt/discordinator/dist/src/mcp/http.js';
import { reconfigure } from '/opt/discordinator/dist/src/reconfigure.js';
import { fakeConfig, fixture } from '/opt/discordinator/dist/scripts/fixtures.js';
import { checkConnection } from '/opt/discordinator/dist/scripts/check-connection.js';

const bindSchema = envSchema.shape.DISCORDINATOR_BIND_HOST;
assert.equal(bindSchema.parse(undefined), '127.0.0.1');
for (const host of ['127.0.0.1', '0.0.0.0', '192.168.1.2', '::', '::1'])
  assert.equal(bindSchema.parse(host), host);
for (const host of ['', 'localhost', '256.0.0.1', '0.0.0.0:8787', '::invalid'])
  assert.equal(bindSchema.safeParse(host).success, false, host);

const config = fakeConfig();
let restarts = 0;
await reconfigure(config, { ...config, DISCORDINATOR_BIND_HOST: '0.0.0.0' }, {
  restartListener: async () => { restarts++; },
  reconnectGateway: async () => { assert.fail('Bind changes must not reconnect Discord'); },
  movePolicy: async () => { assert.fail('Bind changes must not move policy'); },
});
assert.equal(restarts, 1);

const directory = await mkdtemp(join(tmpdir(), 'discordinator-bind-'));
try {
  if (process.argv.includes('--serve')) {
    const config = { ...fakeConfig(8787), DISCORDINATOR_BIND_HOST: process.env.DISCORDINATOR_BIND_HOST };
    const http = new HttpServer(config, fixture(join(directory, 'journal')).bridge, () => ({}));
    await http.start();
    assert.equal(http.server.address().address, '0.0.0.0');
    console.log('READY');
    await new Promise(resolve => process.once('SIGTERM', resolve));
    await http.stop();
  } else {
    for (const host of ['127.0.0.1', '0.0.0.0', '::1', '::']) {
      const config = { ...fakeConfig(0), DISCORDINATOR_BIND_HOST: host };
      const http = new HttpServer(config, fixture(join(directory, `journal-${host}`)).bridge, () => ({}));
      try {
        await http.start();
        const address = http.server.address();
        assert.equal(address.address, host);
        config.DISCORDINATOR_PORT = address.port;
        const client = host.includes(':') ? '[::1]' : '127.0.0.1';
        const status = await new Promise((resolve, reject) => {
          const outgoing = request(`http://${client}:${address.port}/mcp`,
            { headers: { Host: `127.0.0.1:${address.port}` } },
            response => {
              response.resume();
              response.once('end', () => resolve(response.statusCode));
              response.once('error', reject);
            }
          );
          outgoing.once('error', reject);
          outgoing.end();
        });
        assert.equal(status, 401);
      } finally {
        await http.stop();
      }
    }
    await checkConnection(directory);
    console.log('Passed: bind validation, IPv4/IPv6 listeners, listener reload, and upstream connection/auth checks');
  }
} finally {
    await rm(directory, { recursive: true, force: true });
}
