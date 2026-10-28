# Docker Discordinator

Runs [DevL0rd/Discordinator](https://github.com/DevL0rd/Discordinator) on
`node:26-alpine`, with the latest Codex and Claude Code CLIs. All credentials,
settings, responder sessions and journals persist in the `discordinator-data`
volume. The container runs as the unprivileged `node` user.

## Build and configure

```sh
docker compose build --pull
```

For a local responder, sign in to the corresponding CLI first:

```sh
docker compose run --rm setup codex login --device-auth
# Or:
docker compose run --rm setup claude auth login
```

Open the interactive setup app:

```sh
docker compose run --rm setup
```

Follow the wizard to enter your Discord bot token, pick your owner and channel,
and choose a responder. Enable Message Content and Server Members intents in the
Discord Developer Portal, and install the bot in your server before setup.
Login links can be opened in your own browser; no browser runs in the image.

At **Install Discordinator**, choose **Skip**. Docker manages the process.
When you reach **Make sure it works**, exit the wizard with Ctrl+C. Start the
service, then reopen setup inside the running container to finish the checks:

```sh
docker compose up -d discordinator
docker compose exec discordinator docker-entrypoint.sh setup
```

Complete the resumed wizard's checks. The service can now run without
the setup app. Use the `docker compose exec` command whenever you want to change settings;
Discordinator applies saved changes live. Skip the setup app's system service,
install and update actions; rebuild the image to update the container.

## Networking

The build applies [configurable-bind-host.patch](patches/configurable-bind-host.patch)
before compiling upstream. It validates IPv4/IPv6 addresses, makes the HTTP server
use `DISCORDINATOR_BIND_HOST`, and restarts the listener when that setting changes.
Startup and reload logs report that bind address, including bracketed IPv6 URLs.
Local MCP clients, service probes and setup connection hints follow the configured
interface. They connect through `127.0.0.1` for `0.0.0.0`, through `::1` for `::`,
and directly to a specific configured address. Local-key authentication still
requires the private key; public Host/Origin allowlists still apply.
The patch preserves upstream's loopback default; the image sets
`DISCORDINATOR_BIND_HOST=0.0.0.0` so Docker can publish the listener. Override it
with `docker run -e DISCORDINATOR_BIND_HOST=...` or a Compose `environment` entry.
The environment takes precedence over the saved `.env` at startup. The setup
dashboard displays the listener address; configure it through the environment.

Compose uses bridge networking and publishes `127.0.0.1:8787:8787`, keeping host
access local. Change the host address/port in `compose.yaml` to publish elsewhere.
If you change the container's listener port, update both sides of the mapping as
needed. Keep one running instance per volume. Host and Origin allowlists and MCP
authentication still apply; configure `DISCORDINATOR_ALLOWED_HOSTS` for any extra
hostnames clients use. The bind address does not change the canonical resource URL.

For ChatGPT or Claude web connections, configure a public HTTPS domain in setup
and point a host reverse proxy or tunnel at `http://127.0.0.1:8787`. Domain,
DNS and HTTPS ingress are provided separately. Local responder CLIs run inside
the container; they do not automatically connect to your host desktop apps.
Use a directory inside `/data` as the responder workspace if its files should
persist.

## Rebuild and overrides

```sh
docker compose build --pull --no-cache
docker compose up -d discordinator
```

The default upstream source is commit
`9207b1d253d8f61c7e350a9f1fe6db0962eeb6ec`. Its npm lockfile is preserved.
Node 26, Alpine packages and the two responder CLIs receive their latest
available versions when rebuilding without cache. Build arguments allow choosing
another upstream ref or explicit CLI versions:

```sh
docker build --pull --build-arg DISCORDINATOR_REF=main \
  --build-arg CODEX_VERSION=latest --build-arg CLAUDE_CODE_VERSION=latest \
  -t discordinator:local .
```

The entrypoint accepts `run` (default), `setup`, or an arbitrary command such as
`sh` for an interactive shell. `tini` forwards shutdown signals and reaps child
processes. Stop the service with `docker compose down`; the volume is retained.
Back up that volume privately, since it contains credentials. Avoid
`docker compose down -v` unless you intend to erase all saved state.

## Validate the bind patch

```sh
docker run --rm -v "$PWD/tests/bind-host.mjs:/tmp/bind-host.mjs:ro" \
  discordinator:local node /tmp/bind-host.mjs
```

This checks address validation, actual IPv4/IPv6 listeners, local client and
service-probe connections, startup/reload logs and upstream connection/authentication
behavior without real Discord credentials.
The build fails if the patch no longer applies to a selected upstream ref.

## Build and publish pipeline

The GitHub Actions workflows follow
[codercom-images](https://github.com/treyturner/codercom-images/tree/main/.github):

- **Build and test PR** builds changed container inputs and runs the bind,
  authentication and responder CLI checks. It does not log in or publish.
- **Build and publish dev** runs for container changes on `main`, or manually
  from `main`. After tests pass, it publishes to
  `ghcr.io/treyturner/discordinator` and
  `forgejo.treyturner.info/treyturner/discordinator`.
- **Promote dev image** runs manually from `main`. Enter the upstream version
  (for example `2.0.0`) to promote `2.0.0-dev` to `2.0.0` and `latest` in both
  registries without rebuilding. Promotion verifies that both source manifests
  match and uses their resolved digests.

The build reads the upstream version from `package.json` inside the built image;
it does not use this wrapper repository's tags. Dev tags append `-dev`, such as
`2.0.0-dev`. Rebuilding the same upstream version replaces that dev tag.
Update `DISCORDINATOR_REF` in the Dockerfile to select newer upstream source.
Builds use `linux/amd64`, pull current base images and disable layer caching to
refresh the latest responder CLIs and Alpine packages.

Set the repository Actions secret `FORGEJO_REGISTRY_TOKEN` to a Forgejo token
with package write access for `treyturner`. GHCR uses the workflow's built-in
`GITHUB_TOKEN` with `packages: write`. If the GHCR package already exists, grant
this repository Actions access to it. Workflow action versions are pinned to
the same commit SHAs as the reference pipeline.
