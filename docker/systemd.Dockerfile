# the systemd census image: python and meson for a cross build, node for the target runner
# docker build -t gmux-systemd -f docker/systemd.Dockerfile .
FROM node:26-bookworm-slim AS node

FROM python:3.12-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update \
	&& apt-get install -y --no-install-recommends gperf ninja-build pkg-config m4 make gcc wget xz-utils \
	&& rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir meson==1.12.1 jinja2 pyelftools
