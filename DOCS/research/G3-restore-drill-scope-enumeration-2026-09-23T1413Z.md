# G3 restore drill — pre-restore scope enumeration (raw output)

- Collected: 2026-09-23T14:13:37Z – 14:16:11Z UTC by Claude Code (branch feature/g3-restore-drill, uncommitted)
- Host: <preprod-ssh-user>@<preprod-tailscale-ip> (<preprod-host>) over Tailscale SSH, check approved by Principal Operator 10:12 ET
- Mode: read-only. No restore run. No config, container, or Doppler value modified.
- Masking: sed filter replaced any literal credential values; none were found (all credential fields are `${VAR}` references).
- Not collected: `.env*` files, cloudflared credential JSON, any Doppler secret value.
- Masked before commit (2026-09-23, at Principal Operator direction): the operator's home public IP in the `tailscale status` output is replaced with `<operator-home-ip>`, and the Tailscale login prefix with `<tailscale-login>`. Neither affects the drill evidence.

## 1. Host enumeration

```text
=== host
<preprod-host>
2026-09-23T14:13:37Z
=== ls -la /data/
ls: cannot access '/data/': No such file or directory
=== df -h /data
df: /data: No such file or directory
=== ip addr
lo               UNKNOWN        <loopback-ip>/8 ::1/128
eth0             UP             <preprod-public-ip>/32 2a01:4f9:c015:4d24::1/64 fe80::9000:9ff:fedc:6523/64
tailscale0       UNKNOWN        <preprod-tailscale-ip>/32 fd7a:115c:a1e0::8729:3f45/128 fe80::c302:8549:dd9e:68e3/64
docker0          DOWN           <docker-bridge-ip>/16 fe80::d86f:feff:fe3a:9561/64
br-0153c8fcf99a  UP             <docker-bridge-ip>/16 fe80::f44e:32ff:fea0:600/64
vethe619964@if2  UP             fe80::cccc:69ff:fead:da11/64
veth49a7b28@if2  UP             fe80::ec0a:51ff:fed9:c684/64
br-3cd297c064e7  UP             <docker-bridge-ip>/16 fe80::6825:d8ff:fef4:aeb8/64
veth0bde0c4@if2  UP             fe80::7c2b:54ff:fe48:b03d/64
veth761f68d@if2  UP             fe80::f8a3:27ff:fe66:5536/64
=== tailscale status
<preprod-tailscale-ip>  <preprod-host>  <tailscale-login>@  linux    -
<operator-tailscale-ip>  <operator-device>  <tailscale-login>@  windows  active; direct <operator-home-ip>:41641, tx 7028 rx 7572
=== containers
mgpl-preprod-caddy	caddy:2-alpine	Up 12 days
mgpl-preprod-app	mgpl-preprod-app	Up 12 days (healthy)
mgpl-test-caddy	caddy:2-alpine	Up 12 days
mgpl-test-app	mgpl-test-app	Up 12 days (healthy)
=== compose projects
mgpl-preprod-caddy  wd=/opt/mgpl  files=/opt/mgpl/docker-compose.preprod.yml
mgpl-preprod-app  wd=/opt/mgpl  files=/opt/mgpl/docker-compose.preprod.yml
mgpl-test-caddy  wd=/opt/mgpl  files=/opt/mgpl/docker-compose.test.yml
mgpl-test-app  wd=/opt/mgpl  files=/opt/mgpl/docker-compose.test.yml
=== litestream containers: mounts + cmd
=== litestream*.yml on disk
/opt/mgpl/litestream.preprod.yml
/opt/mgpl/litestream.yml
=== deployed litestream configs (as mounted in each sidecar)
=== replicated DBs: size + generations
=== other-host references in deployed config (compose, Caddyfile, cloudflared config, litestream; no .env/credential files)
----- /opt/mgpl
total 2340
drwxrwxrwx 28 root root    4096 Sep 10 18:29 .
drwxr-xr-x  4 root root    4096 Sep 10 18:06 ..
drwxrwxrwx  3 root root    4096 Sep 10 18:06 .agents
dr-xr-xr-x  2 root root    4096 Sep 10 18:06 .ai
-rw-rw-rw-  1 root root     620 Sep  8 16:50 .aiignore
dr-xr-xr-x  2 root root    4096 Sep 10 18:06 .claude
dr-xr-xr-x  2 root root    4096 Sep 10 18:06 .clinerules
-rw-rw-rw-  1 root root     789 Aug  7 19:51 .clinerules_bak
-rw-rw-rw-  1 root root      96 Sep  8 16:50 .dockerignore
dr-xr-xr-x  3 root root    4096 Sep 10 18:06 .github
-rw-rw-rw-  1 root root     770 Sep  8 16:50 .gitignore
dr-xr-xr-x  3 root root    4096 Sep 10 18:06 .husky
-rw-rw-rw-  1 root root     154 Sep  8 16:50 .prettierignore
-rw-rw-rw-  1 root root     142 Sep  8 16:50 .prettierrc.json
dr-xr-xr-x  6 root root    4096 Sep 10 18:06 .review_render
dr-xr-xr-x  4 root root    4096 Sep 10 18:06 .tmp_baseline
-rw-rw-rw-  1 root root 1040860 Sep  2 02:00 .tmp_gate_runner_output.txt
dr-xr-xr-x 17 root root    4096 Sep 10 18:06 .tmp_pi003
dr-xr-xr-x 13 root root    4096 Sep 10 18:06 .tmp_pi004
dr-xr-xr-x  2 root root    4096 Sep 10 18:06 .vscode
-rw-rw-rw-  1 root root   22548 Sep  8 17:30 AGENTS.md
-rw-rw-rw-  1 root root      12 Sep  8 16:50 CLAUDE.md
-rw-rw-rw-  1 root root    1877 Sep  8 16:50 Caddyfile
-rw-rw-rw-  1 root root     749 Sep 10 17:53 Caddyfile.preprod
-rw-rw-rw-  1 root root     737 Sep 10 17:53 Caddyfile.test
-rw-rw-rw-  1 root root    6300 Sep  9 14:43 DEPLOYMENT.md
dr-xr-xr-x  3 root root    4096 Sep 10 18:06 DOCS
-rw-rw-rw-  1 root root    1084 Sep 10 18:12 Dockerfile
-rw-rw-rw-  1 root root    2736 Sep  8 16:50 FILEMAP.md
-rw-rw-rw-  1 root root    2986 Sep  8 16:50 README.md
dr-xr-xr-x  2 root root    4096 Aug  8 04:49 __pycache__
-rw-rw-rw-  1 root root    9264 Sep  8 16:50 app_engine_schema.sql
dr-xr-xr-x  2 root root    4096 Sep 10 18:06 backups
-rw-rw-rw-  1 root root     449 Aug 20 20:40 client2.txt
-rw-rw-rw-  1 root root     449 Aug 20 20:30 client_output.txt
-rw-rw-rw-  1 root root    1689 Sep  8 16:50 cline_settings.json
dr-xr-xr-x  2 root root    4096 Sep 10 18:06 cloudflared
-rw-rw-rw-  1 root root  515706 Sep  1 22:44 coverage-report.json
-rw-rw-rw-  1 root root   50596 Sep  9 14:43 cspell.json
drwxr-xr-x  2 1000 1000    4096 Sep 10 18:30 data-preprod
drwxr-xr-x  2 1000 1000    4096 Sep 10 18:29 data-test
dr-xr-xr-x  2 root root    4096 Sep 10 18:06 deliverables
dr-xr-xr-x  4 root root    4096 Sep 10 18:06 deploy
dr-xr-xr-x 11 root root    4096 Sep 10 18:06 dist
-rw-rw-rw-  1 root root    1798 Sep 10 17:55 docker-compose.preprod.yml
-rw-rw-rw-  1 root root    2515 Sep  9 14:43 docker-compose.staging.yml
-rw-rw-rw-  1 root root    1352 Sep 10 17:55 docker-compose.test.yml
-rw-rw-rw-  1 root root     536 Sep  8 16:50 docker-compose.yml
-rw-rw-rw-  1 root root   10112 Aug 20 20:41 e2e2.txt
-rw-rw-rw-  1 root root    9179 Aug 20 20:45 e2e3.txt
-rw-rw-rw-  1 root root    8958 Aug 20 20:48 e2e4.txt
-rw-rw-rw-  1 root root    3144 Aug 20 20:50 e2e5.txt
-rw-rw-rw-  1 root root    1855 Sep  8 16:50 eslint.config.mjs
dr-xr-xr-x  2 root root    4096 Sep 10 18:06 gates
-rw-rw-rw-  1 root root     178 Aug 11 17:08 hw-profile.json
-rw-rw-rw-  1 root root  125495 Aug  7 19:45 image.png
-rw-rw-rw-  1 root root    1258 Sep 10 17:55 litestream.preprod.yml
-rw-rw-rw-  1 root root    2176 Sep  8 16:50 litestream.yml
-rw-rw-rw-  1 root root  254303 Sep  8 16:50 package-lock.json
-rw-rw-rw-  1 root root    3640 Sep 10 18:18 package.json
-rw-rw-rw-  1 root root    3345 Sep  8 16:50 playwright.config.ts
-rw-rw-rw-  1 root root   17849 Aug 15 20:07 playwright_output.txt
-rw-rw-rw-  1 root root     156 Aug  5 23:40 prisma.config.ts.bak
dr-xr-xr-x  3 root root    4096 Sep 10 18:06 public
dr-xr-xr-x  3 root root    4096 Sep 10 18:06 scripts
-rw-rw-rw-  1 root root   20674 Sep  8 16:50 seed_database.py
-rw-rw-rw-  1 root root    4937 Aug 20 20:40 spell2.txt
-rw-rw-rw-  1 root root    4941 Aug 20 20:30 spell_output.txt
dr-xr-xr-x 11 root root    4096 Sep 10 18:23 src
drwxrwxrwx  5 root root    4096 Sep 10 18:06 test
dr-xr-xr-x  2 root root    4096 Sep 10 18:06 tools
-rw-rw-rw-  1 root root       0 Aug 20 20:40 tsc2.txt
-rw-rw-rw-  1 root root       0 Aug 20 20:29 tsc_output.txt
-rw-rw-rw-  1 root root     244 Sep  8 16:50 tsconfig.eslint.json
-rw-rw-rw-  1 root root     392 Sep  8 16:50 tsconfig.json
-rw-rw-rw-  1 root root    1370 Sep  8 16:50 vitest.config.ts
/opt/mgpl/docker-compose.preprod.yml:30:        ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://127.0.0.1:4000/healthz"]
/opt/mgpl/docker-compose.preprod.yml:56:      - "127.0.0.1:2082:80"
/opt/mgpl/docker-compose.staging.yml:18:# recreates the `app` service:
/opt/mgpl/docker-compose.staging.yml:48:        ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://127.0.0.1:4000/healthz"]
/opt/mgpl/docker-compose.test.yml:29:        ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://127.0.0.1:4000/healthz"]
/opt/mgpl/docker-compose.test.yml:42:      - "127.0.0.1:2081:80"
/opt/mgpl/docker-compose.yml:20:      test: ["CMD", "curl", "-f", "http://localhost:4000/healthz"]
/opt/mgpl/Caddyfile:4:# terminated at Cloudflare (the tunnel origin is plain HTTP on localhost:2080),
/opt/mgpl/litestream.preprod.yml:16:        endpoint: ${R2_ENDPOINT}
/opt/mgpl/litestream.preprod.yml:28:        endpoint: ${B2_ENDPOINT}
/opt/mgpl/litestream.yml:12:#   R2_ENDPOINT              - Cloudflare R2 S3-compatible endpoint URL
/opt/mgpl/litestream.yml:15:#   B2_ENDPOINT              - Backblaze B2 S3-compatible endpoint URL
/opt/mgpl/litestream.yml:28:        endpoint: ${R2_ENDPOINT}
/opt/mgpl/litestream.yml:41:        endpoint: ${B2_ENDPOINT}
/opt/mgpl/cloudflared/config.yml:3:# Routes public hostnames through the Cloudflare Tunnel to the internal Caddy
/opt/mgpl/cloudflared/config.yml:4:# reverse proxy on localhost:2080. TLS terminates at Cloudflare; the origin is
/opt/mgpl/cloudflared/config.yml:23:  - hostname: staging.mgpl.io
/opt/mgpl/cloudflared/config.yml:24:    service: http://localhost:2080
/opt/mgpl/cloudflared/config.yml:27:  - hostname: admin.mgpl.io
/opt/mgpl/cloudflared/config.yml:28:    service: http://localhost:2080
/opt/mgpl/cloudflared/config.yml:30:  # Catch-all: return 404 for any unmatched hostname/path.
/opt/mgpl/cloudflared/config.yml:31:  - service: http_status:404
/etc/cloudflared/config-preprod.yml:8:  - hostname: preprod.m-gpl.com
/etc/cloudflared/config-preprod.yml:9:    service: http://localhost:2082
/etc/cloudflared/config-preprod.yml:10:  - service: http_status:404
/etc/cloudflared/config-test.yml:8:  - hostname: test.m-gpl.com
/etc/cloudflared/config-test.yml:9:    service: http://localhost:2081
/etc/cloudflared/config-test.yml:10:  - service: http_status:404
=== ssh known_hosts / config on host (other servers?)
=== end
2026-09-23T14:13:44Z
```

