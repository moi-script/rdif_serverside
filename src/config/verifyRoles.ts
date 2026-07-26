/**
 * Asserts the permission matrix in
 * docs/superpowers/specs/2026-07-26-role-system-design.md.
 *
 * Requires: `npm run dev` running, and `npm run seed:test` already applied.
 * Run with: npm run verify:roles
 */

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000/api';

const failures: string[] = [];
let checks = 0;

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = (await res.json()) as { data?: { accessToken?: string } };
  const token = body.data?.accessToken;
  if (!token) {
    throw new Error(`login failed for '${username}' (HTTP ${res.status})`);
  }
  return token;
}

async function request(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // Some responses have no body; the status is what matters.
  }
  return { status: res.status, json };
}

/**
 * A 401 is always a failure even when a denial was expected — it means the
 * token is broken, not that authorization worked.
 */
async function check(
  name: string,
  token: string,
  method: string,
  path: string,
  expected: number,
  body?: unknown
): Promise<void> {
  checks++;
  const { status } = await request(token, method, path, body);
  if (status === 401 && expected !== 401) {
    failures.push(`${name}: got 401 (bad token) — expected ${expected}`);
    console.log(`  FAIL ${name} — 401, expected ${expected}`);
    return;
  }
  if (status !== expected) {
    failures.push(`${name}: got ${status}, expected ${expected}`);
    console.log(`  FAIL ${name} — ${status}, expected ${expected}`);
    return;
  }
  console.log(`  ok   ${name} — ${status}`);
}

function expectEqual(name: string, actual: unknown, expected: unknown): void {
  checks++;
  if (actual !== expected) {
    failures.push(`${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    console.log(`  FAIL ${name} — ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    return;
  }
  console.log(`  ok   ${name}`);
}

function summary(): void {
  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('All role checks passed.');
}

const OK = 200;
const FORBIDDEN = 403;

async function main(): Promise<void> {
  const superadmin = await login('testadmin', 'Admin@123');
  const registrar = await login('testregistrar', 'Registrar@123');
  const student = await login('2025-0001', 'Student@123');
  const staff = await login('EMP-1001', 'Staff@123');

  console.log('\n== persons: superadmin and registrar may read ==');
  for (const [name, token] of [
    ['superadmin', superadmin],
    ['registrar', registrar],
  ] as const) {
    await check(`${name} GET /persons`, token, 'GET', '/persons', OK);
    await check(`${name} GET /persons/sections`, token, 'GET', '/persons/sections', OK);
  }
  for (const [name, token] of [
    ['student', student],
    ['staff', staff],
  ] as const) {
    await check(`${name} GET /persons denied`, token, 'GET', '/persons', FORBIDDEN);
  }

  console.log('\n== superadmin-only areas ==');
  for (const path of ['/logs', '/reports/attendance', '/scan/logs', '/vehicles']) {
    await check(`superadmin GET ${path}`, superadmin, 'GET', path, OK);
    await check(`registrar GET ${path} denied`, registrar, 'GET', path, FORBIDDEN);
    await check(`student GET ${path} denied`, student, 'GET', path, FORBIDDEN);
  }

  console.log('\n== open to every authenticated role ==');
  for (const [name, token] of [
    ['superadmin', superadmin],
    ['registrar', registrar],
    ['staff', staff],
    ['student', student],
  ] as const) {
    await check(`${name} GET /dashboard`, token, 'GET', '/dashboard', OK);
    await check(`${name} GET /gates`, token, 'GET', '/gates', OK);
  }

  console.log('\n== attendance: superadmin, staff, and student may read; registrar may not ==');
  for (const [name, token] of [
    ['superadmin', superadmin],
    ['staff', staff],
    ['student', student],
  ] as const) {
    await check(`${name} GET /attendance`, token, 'GET', '/attendance', OK);
  }
  await check('registrar GET /attendance denied', registrar, 'GET', '/attendance', FORBIDDEN);

  console.log('\n== users list ==');
  await check('superadmin GET /users', superadmin, 'GET', '/users', OK);
  await check('registrar GET /users', registrar, 'GET', '/users', OK);
  await check('student GET /users denied', student, 'GET', '/users', FORBIDDEN);

  summary();
}

main().catch((err) => {
  console.error('\nverifyRoles crashed:', err);
  process.exit(1);
});
