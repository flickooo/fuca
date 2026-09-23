# Fudbal Text ⚽

Teletext-styled app that replaces the WhatsApp poll: everyone taps **I'm in / I'm out**, the admin picks teams on a pitch view and shares them back to the group.

No dependencies — just Node.js 22.13+ (uses the built-in SQLite).

## Run locally

```bash
ADMIN_PHONE="+381641234567" ADMIN_NAME="Aleksandar" GROUP_PASSWORD="yourpassword" npm start
# open http://localhost:3000
```

`ADMIN_PHONE` / `ADMIN_NAME` create the first admin (only when the database is empty).
`GROUP_PASSWORD` sets the initial shared password (default `fudbal`); change it later in **Admin → Settings**.

## Deploy (pick one)

The app keeps its data in a SQLite file in `DATA_DIR`, so the host **must have a persistent disk/volume**.

**Railway** (easiest): New project → Deploy from GitHub repo (or `railway up`) → add a *Volume* mounted at `/data` → set variables `DATA_DIR=/data`, `ADMIN_PHONE`, `ADMIN_NAME`, `GROUP_PASSWORD` → Generate domain.

**Fly.io**: `fly launch` (uses the Dockerfile) → `fly volumes create data --size 1` → mount it at `/data` in `fly.toml` → `fly secrets set ADMIN_PHONE=... GROUP_PASSWORD=...` → `fly deploy`.

**Any VPS / home server**: `docker build -t fudbal . && docker run -d -p 3000:3000 -v fudbal-data:/data -e ADMIN_PHONE=... -e GROUP_PASSWORD=... fudbal`

⚠️ Render's free tier has no persistent disk — data would be wiped on each deploy.

Backup = copy `fudbal.db` from the data folder.

## How it works

- **Login**: phone number + group password. Only numbers on the squad list can log in. `+381 64…`, `064…` and `0038164…` all match (last 8 digits compared). Stays logged in for a year.
- **Next Match**: big IN / OUT buttons. First come, first served — anyone past `2 × team size` goes on the waiting list and moves up automatically when someone drops out. Admins can set anyone's status (for people who still reply in WhatsApp).
- **Line-up** (admin): pick a formation per team, tap a player then tap a position (drag & drop on desktop), 4 sub slots per side. **Auto-balance** splits players by ability and keeps goalkeepers apart. Save as draft (admins only) or **Publish**, then **Share** the teams to WhatsApp.
- **Fixtures / Stats**: after the game set the match to *played* + score. Stats table: apps, W/D/L, win %, goal difference, points, sign-ups.
- **Admin**: squad (add / bulk add / edit phone, position, ability 1–5, admin flag, deactivate), matches, group password, invite link.