## 2. Data dirs, deployed configs, Litestream presence

```text
=== ls -la data-preprod data-test
data-preprod:
total 2036
drwxr-xr-x  2 1000 1000    4096 2026-09-10T18:30:17+0000 .
drwxrwxrwx 28 root root    4096 2026-09-10T18:29:25+0000 ..
-rw-r--r--  1 1000 1000    4096 2026-09-10T18:30:17+0000 mgpl-preprod.db
-rw-r--r--  1 1000 1000   32768 2026-09-10T18:30:17+0000 mgpl-preprod.db-shm
-rw-r--r--  1 1000 1000 2039432 2026-09-10T18:30:18+0000 mgpl-preprod.db-wal

data-test:
total 2036
drwxr-xr-x  2 1000 1000    4096 2026-09-10T18:29:26+0000 .
drwxrwxrwx 28 root root    4096 2026-09-10T18:29:25+0000 ..
-rw-r--r--  1 1000 1000    4096 2026-09-10T18:29:26+0000 mgpl-test.db
-rw-r--r--  1 1000 1000   32768 2026-09-10T18:29:26+0000 mgpl-test.db-shm
-rw-r--r--  1 1000 1000 2039432 2026-09-10T18:29:26+0000 mgpl-test.db-wal
=== df -h (data dirs, /)
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1        38G  5.5G   31G  16% /
/dev/sda1        38G  5.5G   31G  16% /
/dev/sda1        38G  5.5G   31G  16% /
=== app container DB mounts + DB_PATH/NODE_ENV
[mgpl-preprod-app]
  /opt/mgpl/data-preprod -> /data

DATABASE_URL=***present***
NODE_ENV=production
DB_PATH=/data/mgpl-preprod.db
[mgpl-test-app]
  /opt/mgpl/data-test -> /data

DATABASE_URL=***present***
NODE_ENV=staging
DB_PATH=/data/mgpl-test.db
=== deployed docker-compose.preprod.yml
# MGPL — Preprod environment Compose stack (shared non-production VPS).
#
# Pre-production mirror closest to Production durability. Own app container, own
# SQLite file (mgpl-preprod.db), own internal port, and a Litestream replication
# sidecar (mirrors Production's durability). Secrets are injected at runtime by
# Doppler via `env_file: .env.doppler.preprod`.
#
# Bring up:
#   doppler secrets download --config preprod --format docker --no-file > .env.doppler.preprod
#   docker compose -p mgpl-preprod -f docker-compose.preprod.yml up -d --build

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: mgpl-preprod-app
    restart: unless-stopped
    env_file:
      - .env.doppler.preprod
    environment:
      - PORT=4000
      - NODE_ENV=production
      - DB_PATH=/data/mgpl-preprod.db
      - DISABLE_CRON=true
    volumes:
      - ./data-preprod:/data
    healthcheck:
      test:
        ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://127.0.0.1:4000/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

  litestream:
    image: litestream/litestream:0.3
    container_name: mgpl-preprod-litestream
    restart: unless-stopped
    depends_on:
      - app
    env_file:
      - .env.doppler.preprod
    volumes:
      - ./data-preprod:/data
      - ./litestream.preprod.yml:/etc/litestream.yml:ro
    command: ["replicate", "-config", "/etc/litestream.yml"]

  caddy:
    image: caddy:2-alpine
    container_name: mgpl-preprod-caddy
    restart: unless-stopped
    depends_on:
      - app
    ports:
      - "127.0.0.1:2082:80"
    volumes:
      - ./Caddyfile.preprod:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_logs:/var/log/caddy

volumes:
  caddy_data:
  caddy_logs:
=== deployed litestream.preprod.yml
# MGPL Preprod — Litestream SQLite WAL replication (mirrors Production durability).
#
# Replicates /data/mgpl-preprod.db to two independent S3-compatible object stores:
#   1. Cloudflare R2  (primary,   1s  sync-interval, 168h retention)
#   2. Backblaze B2   (secondary, 30s sync-interval, 168h retention)
#
# Credentials are injected at runtime by Doppler (R2_* / B2_* secrets in the
# preprod config). Replica paths use the `mgpl-preprod` prefix to stay isolated
# from the Production and Staging replicas.

dbs:
  - path: /data/mgpl-preprod.db
    replicas:
      - name: mgpl-db-replica
        type: s3
        endpoint: ${R2_ENDPOINT}
        bucket: mgpl-db-replica
        path: mgpl-preprod
        region: auto
        access-key-id: ${R2_ACCESS_KEY_ID}
        secret-access-key: ${R2_SECRET_ACCESS_KEY}
        force-path-style: true
        sync-interval: 1s
        retention: 168h

      - name: mgpl-db-backup
        type: s3
        endpoint: ${B2_ENDPOINT}
        bucket: mgpl-db-backup
        path: mgpl-preprod
        region: auto
        access-key-id: ${B2_ACCESS_KEY_ID}
        secret-access-key: ${B2_SECRET_ACCESS_KEY}
        force-path-style: true
        sync-interval: 30s
        retention: 168h

snapshot-interval: 24h
=== deployed litestream.yml
# MGPL v1.1 - Litestream SQLite WAL Replication Configuration
#
# Continuously replicates the staging SQLite database to two independent
# S3-compatible object stores so a corrupted/lost volume on the Hetzner
# staging node can be restored from either provider:
#   1. Cloudflare R2  (primary,   1s sync-interval, 168h/7d retention)
#   2. Backblaze B2   (secondary, 30s sync-interval, 168h/7d retention)
#
# Secrets are injected at runtime by Doppler (see docker-compose.staging.yml
# `litestream` service, which mounts this file read-only and shares the
# `.env.doppler` env_file with the `app` service):
#   R2_ENDPOINT              - Cloudflare R2 S3-compatible endpoint URL
#   R2_ACCESS_KEY_ID         - R2 access key id
#   R2_SECRET_ACCESS_KEY     - R2 secret access key
#   B2_ENDPOINT              - Backblaze B2 S3-compatible endpoint URL
#   B2_ACCESS_KEY_ID         - B2 application key id
#   B2_SECRET_ACCESS_KEY     - B2 application key
#
# Local development is unaffected: Litestream only runs inside the staging
# stack where this file is mounted and the sidecar container is present.

dbs:
  - path: /data/mgpl-staging.db
    replicas:
      # Primary replica: Cloudflare R2 (S3-compatible API).
      - name: mgpl-db-replica
        type: s3
        endpoint: ${R2_ENDPOINT}
        bucket: mgpl-db-replica
        path: mgpl-staging
        region: auto
        access-key-id: ${R2_ACCESS_KEY_ID}
        secret-access-key: ${R2_SECRET_ACCESS_KEY}
        force-path-style: true
        sync-interval: 1s
        retention: 168h

      # Secondary replica: Backblaze B2 (S3-compatible API).
      - name: mgpl-db-backup
        type: s3
        endpoint: ${B2_ENDPOINT}
        bucket: mgpl-db-backup
        path: mgpl-staging
        region: auto
        access-key-id: ${B2_ACCESS_KEY_ID}
        secret-access-key: ${B2_SECRET_ACCESS_KEY}
        force-path-style: true
        sync-interval: 30s
        retention: 168h

# Global snapshot cadence. Snapshots are full copies of the database taken on
# this interval; WAL segments are streamed continuously between snapshots.
snapshot-interval: 24h
=== litestream images / systemd / binaries / cron
(no litestream image present)
  cloudflared-mgpl-preprod.service                                                                                                          loaded    active   running   Cloudflare Tunnel client (mgpl-preprod -> preprod.m-gpl.com)
  cloudflared-mgpl-test.service                                                                                                             loaded    active   running   Cloudflare Tunnel client (mgpl-test -> test.m-gpl.com)
(no litestream systemd unit)
(no litestream binary on host)
e2scrub_all
=== docker events for litestream (last 30d)
=== end
2026-09-23T14:14:12Z
```

