# the package census image: linux-wasm's base with node, wabt, pkg-config and unzip, so a configure that
# runs its test programs reaches the target through scripts/wasm/target-run.ts
# docker build -t gmux-census -f docker/census.Dockerfile --build-arg BASE=gmux-lw-base:3103d5c .
ARG BASE
FROM node:26-bookworm-slim AS node

FROM ${BASE}
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update \
	&& apt-get install -y --no-install-recommends pkg-config curl ca-certificates unzip \
	&& rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/wabt.tgz \
	https://github.com/WebAssembly/wabt/releases/download/1.0.36/wabt-1.0.36-ubuntu-20.04.tar.gz \
	&& echo "4aa0929db06c2376cc76f6d9e920dbde2ea6f1fd55bbaed6cd65167e9e39ecd3  /tmp/wabt.tgz" | sha256sum -c - \
	&& tar -xzf /tmp/wabt.tgz -C /opt \
	&& ln -s /opt/wabt-1.0.36/bin/wasm2wat /opt/wabt-1.0.36/bin/wat2wasm /usr/local/bin/ \
	&& rm /tmp/wabt.tgz
