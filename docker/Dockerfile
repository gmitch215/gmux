FROM oven/bun:1-debian AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
# the kernel comes staged in build/ (scripts/build-kernel.sh or `bun run hydrate` before the build);
# a context without it cannot make a working image
RUN test -f build/kernel/vmlinux.wasm && test -f build/kernel/manifest.json \
	&& bash scripts/build-assets.sh
# the site needs only wrangler at run time (it bundles src/site.ts itself), at the locked version
RUN mkdir /runtime && cd /runtime && echo '{ "private": true }' > package.json \
	&& bun add "wrangler@$(bun -e 'console.log(require("/src/node_modules/wrangler/package.json").version)')"

FROM node:24-bookworm-slim
RUN groupadd --system gmux \
	&& useradd --system --gid gmux --home-dir /var/lib/gmux --create-home gmux \
	&& mkdir /opt/gmux && chown gmux:gmux /opt/gmux
WORKDIR /opt/gmux
# wrangler writes .wrangler/ and node_modules/.mf beside itself
COPY --chown=gmux:gmux --from=build /runtime/node_modules ./node_modules
COPY --chown=gmux:gmux --from=build /src/package.json /src/wrangler.jsonc /src/tsconfig.json ./
COPY --chown=gmux:gmux --from=build /src/src ./src
COPY --chown=gmux:gmux --from=build /src/build/kernel ./build/kernel
COPY --chown=gmux:gmux --from=build /src/build/assets ./build/assets

ENV WRANGLER_SEND_METRICS=false
USER gmux
EXPOSE 8787
VOLUME /var/lib/gmux

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
CMD node -e "fetch('http://127.0.0.1:8787/_gmux/status').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# one machine per container, its Durable Object storage in the volume; the terminal is /_gmux/term
ENTRYPOINT ["node", "node_modules/wrangler/bin/wrangler.js", "dev", "--ip", "0.0.0.0", "--port", "8787", "--persist-to", "/var/lib/gmux", "--show-interactive-dev-session=false"]