## 3. Replica bucket listing (local, Node SigV4 ListObjectsV2, read-only)

Endpoint shape check (values not printed):

```text
R2_ENDPOINT: {"length":65,"hasScheme":true,"scheme":"https","hostSuffix":"r2.cloudflarestorage.com","hasPath":false}
B2_ENDPOINT: {"length":30,"hasScheme":false,"scheme":null,"hostSuffix":"backblazeb2.com","hasPath":false}
```

### 3a. `doppler run --config dev`

```text

##### R2 bucket=mgpl-db-replica (listed 2026-09-23T14:15:54.088Z)
ERROR: HTTP 404: NoSuchBucket The specified bucket does not exist.
(note: B2_ENDPOINT has no scheme; listing client prefixed https://)

##### B2 bucket=mgpl-db-backup (listed 2026-09-23T14:15:54.560Z)
ERROR: HTTP 404: NoSuchBucket The specified bucket does not exist: mgpl-db-backup
```

### 3b. `doppler run --config preprod`

```text

##### R2 bucket=mgpl-db-replica (listed 2026-09-23T14:16:11.243Z)
ERROR: HTTP 404: NoSuchBucket The specified bucket does not exist.
(note: B2_ENDPOINT has no scheme; listing client prefixed https://)

##### B2 bucket=mgpl-db-backup (listed 2026-09-23T14:16:11.673Z)
ERROR: HTTP 404: NoSuchBucket The specified bucket does not exist: mgpl-db-backup
```

