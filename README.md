# NCST RFID Backend

TypeScript + Express + MongoDB (Atlas) backend for the NCST campus RFID gate system.
See `../userpage/ncst_rfid_serverside_flow.md` for the full API blueprint.

## Setup

```bash
npm install
cp .env.example .env   # fill in MONGODB_URI, JWT secrets, admin creds
npm run seed           # creates admin + 4 gates (run once)
npm run dev            # start with hot reload
```

## Scripts

- `npm run dev` — ts-node-dev hot reload
- `npm run build` — compile to `dist/`
- `npm start` — run compiled server
- `npm run seed` — seed admin + gates (idempotent)
- `npm run lint` — eslint

## Notes

- No public registration — admin is seeded, users are admin-created.
- Access token (15m) in response body; refresh token (7d) in httpOnly cookie with rotation.
- `scan/tap` always returns HTTP 200; `granted`/`denied` is in the body.
- After first seed, remove `ADMIN_PASSWORD` from the production `.env`.
