#!/bin/sh
set -eu
umask 077

# State stays in the volume; code and dependencies follow the current image.
mkdir -p /data/app /data/home
cd /data/app
for path in dist node_modules src scripts tsconfig.json package.json package-lock.json; do
  ln -sfn "/opt/discordinator/$path" "$path"
done

case "${1:-run}" in
  run)
    shift
    if [ ! -f .env ] || [ ! -f policy.json ]; then
      echo 'Run interactive setup first (see README.md).' >&2
      exit 1
    fi
    exec node --env-file=.env dist/src/main.js "$@"
    ;;
  setup)
    shift
    if [ ! -t 0 ] || [ ! -t 1 ]; then
      echo 'Setup requires a terminal; use docker run -it or docker compose run --rm setup.' >&2
      exit 1
    fi
    exec node dist/src/cli.js "$@"
    ;;
  *) exec "$@" ;;
esac
