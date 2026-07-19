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

## Scripts

- `npm run dev` — ts-node-dev hot reload
- `npm run build` — compile to `dist/`
- `npm start` — run compiled server
- `npm run seed` — seed admin + gates (idempotent)
- `npm run seed:test` — seed hardcoded test accounts for the testing phase (idempotent)
- `npm run lint` — eslint

## Test accounts (`npm run seed:test`)

For the testing phase, `seed:test` inserts a hardcoded admin plus three students. Each
student is a `Person` (profile + RFID) linked to a `User` login whose **username is the
student number**.

| Role | Username | Password |
|------|----------|----------|
| Admin | `testadmin` | `Admin@123` |
| Student — Juan Dela Cruz | `2025-0001` | `Student@123` |
| Student — Maria Santos | `2025-0002` | `Student@123` |
| Student — Pedro Reyes | `2025-0003` | `Student@123` |

> Demo credentials for local testing only.

## Data model

- **Person** — a student/staff/employee profile with an `rfid_uid` and `id_number`.
- **User** — a login account (`role: admin | user`); a student login links to its Person via `person_id`.
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
| Users | `/api/users` | User account management (admin) |
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

- No public registration — admin is seeded, users are admin-created.
- Access token (15m) in response body; refresh token (7d) in httpOnly cookie with rotation.
- `scan/tap` always returns HTTP 200; `granted`/`denied` is in the body.
- After first seed, remove `ADMIN_PASSWORD` from the production `.env`.
