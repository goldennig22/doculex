# Deploying DocuLex

CI builds a Docker image per commit on `main` (`registry.gitlab.com/<namespace>/doculex:<sha>`).
The VPS never builds anything: it pulls that image, migrates, restarts, and checks health.

```
push to main ─► lint ─► typecheck ─► test ─► build_image ─► deploy_to_vps (when DEPLOY_ENABLED=true)
                                               │                 │ scp compose file + scripts
                                               ▼                 ▼ ssh: deploy.sh <sha>
                                      GitLab registry ◄── pull ── VPS /opt/doculex
                                                                   ├─ db  (pgvector:pg17, no published port)
                                                                   └─ app (127.0.0.1:5100) ◄── nginx :443 ◄── internet
```

| File | On the VPS | Purpose |
| --- | --- | --- |
| `docker-compose.prod.yml` | `/opt/doculex/docker-compose.yml` | db + app, private network, memory limits, log rotation |
| `deploy.sh` | `/opt/doculex/deploy.sh` | pull → migrate → start → require `"status":"ok"` → auto-rollback |
| `db-init/01-init.sh` | `/opt/doculex/db-init/` | first start only: `doculex_app` role (not superuser), database, pgvector |
| `backup.sh`, `restore-test.sh` | `/opt/doculex/` | nightly `pg_dump`, 7-day retention; restore drill |
| `env.example`, `app.env.example` | `.env`, `app.env` (by hand, chmod 600) | compose variables; app secrets |
| `nginx/doculex.conf` | `/etc/nginx/sites-available/` | reverse proxy to `127.0.0.1:5100` |

CI copies the compose file and scripts on every deploy. Never edit them on the server: change them in git.

---

## One-time setup

### 0. Check the existing Postgres container (do this today)

```bash
docker ps --format '{{.Names}}\t{{.Ports}}'
```

If it shows `0.0.0.0:5432->5432/tcp`, that database can be reached from the internet **even if UFW blocks 5432**.
Docker writes its own iptables rules, and they come before UFW's. Change its mapping to `127.0.0.1:5432:5432`.
DocuLex's database publishes no port at all.

### 1. Protect `main`, then add the CI/CD variables

**Lesson: why a protected variable needs a protected branch.** A *protected* variable is only given to pipelines
that run on a protected branch or tag. The variable is safe only if the code that can read it is controlled.
Anyone who can push *any* branch can also edit `.gitlab-ci.yml` on that branch, for example
`script: echo $SSH_PRIVATE_KEY_B64 | rev`. Masking only hides the exact value in logs; a reversed or re-encoded
copy prints in plain sight. Protecting the variable keeps it away from those branches. Protecting `main`
(only Maintainers push or merge) means the one place that sees it runs only reviewed CI config.
Working alone this still matters: a leaked personal access token, or a future collaborator with Developer
access, can push branches but cannot push `main`.

- Settings → Repository → Protected branches: `main`, push and merge = Maintainers.
- Settings → CI/CD → Variables: the list at the top of `.gitlab-ci.yml`. Mark the SSH key and host details
  **Protected**, and the key **Masked** too. Leave `DEPLOY_ENABLED` unset for now.
- Settings → Packages and registries → Cleanup policies: keep the 10 most recent tags. GitLab's
  "Rollback environment" re-runs an old deploy job, which can only pull images that still exist.

### 2. A deploy user and key on the VPS

```bash
# On your PC: a key used only by CI, no passphrase (CI can't type one)
ssh-keygen -t ed25519 -f doculex_deploy -C "gitlab-ci doculex" -N ""
base64 -w0 doculex_deploy     # -> SSH_PRIVATE_KEY_B64 in GitLab; then delete the private key file from your PC

# On the VPS
sudo adduser --disabled-password deploy-doculex
sudo usermod -aG docker deploy-doculex
sudo install -d -o deploy-doculex -g deploy-doculex -m 700 /opt/doculex /var/backups/doculex
# append doculex_deploy.pub to /home/deploy-doculex/.ssh/authorized_keys (dir 700, file 600)
```

Be aware: membership of the `docker` group is equivalent to root (`docker run -v /:/host ...`). So the CI key can
effectively act as root on the VPS. That is why it is a dedicated key, kept only in a protected variable.
Possible later hardening: a `command="..."` restriction in `authorized_keys`.

### 3. Pin the host key: `SSH_KNOWN_HOSTS`

**Lesson: what known_hosts protects against.** SSH authenticates both sides. Your key proves *you* to the
server; the server's **host key** proves *the server* to you. Suppose the runner connects to `VPS_IP` without
a pinned host key (`StrictHostKeyChecking=no`). Then anyone who can sit between them (a compromised router,
hijacked DNS, an IP reassigned after you change VPS) can present their own server. The deploy job would
copy your files to it and accept its fake "health ok". Your private key isn't stolen: the signature is bound
to that one session. But you would be deploying to an impostor and reading its answers.
With a pinned entry, ssh aborts with `REMOTE HOST IDENTIFICATION HAS CHANGED`.