Doppler configs in project mgpl: dev, dev_personal, preprod, prd, test. `prd` was not accessed (permission denied).

## Appendix: scripts as run

### enum.sh

```
mask() { sed -E 's/((secret|key|token|password|access-key-id|secret-access-key|dsn)[A-Za-z_-]*[[:space:]]*[:=][[:space:]]*)([^$[:space:]"'"'"'][^[:space:]]*|"[^$"][^"]*"|'"'"'[^$'"'"'][^'"'"']*'"'"')/\1***MASKED***/Ig'; }
echo "=== host"; hostname; date -u +%FT%TZ
echo "=== ls -la /data/"; ls -la /data/ 2>&1
echo "=== df -h /data"; df -h /data 2>&1
echo "=== ip addr"; ip -br addr
echo "=== tailscale status"; tailscale status 2>&1
echo "=== containers"; docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
echo "=== compose projects"
docker ps -a --format '{{.Names}}' | while read c; do
  echo "$c  wd=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' $c)  files=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' $c)"
done
echo "=== litestream containers: mounts + cmd"
LS=$(docker ps -a --format '{{.Names}}' | grep -i litestream)
for c in $LS; do echo "[$c] state=$(docker inspect -f '{{.State.Status}} since {{.State.StartedAt}}' $c)"; docker inspect -f '{{range .Mounts}}  {{.Source}} -> {{.Destination}}{{println}}{{end}}  cmd={{.Config.Cmd}}' $c; done
echo "=== litestream*.yml on disk"; find / -xdev -name 'litestream*.yml' -not -path '/proc/*' 2>/dev/null
echo "=== deployed litestream configs (as mounted in each sidecar)"
for c in $LS; do echo "----- [$c] /etc/litestream.yml"; docker exec $c cat /etc/litestream.yml 2>&1 | mask; done
echo "=== replicated DBs: size + generations"
for c in $LS; do
  for db in $(docker exec $c sh -c "grep -E '^[[:space:]]*-?[[:space:]]*path:[[:space:]]*/' /etc/litestream.yml | head -1 | sed -E 's/.*path:[[:space:]]*//'"); do
    echo "----- [$c] $db"
    docker exec $c sh -c "ls -la $db $db-wal $db-shm 2>&1"
    echo "  litestream generations:"; docker exec $c litestream generations -config /etc/litestream.yml $db 2>&1
  done
done
echo "=== other-host references in deployed config (compose, Caddyfile, cloudflared config, litestream; no .env/credential files)"
for wd in $(docker ps -a --format '{{.Names}}' | xargs -I{} docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' {} | sort -u); do
  [ -d "$wd" ] || continue
  echo "----- $wd"; ls -la "$wd" | grep -v -E '\.env'
  grep -n -I -E '([0-9]{1,3}\.){3}[0-9]{1,3}|https?://|hostname|endpoint|service:|ssh|host:' $wd/docker-compose*.yml $wd/Caddyfile* $wd/litestream*.yml $wd/cloudflared/*.yml /etc/cloudflared/*.yml 2>/dev/null | mask
done
echo "=== ssh known_hosts / config on host (other servers?)"; awk '{print $1}' ~/.ssh/known_hosts 2>/dev/null | sort -u; grep -i -E '^\s*(host|hostname)\b' ~/.ssh/config 2>/dev/null
echo "=== end"; date -u +%FT%TZ
```

