# Ubuntu 24.04 with systemd as PID 1, Node 24 and Tailscale (not signed in), for trying
# `portals-host setup` against a real systemd user manager (docs/linux-plan.md, "Trying
# setup in a container"). The user `dana` may sudo without a password, standing in for
# the person at the terminal.
FROM node:24 AS node
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session sudo ca-certificates curl git procps && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
RUN curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg \
 && curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list \
 && apt-get update && apt-get install -y --no-install-recommends tailscale && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash dana && echo 'dana ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dana
CMD ["/sbin/init"]