`ssh-keyscan` only asks the network "what key do you have?", so check its answer through a channel you
already trust (your existing SSH session, or the provider's web console):

```bash
ssh-keyscan -p 22 <VPS_IP> 2>/dev/null > vps_known_hosts      # on your PC
ssh-keygen -lf vps_known_hosts                                  # fingerprints it received
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub           # ON the VPS: must match the ed25519 line
```

If the fingerprints match, paste the contents of `vps_known_hosts` into `SSH_KNOWN_HOSTS`.

### 4. Registry access from the VPS

Settings → Repository → Deploy tokens: name `vps-pull`, scope **read_registry** only. Then on the VPS:

```bash
sudo -iu deploy-doculex
docker login registry.gitlab.com -u <token-username>   # paste the token; stored in ~/.docker/config.json
```

The token can only pull, so if it leaks, nothing can be pushed with it.

### 5. Secrets on the server

```bash
cd /opt/doculex
# copy deploy/env.example -> .env and deploy/app.env.example -> app.env, fill them in
chmod 600 .env app.env
```

Choose a `DOCULEX_HOST_PORT` that no other app uses (`ss -ltnp | grep 5100`). Check that the subnet
`172.28.50.0/24` in the compose file is free (the command is in the file's comment). If you change it, change
`TRUST_PROXY` to the new gateway.

### 6. Spending caps — before the URL is public

`/ask` is the only route that costs money, and the rate limit is only 10 per minute per IP. Someone with a few
IPs can still run up a bill.

- **Anthropic:** Console → create a workspace `doculex-prod` → set its **monthly spend limit** → create the API key
  *inside that workspace*. A leaked key or a loop can then only spend that workspace's limit.
- **The fallback chain changes this.** When Anthropic refuses because of the cap, DocuLex falls back to OpenAI,
  then Gemini, by design. So cap those too: an OpenAI project with a budget, and Google Cloud billing budgets.
  Check whether each one is a hard stop or only an email alert. If a provider only alerts, consider leaving its
  key out of `app.env` (that fallback then fails, and the queries table logs it).
- Gemini embeddings run on every `/ask`, including refused questions.

### 7. nginx and HTTPS

**Lesson: what a reverse proxy does.** One public process (nginx) owns ports 80/443 for the whole VPS. It
**terminates TLS** (holds the certificate, decrypts HTTPS), reads the `Host` header to pick a site
(DocuLex, your other projects), and forwards plain HTTP to that app on `127.0.0.1`. The apps never face the
internet. They have no certificates to manage, can't be reached around the proxy, and size limits and timeouts
are enforced in one place. The cost: every request now comes *from* the proxy. The client's real IP is in
`X-Forwarded-For`, and Fastify only believes that header from the proxy's address (`TRUST_PROXY`).
In this setup the proxy's address as the container sees it is the Docker gateway `172.28.50.1`, not
`127.0.0.1`. This was verified: without `TRUST_PROXY`, every user would share one rate-limit bucket.

```bash
sudo cp doculex.conf /etc/nginx/sites-available/   # replace api.example.com first
sudo ln -s /etc/nginx/sites-available/doculex.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d <subdomain>                 # after the DNS A record points to the VPS
```

### 8. First deploy

Set `DEPLOY_ENABLED=true` and `DOCULEX_PUBLIC_URL`, then push to `main` (or re-run the latest pipeline).
On the first start, `db-init` creates the database. Then ingest the OHADA PDFs through the API.

Check that real client IPs reach the app: `docker compose logs app | grep remoteAddress`. It should show your
own IP, not `172.28.50.1`.

### 9. Backups

```bash
crontab -e    # as deploy-doculex
15 3 * * * /opt/doculex/backup.sh >> /opt/doculex/backup.log 2>&1
```

Then run the drill: `bash /opt/doculex/restore-test.sh`. It restores the newest dump into a throwaway container,
compares row counts, and runs a vector query. Run it monthly. A backup that has never been restored is only a hope.
These dumps sit on the same disk as the database, so also copy `/var/backups/doculex` off the VPS.

**A real restore** (data loss, not a drill):

```bash
cd /opt/doculex
docker compose stop app
docker compose exec -T db dropdb -U postgres doculex
docker compose exec -T db createdb -U postgres -O doculex_app doculex
docker compose exec -T db pg_restore -U postgres -d doculex --no-owner --role=doculex_app < /var/backups/doculex/doculex-<date>.dump
docker compose up -d app
```

---

## Day to day

| Situation | What happens / what to do |
| --- | --- |
| Push to main | Tests → image `:<sha>` → `deploy.sh <sha>` → public health check. |
| Build or tests fail | Nothing reaches the VPS. |
| Migration fails | `deploy.sh` stops before touching the app; the transaction is rolled back; the old version keeps serving. Pipeline fails. |
| New version unhealthy | `deploy.sh` restarts the previous image and fails. **The migration stays applied.** |
| Public check fails, local passed | App is running; look at nginx, DNS or the certificate. |
| Manual rollback | Operate → Environments → production → Rollback, or `bash /opt/doculex/deploy.sh <older-sha>`. |
| Which version runs? | `IMAGE_TAG` in `/opt/doculex/.env`; history in `deploy-history.log`. |

**Migrations must work with the previous release** (expand/contract). Rollback restores the code, never the
schema: Drizzle has no down migrations. Add a column, deploy, start using it; rename or drop only in a later
release, once nothing reads the old name.

### Zero-downtime: not now

`docker compose up -d` stops the old container and then starts the new one, so for about 2–10 seconds nginx returns 502.
Zero-downtime would need: two app containers at once with nginx switching between them only after the new one
is healthy (blue/green), graceful draining (already there: `app.close()` on SIGTERM), backward-compatible
migrations (above), and shared state for anything kept in memory (the rate-limit counters would split
between instances). For a portfolio API that you deploy yourself, a few seconds of 502 is an acceptable cost.
