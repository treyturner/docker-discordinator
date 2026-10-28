// Run in the built image; no Discord credentials or external services needed.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { envSchema } from '/opt/discordinator/dist/src/core/config.js';
import { HttpServer } from '/opt/discordinator/dist/src/mcp/http.js';
import { reconfigure } from '/opt/discordinator/dist/src/reconfigure.js';
import { fakeConfig, fixture } from '/opt/discordinator/dist/scripts/fixtures.js';
import { checkConnection } from '/opt/discordinator/dist/scripts/check-connection.js';
import { checkStartup } from '/opt/discordinator/dist/scripts/check-startup.js';
import { listenerUrl, localListenerUrl } from '/opt/discordinator/dist/src/core/listener-address.js';
import { localCall, localEndpoint } from '/opt/discordinator/dist/src/mcp/local-client.js';
import { bridgeListening } from '/opt/discordinator/dist/src/operator/service-status.js';
import { mcpAddresses } from '/opt/discordinator/dist/src/operator/connection-domain.js';

for (const [host, destination] of [
  ['0.0.0.0', '127.0.0.1'], ['127.0.0.2', '127.0.0.2'], ['::', '[::1]'], ['::1', '[::1]'],
]) {
  const environment = { DISCORDINATOR_BIND_HOST: host, DISCORDINATOR_PORT: 9000 };
  assert.equal(listenerUrl(environment), `http://${host.includes(':') ? `[${host}]` : host}:9000`);
  assert.equal(localListenerUrl(environment), `http://${destination}:9000`);
  assert.ok(mcpAddresses(environment)[0].includes(`http://${destination}:9000/mcp`));
}

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
    for (const host of ['127.0.0.1', '127.0.0.2', '0.0.0.0', '::1', '::']) {
      const config = { ...fakeConfig(0), DISCORDINATOR_BIND_HOST: host };
      const http = new HttpServer(config, fixture(join(directory, `journal-${host}`)).bridge, () => ({}));
      try {
        await http.start();
        const address = http.server.address();
        assert.equal(address.address, host);
        config.DISCORDINATOR_PORT = address.port;
        const base = localListenerUrl(config);
        const status = await new Promise((resolve, reject) => {
          const outgoing = request(`${base}/mcp`,
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
        // Exercise real local-key requests using the configured address, including IPv6.
        const key = 'synthetic-local-key-for-bind-regression-test-only';
        http.attachLocal(key);
        const home = join(directory, `home-${host}`);
        await mkdir(join(home, '.data'), { recursive: true });
        await writeFile(join(home, '.data/local.key'), key);
        await writeFile(join(home, '.env'), `DISCORDINATOR_BIND_HOST=${host}\nDISCORDINATOR_PORT=${address.port}\n`);
        const savedHost = process.env.DISCORDINATOR_BIND_HOST;
        const savedPort = process.env.DISCORDINATOR_PORT;
        try {
          delete process.env.DISCORDINATOR_BIND_HOST;
          delete process.env.DISCORDINATOR_PORT;
          const endpoint = await localEndpoint(home);
          assert.equal(endpoint.base, base, 'local client uses the configured interface from .env');
          assert.ok((await localCall(endpoint, 'tools/list')).tools.length > 0);
          process.env.DISCORDINATOR_BIND_HOST = host;
          process.env.DISCORDINATOR_PORT = String(address.port);
          assert.equal(await bridgeListening(), true, 'service probe reaches the configured interface');
          process.env.DISCORDINATOR_BIND_HOST = '127.0.0.3';
          assert.equal((await localEndpoint(home)).base, `http://127.0.0.3:${address.port}`);
        } finally {
          if (savedHost === undefined) delete process.env.DISCORDINATOR_BIND_HOST;
          else process.env.DISCORDINATOR_BIND_HOST = savedHost;
          if (savedPort === undefined) delete process.env.DISCORDINATOR_PORT;
          else process.env.DISCORDINATOR_PORT = savedPort;
        }
      } finally {
        await http.stop();
      }
    }
    await checkConnection(directory);
    await checkStartup(directory);
    console.log('Passed: interface URLs, local clients/probes, IPv4/IPv6 listeners, startup/reload logs, and connection/auth checks');
  }
} finally {
    await rm(directory, { recursive: true, force: true });
}
