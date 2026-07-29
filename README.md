# NCST RFID Backend

TypeScript + Express + MongoDB backend for the NCST campus RFID gate & attendance system.
Handles person/vehicle registration, RFID gate scans, attendance logging, authentication,
and reporting.

Companion frontend: [`ncst_rfid_access`](https://github.com/moi-script/ncst_rfid_access).
See `../userpage/ncst_rfid_serverside_flow.md` for the full API blueprint.

## Tech stack

- **Node.js 20+ / Express** (TypeScript)
- **MongoDB / Mongoose**
- **JWT** auth (15m access token in body, 7d refresh token in an httpOnly cookie with rotation)
- **bcrypt** password hashing, **Zod** validation
- Helmet, CORS, rate limiting, morgan logging

## Setup

```bash
npm install
cp .env.example .env   # fill in MONGODB_URI, JWT secrets, admin creds
npm run seed           # creates admin + 4 gates (run once)
npm run dev            # start with hot reload
```

The API listens on `http://localhost:3000` (health check at `GET /health`).
`.env` is gitignored — never commit real secrets. Generate strong ones with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Required environment variables

| Variable | Description |
|----------|-------------|
| `MONGODB_URI` | MongoDB connection string |
| `JWT_ACCESS_SECRET` | Secret for signing access tokens |
| `JWT_REFRESH_SECRET` | Different secret for refresh tokens |
| `PORT` | API port (default `3000`) |
| `API_PREFIX` | Route prefix (default `/api`) |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins (e.g. `http://localhost:5173`) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Seed admin credentials |
| `LOGIN_RATE_LIMIT_MAX` | Max `/auth/login` requests per 15 min (default `10`). `npm run verify:roles` makes 6 login calls per run, so running it twice in a row needs at least `20`. |

## Scripts

- `npm run dev` — ts-node-dev hot reload
- `npm run build` — compile to `dist/`
- `npm start` — run compiled server
- `npm run seed` — seed admin + gates (idempotent)
- `npm run seed:test` — seed hardcoded test accounts for the testing phase (idempotent)
- `npm run lint` — eslint

### Troubleshooting

- **Server fails to start with an index error on `occupancies`.** The
  `entity_type_1_entity_id_1` unique index is what makes anti-passback
  detection atomic, and `server.ts` now refuses to start until it exists. If
  the `occupancies` collection has duplicate `{entity_type, entity_id}` rows
  from a run that predates the index, the build fails permanently against
  that duplicate data. Drop the collection and let it rebuild (or run the
  rebuild script once one exists in a later task).

## Test accounts (`npm run seed:test`)

For the testing phase, `seed:test` inserts a hardcoded superadmin, a registrar, three
students, and one staff member. Each student/staff person is a `Person` (profile + RFID)
linked to a `User` login whose **username is the student/employee number**.

| Role | Username | Password |
|------|----------|----------|
| Superadmin | `testadmin` | `Admin@123` |
| Registrar | `testregistrar` | `Registrar@123` |
| Student — Juan Dela Cruz | `2025-0001` | `Student@123` |
| Student — Maria Santos | `2025-0002` | `Student@123` |
| Student — Pedro Reyes | `2025-0003` | `Student@123` |
| Staff — Ana Villanueva | `EMP-1001` | `Staff@123` |

> Demo credentials for local testing only.

### Gate terminals

Each of the four gates has a fixed `type` (person/vehicle) and `direction`
(entry/exit). A terminal authenticates with a per-gate device key sent as
`X-Gate-Key`; the server derives the gate and direction from the key, so a
terminal posts only `{ rfid_uid }`.

- `POST /gates/:id/key` (superadmin) mints a key and revokes that gate's
  previous ones. The plaintext is returned once and is not recoverable.
- `npm run seed:test` prints one key per gate for local development the first
  time it runs; on later runs it skips minting for any gate that already has
  an active key, so it prints nothing for gates it has already provisioned.
- `npm run verify:gates` asserts the photo pipeline and gate behavior. It mints
  its own keys, so terminals provisioned beforehand need re-provisioning after.

### Photos

`POST /persons/:id/photo` (registrar/superadmin, multipart field `photo`, 1MB
cap) stores bytes in the `personphotos` collection and sets `photo_url` to
`/persons/<id>/photo`. Uploads are classified by magic bytes, not by the
declared Content-Type. `GET /persons/:id/photo` accepts a user JWT or a gate
key.

### Attendance date bucketing (local time, not UTC)

`scanService.dateKey()` buckets attendance by the **server's local calendar
date** (`Date#getFullYear/getMonth/getDate`), and `isLate()` compares against
`LATE_CUTOFF_TIME` in local hours via `Date#setHours`. Neither uses UTC.

Any consumer that computes "today" in UTC — for example
`new Date().toISOString().slice(0, 10)` — will compute a different calendar
day than the server for part of every day in any timezone that isn't UTC+0,
and will silently query the wrong attendance bucket. This is not a corner
case: it caused a real intermittent test failure during development. When
building a client, script, or test against `/attendance`, derive the date
key the same way the server does (local `Date` components), never via
`toISOString()`.

## Data model

- **Person** — a student/staff/employee profile with an `rfid_uid` and `id_number`.
- **User** — a login account with one of four roles: `superadmin` (full control,
  including single and bulk activate/deactivate), `registrar` (registers people and
  creates their logins), `staff`, and `student` (own profile only). A person's login
  links to their profile via `person_id`.
- **Vehicle**, **Gate**, **ScanLog**, **AttendanceSummary** — RFID and attendance records.

## API overview

All routes are prefixed with `API_PREFIX` (default `/api`).

| Area | Base path | Notes |
|------|-----------|-------|
| Auth | `/api/auth` | `POST /login`, `POST /refresh`, `POST /logout` |
| Persons | `/api/persons` | CRUD for people |
| Vehicles | `/api/vehicles` | CRUD for vehicles |
| Gates | `/api/gates` | Gate management |
| Scan | `/api/scan` | RFID scan ingestion |
| Attendance | `/api/attendance` | Attendance records |
| Users | `/api/users` | User account management (admin). `POST /users` requires an explicit `role` — it has no default. |
| Logs | `/api/logs` | Scan/audit logs |
| Dashboard | `/api/dashboard` | Role-aware summary (admin stats vs. student view) |
| Reports | `/api/reports` | Reporting endpoints |

### Auth flow

`POST /api/auth/login` with `{ "username", "password" }` returns:

```json
{ "success": true, "data": { "accessToken": "<jwt>", "user": { "id", "username", "role", "personId", "mustChangePassword" } } }
```

Send the access token as `Authorization: Bearer <accessToken>` on protected routes.

## Project structure

```
src/
  app.ts            # Express app + middleware wiring
  server.ts         # bootstrap / listen
  config/           # env, db, seed, testSeed
  constants/        # roles, error codes
  middlewares/      # auth, validation, rate limiting, errors
  modules/          # feature modules (auth, persons, vehicles, gates, scan, ...)
  utils/            # ApiError, ApiResponse, pagination helpers
```

Each module follows a `routes → controller → service → repository → model` layering.

## Notes

- No public registration. The superadmin is seeded; registrars and user logins are created through the API.
- Access token (15m) in response body; refresh token (7d) in httpOnly cookie with rotation.
- `scan/tap` always returns HTTP 200; `granted`/`denied` is in the body.
- After first seed, remove `ADMIN_PASSWORD` from the production `.env`.