### enum2.sh

```
mask() { sed -E 's/((secret|key|token|password|access-key-id|secret-access-key|dsn)[A-Za-z_-]*[[:space:]]*[:=][[:space:]]*)([^$[:space:]"'"'"'][^[:space:]]*|"[^$"][^"]*"|'"'"'[^$'"'"'][^'"'"']*'"'"')/\1***MASKED***/Ig'; }
cd /opt/mgpl
echo "=== ls -la data-preprod data-test"; ls -la --time-style=+%FT%T%z data-preprod data-test
echo "=== df -h (data dirs, /)"; df -h /opt/mgpl/data-preprod /opt/mgpl/data-test /
echo "=== app container DB mounts + DB_PATH/NODE_ENV"
for c in mgpl-preprod-app mgpl-test-app; do echo "[$c]"; docker inspect -f '{{range .Mounts}}  {{.Source}} -> {{.Destination}}{{println}}{{end}}' $c; docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $c | grep -E '^(DB_PATH|NODE_ENV|DATABASE_URL)=' | sed -E 's/^(DATABASE_URL=).*/\1***present***/'; done
echo "=== deployed docker-compose.preprod.yml"; cat docker-compose.preprod.yml | mask
echo "=== deployed litestream.preprod.yml"; cat litestream.preprod.yml | mask
echo "=== deployed litestream.yml"; cat litestream.yml | mask
echo "=== litestream images / systemd / binaries / cron"
docker images --format '{{.Repository}}:{{.Tag}}\t{{.CreatedSince}}' | grep -i litestream || echo "(no litestream image present)"
systemctl list-units --all --no-pager 2>/dev/null | grep -i -E 'litestream|cloudflared|mgpl' ; systemctl list-unit-files --no-pager 2>/dev/null | grep -i litestream || echo "(no litestream systemd unit)"
command -v litestream || echo "(no litestream binary on host)"; ls /etc/litestream* 2>/dev/null
crontab -l 2>/dev/null | grep -v '^#' | mask; ls /etc/cron.d 2>/dev/null
echo "=== docker events for litestream (last 30d)"; timeout 5 docker events --since 720h --until 0s --filter 'image=litestream/litestream:0.3' --format '{{.Time}} {{.Action}} {{.Actor.Attributes.name}}' 2>&1 | tail -20
echo "=== end"; date -u +%FT%TZ
```

