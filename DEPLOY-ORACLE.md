# Deploying LiteChat on an Oracle Cloud Always Free VM

An always-on VM with a real disk, so rooms genuinely survive until their 30-day
idle expiry. Budget about 30 minutes for the first run.

You end up with: `https://chat.yourdomain.com` served by Caddy, which proxies to the
app container, with certificates renewed automatically and everything restarting on reboot.

---

## 0. Push the code to GitHub

From your machine, in the project folder:

```powershell
git init
git add .
git commit -m "LiteChat"
git branch -M main
git remote add origin https://github.com/<you>/litechat.git
git push -u origin main
```

Create the empty repo on GitHub first. `.gitignore` keeps `node_modules/`, `data/` and
`.env` out of it. If you make the repo private you will need a
[deploy key](https://docs.github.com/en/authentication/connecting-to-github-with-ssh)
or a personal access token to clone it on the VM in step 5.

---

## 1. Create the Oracle Cloud account

Sign up at <https://cloud.oracle.com>. Two things to know going in:

- A credit card is required for identity verification. Always Free resources are not
  charged, and the account does not auto-upgrade to paid unless you explicitly choose to.
- **Your home region cannot be changed later.** Pick the one closest to your users.

After signup you land on a 30-day trial with credits. When it expires the account
downgrades to Always Free and your VM keeps running, as long as it uses only
Always Free shapes.

---

## 2. Create the VM

**Compute → Instances → Create instance.**

| Setting | Value |
| --- | --- |
| Name | `litechat` |
| Image | Canonical **Ubuntu 22.04** |
| Shape | **VM.Standard.A1.Flex** (Ampere ARM) |
| OCPUs / Memory | 1 OCPU, 6 GB — plenty, and well inside the free allowance |
| VCN | Create new, with a **public subnet** |
| Assign public IPv4 | **Yes** |
| SSH keys | Generate a key pair and **download the private key** |

> **"Out of host capacity"** is a common error on A1 shapes in busy regions. Options:
> retry at a different hour, or use **VM.Standard.E2.1.Micro** instead — also Always Free,
> x86, 1 GB RAM. That is enough for this app; everything below works unchanged.

The free tier allows up to 4 OCPUs and 24 GB across A1 instances, plus two E2.1.Micro
instances. One small VM stays well within it.

Note the **public IP address** shown once the instance is running.

---

## 3. Open ports 80 and 443 — in two places

This is the step people miss. Oracle firewalls the VM at *both* the network layer and
inside the guest OS.

### 3a. The VCN security list

**Networking → Virtual Cloud Networks →** your VCN **→ Subnets →** your subnet
**→ Security Lists →** the default list **→ Add Ingress Rules.**

Add two rules:

| Stateless | Source CIDR | IP Protocol | Destination Port Range |
| --- | --- | --- | --- |
| No | `0.0.0.0/0` | TCP | `80` |
| No | `0.0.0.0/0` | TCP | `443` |

### 3b. The VM's own firewall

Do this after you SSH in (next step). Ubuntu images on Oracle ship with restrictive
`iptables` rules that silently drop web traffic.

The new rules must land **above** the chain's `REJECT` rule. iptables stops at the first
match, so a rule below the REJECT is never reached — the ports look open in `iptables -L`
and nothing gets through. The REJECT's line number differs between images, so look it up
rather than assuming:

```bash
sudo iptables -L INPUT -n --line-numbers          # note the REJECT line number
```

Insert at that number (replace `5` if yours differs):

```bash
sudo iptables -I INPUT 5 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 5 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
sudo iptables -L INPUT -n --line-numbers          # both ACCEPTs must be ABOVE the REJECT
```

Already added them below the REJECT? Delete first, highest number first so the numbering
does not shift under you:

```bash
sudo iptables -D INPUT 7
sudo iptables -D INPUT 6
```

On **Oracle Linux** instead:

```bash
sudo firewall-cmd --permanent --add-service=http --add-service=https
sudo firewall-cmd --reload
```

If HTTPS later fails to provision, this is almost always the cause.

---

## 4. Connect and install Docker

```bash
chmod 600 ~/Downloads/ssh-key.key          # on macOS/Linux
ssh -i ~/Downloads/ssh-key.key ubuntu@<PUBLIC_IP>
```

On Windows with PowerShell, `ssh -i C:\path\to\ssh-key.key ubuntu@<PUBLIC_IP>` works the
same; if OpenSSH complains the key is too open, right-click the file → Properties →
Security → remove inherited permissions and leave only your user.

Then, on the VM:

```bash
sudo apt update && sudo apt upgrade -y

# Docker Engine + the compose plugin, from Docker's official repository
curl -fsSL https://get.docker.com | sudo sh

# run docker without sudo
sudo usermod -aG docker $USER
newgrp docker

docker --version && docker compose version
```

Now run the firewall commands from step 3b.

---

## 5. Clone and configure

```bash
git clone https://github.com/<you>/litechat.git
cd litechat

cp .env.example .env
nano .env
```

Set both values:

```
DOMAIN=chat.yourdomain.com
ACME_EMAIL=you@example.com
```

`DOMAIN` must be the exact hostname you will use — Caddy requests a certificate for
precisely this name. `ACME_EMAIL` is where Let's Encrypt sends expiry warnings.

---

## 6. Point DNS at the VM

In Cloudflare (or wherever your DNS lives), add:

| Type | Name | Value | Proxy status |
| --- | --- | --- | --- |
| `A` | `chat` | your VM's public IP | **DNS only** (grey cloud) |

Grey cloud matters right now: Caddy proves it controls the domain over plain HTTP, and
that check has to reach your VM directly. You can enable Cloudflare's proxy afterwards
(see step 9).

Confirm it has propagated before continuing:

```bash
dig +short chat.yourdomain.com     # should print your VM's IP
```

---

## 7. Start it

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

The first build takes a few minutes on ARM. Then:

```bash
docker compose -f docker-compose.prod.yml logs -f
```

You are looking for two things:

```
litechat-1  | LiteChat listening on http://0.0.0.0:3000
litechat-1  | storage: disk (DATA_DIR=/data)
caddy-1     | certificate obtained successfully
```

`Ctrl-C` stops following the logs; the containers keep running.

Open `https://chat.yourdomain.com`. Create a room in one browser, join it from another
device with the code, and send a message — that confirms the WebSocket upgrade is
passing through Caddy.

---

## 8. Confirm it survives a reboot

Worth doing once, since it is the whole point of this path:

```bash
sudo reboot
# wait ~40 seconds, reconnect
ssh -i ~/Downloads/ssh-key.key ubuntu@<PUBLIC_IP>
docker ps        # both containers should be up again
```

`restart: unless-stopped` brings them back with the Docker daemon. Your rooms are still
there, restored from the snapshot on the volume.

---

## 9. Optional: turn on the Cloudflare proxy

Once HTTPS works, you can put Cloudflare in front for DDoS protection and to hide the
VM's IP.

1. Cloudflare → **SSL/TLS → Overview → Full (strict)**. Do this **first** — any other
   mode gives you a redirect loop or a broken padlock.
2. Flip the `A` record's cloud icon to orange.

WebSockets pass through Cloudflare's proxy on the free plan, and its 100-second proxy
timeout does not apply to them, so chat connections stay open.

---

## Running it day to day

**Deploy a change:**

```bash
cd ~/litechat
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

Rooms survive this — they live on a Docker volume, not in the image.

**Logs:**

```bash
docker compose -f docker-compose.prod.yml logs -f litechat
docker compose -f docker-compose.prod.yml logs -f caddy
```

**Health check:**

```bash
curl https://chat.yourdomain.com/api/health
# {"ok":true,"rooms":3,"persistent":true}
```

**Back up the rooms:**

```bash
docker compose -f docker-compose.prod.yml cp litechat:/data/rooms.json ./rooms-backup.json
```

**Stop / start:**

```bash
docker compose -f docker-compose.prod.yml down     # stop, keep the volumes
docker compose -f docker-compose.prod.yml up -d    # start again
```

Never run `down -v` unless you mean it — that deletes the rooms *and* Caddy's
certificates, and re-requesting certificates too often hits Let's Encrypt rate limits.

---

## When something is wrong

| Symptom | Cause |
| --- | --- |
| Site does not load at all | Ports 80/443 not open. Check **both** the VCN security list and `sudo iptables -L INPUT -n --line-numbers` on the VM. |
| Caddy logs a certificate failure | Port 80 unreachable from the internet, DNS not yet pointing at the VM, or Cloudflare's proxy left on. Fix, then `docker compose -f docker-compose.prod.yml restart caddy`. |
| `dig` returns the wrong IP or nothing | DNS has not propagated, or the record is proxied. Wait, or set the record to DNS only. |
| Page loads but messages never send | Something between you and Caddy is blocking WebSockets — a corporate proxy, or `Full (strict)` not set if you enabled the Cloudflare proxy. |
| `permission denied` on `docker` | You skipped `newgrp docker`, or need to log out and back in. |
| Build killed partway on E2.1.Micro | 1 GB of RAM is tight. Add swap: `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`. |

---

## What this costs

Nothing, as long as you stay on Always Free shapes. The VM, its boot volume, and 10 TB
of monthly egress are all inside the free allowance, and this app uses a rounding error
of that. Watch that you do not create extra block volumes or a load balancer — those are
the things that quietly start billing.