### list-replicas.mjs

```
// Read-only S3 ListObjectsV2 over R2 and B2 (SigV4, no SDK). Prints keys/timestamps only.
import { createHash, createHmac } from 'node:crypto';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const hmac = (k, s) => createHmac('sha256', k).update(s).digest();

async function list(ep, bucket, ak, sk, params) {
  const url = new URL(ep.replace(/\/$/, '') + '/' + bucket);
  const qs = Object.entries({ 'list-type': '2', ...params })
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = now.slice(0, 8);
  const region = ep.includes('backblazeb2.com') ? ep.match(/s3\.([^.]+)\.backblazeb2/)[1] : 'auto';
  const hdrs = { host: url.host, 'x-amz-content-sha256': sha(''), 'x-amz-date': now };
  const signed = Object.keys(hdrs).sort().join(';');
  const canonHeaders = Object.keys(hdrs).sort().map((k) => `${k}:${hdrs[k]}\n`).join('');
  const canon = ['GET', url.pathname, qs, canonHeaders, signed, hdrs['x-amz-content-sha256']].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', now, scope, sha(canon)].join('\n');
  const key = ['s3', 'aws4_request'].reduce(hmac, hmac(hmac('AWS4' + sk, date), region));
  const sig = createHmac('sha256', key).update(sts).digest('hex');
  const res = await fetch(`${url}?${qs}`, { headers: { ...hdrs, authorization: `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signed}, Signature=${sig}` } });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(body.match(/<Code>([^<]*)<\/Code>/) || [])[1] || 'unknown'} ${(body.match(/<Message>([^<]*)<\/Message>/) || [])[1] || ''}`);
  return body;
}
const all = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);

async function listAll(ep, bucket, ak, sk, prefix) {
  const out = []; let token;
  do {
    const xml = await list(ep, bucket, ak, sk, { prefix, ...(token ? { 'continuation-token': token } : {}) });
    for (const c of all(xml, 'Contents')) out.push({ key: all(c, 'Key')[0], mod: all(c, 'LastModified')[0], size: +all(c, 'Size')[0] });
    token = (xml.match(/<NextContinuationToken>([^<]*)</) || [])[1];
  } while (token);
  return out;
}

for (const [name, p, bucket] of [['R2', 'R2', 'mgpl-db-replica'], ['B2', 'B2', 'mgpl-db-backup']]) {
  const rawEp = process.env[`${p}_ENDPOINT`];
  // Listing-client normalisation only: Doppler value is not modified.
  const ep = rawEp && !/^https?:\/\//.test(rawEp) ? `https://${rawEp}` : rawEp;
  if (ep !== rawEp) console.log(`(note: ${p}_ENDPOINT has no scheme; listing client prefixed https://)`);
  const ak = process.env[`${p}_ACCESS_KEY_ID`], sk = process.env[`${p}_SECRET_ACCESS_KEY`];
  console.log(`\n##### ${name} bucket=${bucket} (listed ${new Date().toISOString()})`);
  if (!ep || !ak || !sk) { console.log('credentials missing from environment'); continue; }
  try {
    const top = await list(ep, bucket, ak, sk, { delimiter: '/' });
    const prefixes = all(top, 'Prefix').filter(Boolean);
    const rootKeys = all(top, 'Key');
    console.log(`top-level prefixes: ${prefixes.length ? prefixes.join(', ') : '(none)'}; root objects: ${rootKeys.length}`);
    for (const pre of prefixes) {
      const objs = await listAll(ep, bucket, ak, sk, pre);
      const gens = {};
      for (const o of objs) {
        const g = (o.key.match(/generations\/([0-9a-f]+)\//) || [])[1] || '(non-generation)';
        const e = (gens[g] ||= { snaps: 0, wal: 0, bytes: 0, first: o.mod, last: o.mod });
        if (/\/snapshots\//.test(o.key)) e.snaps++; else if (/\/wal\//.test(o.key)) e.wal++;
        e.bytes += o.size; if (o.mod < e.first) e.first = o.mod; if (o.mod > e.last) e.last = o.mod;
      }
      console.log(`  ${pre}  objects=${objs.length}`);
      for (const [g, e] of Object.entries(gens).sort((a, b) => (a[1].last < b[1].last ? 1 : -1)))
        console.log(`    generation ${g}: snapshots=${e.snaps} wal=${e.wal} bytes=${e.bytes} first=${e.first} newest=${e.last}`);
    }
  } catch (err) { console.log(`ERROR: ${err.message}`); }
}
```

## 4. Read-only table counts and integrity check (2026-09-23T14:24:56Z)

Opened with better-sqlite3 `{ readonly: true, fileMustExist: true }` via `docker exec` in each app container. No checkpoint, write, or VACUUM. Size, mtime and sha256 (first 16 hex) of `.db`, `-wal`, `-shm` captured before and after.

```text
=== BEFORE 2026-09-23T14:24:56Z
/opt/mgpl/data-preprod/mgpl-preprod.db  size=4096  mtime=2026-09-10 18:30:17.974085346 +0000  sha256=97e8d54f8a725510
/opt/mgpl/data-preprod/mgpl-preprod.db-shm  size=32768  mtime=2026-09-10 18:30:17.979085362 +0000  sha256=89348be21a60330d
/opt/mgpl/data-preprod/mgpl-preprod.db-wal  size=2039432  mtime=2026-09-10 18:30:18.059085605 +0000  sha256=15a19f5dc0ee15ab
/opt/mgpl/data-test/mgpl-test.db  size=4096  mtime=2026-09-10 18:29:26.328928322 +0000  sha256=97e8d54f8a725510
/opt/mgpl/data-test/mgpl-test.db-shm  size=32768  mtime=2026-09-10 18:29:26.334928340 +0000  sha256=8082d7333cf37988
/opt/mgpl/data-test/mgpl-test.db-wal  size=2039432  mtime=2026-09-10 18:29:26.416928589 +0000  sha256=f969f99bda344c02

=== [mgpl-preprod-app] /data/mgpl-preprod.db  2026-09-23T14:24:56Z
open: /data/mgpl-preprod.db readonly=true journal_mode=wal
tables: 39
  AppBacklog                              0
  AppCompletionRoadmapCache               0
  AppDealPriceHistory                     0
  AppDealsWishlist                        0
  AppDevices                              0
  AppFriendships                          0
  AppGameNotes                            0
  AppGameTags                             0
  AppGames                                0
  AppOwnership                            0
  AppPlatformHandles                      0
  AppPlaySessions                         0
  AppPriceAlerts                          0
  AppRetroTracking                        0
  AppTracking                             0
  AppWishlist                             0
  AuthAccounts                            0
  AuthPlatformLinks                       0
  AuthUsers                               1
  Devices                                 0
  InstalledMods                           0
  ModDependencies                         5
  ModLoadOrder                            18
  ModVersions                             35
  Mods                                    0
  analytics_access_logs                   0
  catalog_device_specs                    58
  catalog_devices                         58
  community_benchmarks                    45
  compatibility_rules                     4
  device_builds                           0
  device_components                       51
  device_reviews                          5
  game_performance_profiles               0
  hardware_price_history                  2340
  platform_audit_logs                     0
  release_radar                           16
  review_votes                            0
  sqlite_sequence                         6
integrity_check: ok

=== [mgpl-test-app] /data/mgpl-test.db  2026-09-23T14:24:56Z
open: /data/mgpl-test.db readonly=true journal_mode=wal
tables: 39
  AppBacklog                              0
  AppCompletionRoadmapCache               0
  AppDealPriceHistory                     0
  AppDealsWishlist                        0
  AppDevices                              0
  AppFriendships                          0
  AppGameNotes                            0
  AppGameTags                             0
  AppGames                                0
  AppOwnership                            0
  AppPlatformHandles                      0
  AppPlaySessions                         0
  AppPriceAlerts                          0
  AppRetroTracking                        0
  AppTracking                             0
  AppWishlist                             0
  AuthAccounts                            0
  AuthPlatformLinks                       0
  AuthUsers                               1
  Devices                                 0
  InstalledMods                           0
  ModDependencies                         5
  ModLoadOrder                            18
  ModVersions                             35
  Mods                                    0
  analytics_access_logs                   0
  catalog_device_specs                    58
  catalog_devices                         58
  community_benchmarks                    45
  compatibility_rules                     4
  device_builds                           0
  device_components                       51
  device_reviews                          5
  game_performance_profiles               0
  hardware_price_history                  2340
  platform_audit_logs                     0
  release_radar                           16
  review_votes                            0
  sqlite_sequence                         6
integrity_check: ok

=== AFTER 2026-09-23T14:24:57Z
/opt/mgpl/data-preprod/mgpl-preprod.db  size=4096  mtime=2026-09-10 18:30:17.974085346 +0000  sha256=97e8d54f8a725510
/opt/mgpl/data-preprod/mgpl-preprod.db-shm  size=32768  mtime=2026-09-10 18:30:17.979085362 +0000  sha256=89348be21a60330d
/opt/mgpl/data-preprod/mgpl-preprod.db-wal  size=2039432  mtime=2026-09-10 18:30:18.059085605 +0000  sha256=15a19f5dc0ee15ab
/opt/mgpl/data-test/mgpl-test.db  size=4096  mtime=2026-09-10 18:29:26.328928322 +0000  sha256=97e8d54f8a725510
/opt/mgpl/data-test/mgpl-test.db-shm  size=32768  mtime=2026-09-10 18:29:26.334928340 +0000  sha256=8082d7333cf37988
/opt/mgpl/data-test/mgpl-test.db-wal  size=2039432  mtime=2026-09-10 18:29:26.416928589 +0000  sha256=f969f99bda344c02
```

### Script

```bash
snap() { for f in /opt/mgpl/data-preprod/mgpl-preprod.db* /opt/mgpl/data-test/mgpl-test.db*; do printf '%s  size=%s  mtime=%s  sha256=%s\n' "$f" "$(stat -c %s "$f")" "$(stat -c %y "$f")" "$(sha256sum "$f" | cut -c1-16)"; done; }
QUERY='
const Database = require("better-sqlite3");
const path = process.argv[1];
const db = new Database(path, { readonly: true, fileMustExist: true });
console.log("open:", path, "readonly=" + db.readonly, "journal_mode=" + db.pragma("journal_mode", { simple: true }));
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type=\x27table\x27 ORDER BY name").all().map(r => r.name);
console.log("tables:", tables.length);
for (const t of tables) console.log("  " + t.padEnd(40) + db.prepare("SELECT COUNT(*) AS n FROM \"" + t.replace(/"/g, "\"\"") + "\"").get().n);
console.log("integrity_check:", db.pragma("integrity_check").map(r => r.integrity_check).join("; "));
db.close();
'
echo "=== BEFORE $(date -u +%FT%TZ)"; snap
for pair in "mgpl-preprod-app /data/mgpl-preprod.db" "mgpl-test-app /data/mgpl-test.db"; do
  set -- $pair; echo; echo "=== [$1] $2  $(date -u +%FT%TZ)"
  docker exec -w /app "$1" node -e "$QUERY" "$2" 2>&1
done
echo; echo "=== AFTER $(date -u +%FT%TZ)"; snap
```
