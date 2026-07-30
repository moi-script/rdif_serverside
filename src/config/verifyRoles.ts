/**
 * Asserts the permission matrix in
 * docs/superpowers/specs/2026-07-26-role-system-design.md.
 *
 * Requires: `npm run dev` running, and `npm run seed:test` already applied.
 * Run with: npm run verify:roles
 */

import { Types } from 'mongoose';
import {
  ROLES,
  ALL_ROLES,
  STAFF_SIDE,
  WRITE_DOMAINS,
  rankOf,
  rolesBelow,
  bulkEligibleRoles,
  personDomain,
  type Role,
} from '../constants/roles';
import { assertCanActOn, assertCanCreateRole, assertCanWrite, type Actor } from '../utils/authority';
import { connectDB, disconnectDB } from './db';
import { PersonModel } from '../modules/persons/persons.model';
import { UserModel } from '../modules/users/users.model';
import { VehicleModel } from '../modules/vehicles/vehicles.model';
import { grantSuperadmin } from './grantSuperadmin';

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000/api';

const failures: string[] = [];
let checks = 0;

async function login(
  username: string,
  password: string
): Promise<{ token: string; role: string | undefined }> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = (await res.json()) as { data?: { accessToken?: string; user?: { role?: string } } };
  const token = body.data?.accessToken;
  if (!token) {
    throw new Error(`login failed for '${username}' (HTTP ${res.status})`);
  }
  return { token, role: body.data?.user?.role };
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

interface UserRow {
  id: string;
  username: string;
  role: string;
  is_active: boolean;
  deactivated_at: string | null;
  person: {
    id: string;
    full_name: string;
    type: string;
    department_section: string;
    rfid_uid: string | null;
    status: string;
  } | null;
}

/**
 * GET /users caps `limit` at 100 server-side (see utils/pagination.ts), and
 * there is no server-side search by username. A single-page fetch used to
 * assume a seeded fixture (e.g. the prod-seeded 'admin' account) would land
 * on page 1 — sorted newest-first, that assumption breaks the moment enough
 * OTHER accounts sort ahead of it, and the lookup then reports "not found"
 * for a row that is sitting one page further down. Walk every page instead
 * of trusting page 1, so growth in the collection can never produce a wrong
 * answer here — only a slower one.
 */
async function fetchAllUsers(token: string, query = ''): Promise<UserRow[]> {
  const rows: UserRow[] = [];
  let page = 1;
  for (;;) {
    const qs = query ? `${query}&page=${page}&limit=100` : `page=${page}&limit=100`;
    const res = await request(token, 'GET', `/users?${qs}`);
    const pageRows = (res.json.data ?? []) as UserRow[];
    rows.push(...pageRows);
    const meta = (res.json.meta ?? {}) as { pagination?: { pages?: number } };
    const pages = meta.pagination?.pages ?? 1;
    if (pageRows.length === 0 || page >= pages) break;
    page++;
  }
  return rows;
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
  // A 429 is neither a pass nor a denial — it means the run hit a rate limit
  // and this check never reached the authorization code. Running all four
  // verify:* scripts back to back trips globalLimiter (RATE_LIMIT_MAX per
  // RATE_LIMIT_WINDOW_MS, applied to every API route, NOT the login limiter),
  // and a run that silently reports a wrong status here looks like a code
  // defect. Say what actually happened.
  if (status === 429 && expected !== 429) {
    failures.push(`${name}: got 429 (rate limited — see README) — expected ${expected}`);
    console.log(`  FAIL ${name} — 429 rate limited, expected ${expected}`);
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

async function runChecks(): Promise<void> {
  console.log('\n== rank and domain tables ==');

  expectEqual('six roles exist', ALL_ROLES.length, 6);
  expectEqual('superadmin outranks admins', rankOf(ROLES.SUPERADMIN) > rankOf(ROLES.HR), true);
  expectEqual('hr and oss are peers', rankOf(ROLES.HR) === rankOf(ROLES.OSS), true);
  expectEqual('registrar and hr are peers', rankOf(ROLES.REGISTRAR) === rankOf(ROLES.HR), true);
  expectEqual('admins outrank students', rankOf(ROLES.OSS) > rankOf(ROLES.STUDENT), true);
  expectEqual('staff and student are peers', rankOf(ROLES.STAFF) === rankOf(ROLES.STUDENT), true);

  // rolesBelow is what replaces BULK_PROTECTED, so its exact contents matter.
  const belowSuper = rolesBelow(ROLES.SUPERADMIN);
  expectEqual('superadmin outranks five roles', belowSuper.length, 5);
  expectEqual('superadmin does not outrank itself', belowSuper.includes(ROLES.SUPERADMIN), false);
  expectEqual('superadmin outranks hr', belowSuper.includes(ROLES.HR), true);

  const belowHr = rolesBelow(ROLES.HR);
  expectEqual('hr outranks exactly two roles', belowHr.length, 2);
  expectEqual('hr does not outrank registrar', belowHr.includes(ROLES.REGISTRAR), false);
  expectEqual('hr does not outrank oss', belowHr.includes(ROLES.OSS), false);
  expectEqual('hr outranks student', belowHr.includes(ROLES.STUDENT), true);
  expectEqual('student outranks nobody', rolesBelow(ROLES.STUDENT).length, 0);

  // bulkEligibleRoles is NOT rolesBelow: it also floors out every rank-2
  // account, regardless of actor. A superadmin's bulk action must never be
  // able to sweep registrar/hr/oss just because they outrank them.
  const bulkFromSuper = bulkEligibleRoles(ROLES.SUPERADMIN);
  expectEqual('superadmin bulk-eligible roles: exactly two', bulkFromSuper.length, 2);
  expectEqual('superadmin bulk-eligible includes staff', bulkFromSuper.includes(ROLES.STAFF), true);
  expectEqual('superadmin bulk-eligible includes student', bulkFromSuper.includes(ROLES.STUDENT), true);
  expectEqual(
    'superadmin bulk-eligible excludes registrar, hr, oss, and self',
    bulkFromSuper.includes(ROLES.REGISTRAR) ||
      bulkFromSuper.includes(ROLES.HR) ||
      bulkFromSuper.includes(ROLES.OSS) ||
      bulkFromSuper.includes(ROLES.SUPERADMIN),
    false
  );

  const bulkFromHr = bulkEligibleRoles(ROLES.HR);
  expectEqual('hr bulk-eligible roles: exactly two (floor changes nothing at rank 2)', bulkFromHr.length, 2);
  expectEqual('hr bulk-eligible includes staff', bulkFromHr.includes(ROLES.STAFF), true);
  expectEqual('hr bulk-eligible includes student', bulkFromHr.includes(ROLES.STUDENT), true);

  expectEqual('student bulk-eligible roles: none', bulkEligibleRoles(ROLES.STUDENT).length, 0);

  // Exhaustiveness: a role missing from either table is a runtime hole, not a
  // type error, because Record<Role, T> is satisfied by a cast anywhere upstream.
  for (const r of ALL_ROLES) {
    expectEqual(`${r} has a rank`, typeof rankOf(r), 'number');
    expectEqual(`${r} has a write-domain entry`, Array.isArray(WRITE_DOMAINS[r]), true);
  }

  expectEqual('registrar writes only students', WRITE_DOMAINS[ROLES.REGISTRAR].join(','), 'person:student');
  expectEqual('hr writes staff and employee', WRITE_DOMAINS[ROLES.HR].join(','), 'person:staff,person:employee');
  expectEqual('oss writes vehicles and gadgets', WRITE_DOMAINS[ROLES.OSS].join(','), 'vehicle,gadget');
  expectEqual('oss writes no person type', WRITE_DOMAINS[ROLES.OSS].some((d) => d.startsWith('person:')), false);
  expectEqual('staff writes nothing', WRITE_DOMAINS[ROLES.STAFF].length, 0);
  expectEqual('student writes nothing', WRITE_DOMAINS[ROLES.STUDENT].length, 0);
  expectEqual('personDomain maps staff', personDomain('staff'), 'person:staff');
  expectEqual('staff-side has four roles', STAFF_SIDE.length, 4);
  expectEqual('oss is staff-side', STAFF_SIDE.includes(ROLES.OSS as Role), true);
  expectEqual('student is not staff-side', STAFF_SIDE.includes(ROLES.STUDENT as Role), false);

  console.log('\n== authority guards ==');

  /** True when fn throws; used so a guard that silently permits fails the check. */
  function denies(fn: () => void): boolean {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  }

  const superActor: Actor = { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', role: ROLES.SUPERADMIN };
  const hrActor: Actor = { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', role: ROLES.HR };

  // assertCanActOn — rank
  expectEqual('superadmin may act on hr', denies(() => assertCanActOn(superActor, { _id: 'cccccccccccccccccccccccc', role: ROLES.HR })), false);
  expectEqual('superadmin may not act on a peer superadmin', denies(() => assertCanActOn(superActor, { _id: 'cccccccccccccccccccccccc', role: ROLES.SUPERADMIN })), true);
  expectEqual('hr may act on a student', denies(() => assertCanActOn(hrActor, { _id: 'cccccccccccccccccccccccc', role: ROLES.STUDENT })), false);
  expectEqual('hr may not act on a peer registrar', denies(() => assertCanActOn(hrActor, { _id: 'cccccccccccccccccccccccc', role: ROLES.REGISTRAR })), true);
  expectEqual('hr may not act on a superadmin', denies(() => assertCanActOn(hrActor, { _id: 'cccccccccccccccccccccccc', role: ROLES.SUPERADMIN })), true);
  expectEqual('nobody may act on themselves', denies(() => assertCanActOn(superActor, { _id: superActor.id, role: ROLES.STUDENT })), true);

  // The self-check compares String(target._id) against actor.id because in
  // production the target's _id is an ObjectId and the actor's id is a string.
  // A raw === would compare object to string, always be false, and silently
  // let anyone act on their own account. String fixtures cannot catch that
  // regression, so exercise it with a real ObjectId.
  const selfOid = new Types.ObjectId();
  expectEqual(
    'self-targeting is denied when _id is a real ObjectId',
    denies(() => assertCanActOn({ id: selfOid.toString(), role: ROLES.SUPERADMIN }, { _id: selfOid, role: ROLES.STUDENT })),
    true
  );
  expectEqual(
    'a DIFFERENT ObjectId is not treated as self',
    denies(() => assertCanActOn({ id: new Types.ObjectId().toString(), role: ROLES.SUPERADMIN }, { _id: selfOid, role: ROLES.STUDENT })),
    false
  );

  // assertCanCreateRole — the hole a target-based check cannot see
  expectEqual('superadmin may create hr', denies(() => assertCanCreateRole(superActor, ROLES.HR)), false);
  expectEqual('superadmin may NOT create a superadmin', denies(() => assertCanCreateRole(superActor, ROLES.SUPERADMIN)), true);
  expectEqual('hr may create a student', denies(() => assertCanCreateRole(hrActor, ROLES.STUDENT)), false);
  expectEqual('hr may NOT create a peer hr', denies(() => assertCanCreateRole(hrActor, ROLES.HR)), true);
  expectEqual('hr may NOT create a registrar', denies(() => assertCanCreateRole(hrActor, ROLES.REGISTRAR)), true);

  // assertCanWrite — domain
  expectEqual('hr may write staff persons', denies(() => assertCanWrite(hrActor, 'person:staff')), false);
  expectEqual('hr may NOT write student persons', denies(() => assertCanWrite(hrActor, 'person:student')), true);
  expectEqual('hr may NOT write vehicles', denies(() => assertCanWrite(hrActor, 'vehicle')), true);
  expectEqual('oss may write vehicles', denies(() => assertCanWrite({ id: 'dddddddddddddddddddddddd', role: ROLES.OSS }, 'vehicle')), false);
  expectEqual('oss may NOT write persons', denies(() => assertCanWrite({ id: 'dddddddddddddddddddddddd', role: ROLES.OSS }, 'person:student')), true);
  expectEqual('superadmin may write every domain', denies(() => { assertCanWrite(superActor, 'person:student'); assertCanWrite(superActor, 'vehicle'); assertCanWrite(superActor, 'gadget'); }), false);

  // Fail-closed on an unrecognized role. `actor.role` is a JWT claim, never
  // enum-validated on the way in, so a bogus value must deny on every guard
  // rather than pass because `RANK[role]`/`WRITE_DOMAINS[role]` came back
  // `undefined`. The cast is deliberate: this value can never come from
  // TypeScript's own type system, only from a forged or corrupted token.
  const bogusActor: Actor = { id: 'eeeeeeeeeeeeeeeeeeeeeeee', role: 'ghost' as Role };
  expectEqual(
    'assertCanActOn denies an unrecognized actor role',
    denies(() => assertCanActOn(bogusActor, { _id: 'cccccccccccccccccccccccc', role: ROLES.STUDENT })),
    true
  );
  expectEqual(
    'assertCanActOn denies an unrecognized target role',
    denies(() => assertCanActOn(superActor, { _id: 'cccccccccccccccccccccccc', role: 'ghost' as Role })),
    true
  );
  expectEqual(
    'assertCanCreateRole denies an unrecognized actor role',
    denies(() => assertCanCreateRole(bogusActor, ROLES.STUDENT)),
    true
  );
  expectEqual(
    'assertCanWrite denies an unrecognized actor role',
    denies(() => assertCanWrite(bogusActor, 'person:student')),
    true
  );

  const superadminLogin = await login('testadmin', 'Admin@123');
  const registrarLogin = await login('testregistrar', 'Registrar@123');
  const studentLogin = await login('2025-0001', 'Student@123');
  const staffLogin = await login('EMP-1001', 'Staff@123');

  const superadmin = superadminLogin.token;
  const registrar = registrarLogin.token;
  const student = studentLogin.token;
  const staff = staffLogin.token;

  const hrLogin = await login('testhr', 'Hr@12345');
  const ossLogin = await login('testoss', 'Oss@12345');
  const hr = hrLogin.token;
  const oss = ossLogin.token;

  console.log('\n== seeded accounts carry the expected roles ==');
  expectEqual('testadmin is superadmin', superadminLogin.role, 'superadmin');
  expectEqual('testregistrar is registrar', registrarLogin.role, 'registrar');
  expectEqual('2025-0001 is student', studentLogin.role, 'student');
  expectEqual('EMP-1001 is staff', staffLogin.role, 'staff');
  expectEqual('testhr has role hr', hrLogin.role, 'hr');
  expectEqual('testoss has role oss', ossLogin.role, 'oss');

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
  // Vehicles used to live in this loop, but reads are now shared across the
  // staff-side console (see "vehicle write domain" below) — only /logs,
  // /reports/attendance, and /scan/logs are still superadmin-only.
  for (const path of ['/logs', '/reports/attendance', '/scan/logs']) {
    await check(`superadmin GET ${path}`, superadmin, 'GET', path, OK);
    await check(`registrar GET ${path} denied`, registrar, 'GET', path, FORBIDDEN);
    await check(`hr GET ${path} denied`, hr, 'GET', path, FORBIDDEN);
    await check(`oss GET ${path} denied`, oss, 'GET', path, FORBIDDEN);
    await check(`student GET ${path} denied`, student, 'GET', path, FORBIDDEN);
  }

  console.log('\n== open to every authenticated role ==');
  for (const [name, token] of [
    ['superadmin', superadmin],
    ['registrar', registrar],
    ['hr', hr],
    ['oss', oss],
    ['staff', staff],
    ['student', student],
  ] as const) {
    await check(`${name} GET /dashboard`, token, 'GET', '/dashboard', OK);
    await check(`${name} GET /gates`, token, 'GET', '/gates', OK);
  }

  console.log('\n== registrar/hr/oss dashboards are registration-only (no scan/gate/vehicle leak) ==');
  for (const [name, token] of [
    ['registrar', registrar],
    ['hr', hr],
    ['oss', oss],
  ] as const) {
    const roleDashboard = await request(token, 'GET', '/dashboard');
    expectEqual(`${name} dashboard responds 200`, roleDashboard.status, OK);
    const roleDashboardData = (roleDashboard.json.data ?? {}) as Record<string, unknown>;
    expectEqual(
      `${name} dashboard carries registration data`,
      typeof roleDashboardData.total_persons === 'number',
      true
    );
    expectEqual(
      `${name} dashboard has no recent_scans key`,
      Object.prototype.hasOwnProperty.call(roleDashboardData, 'recent_scans'),
      false
    );
    expectEqual(
      `${name} dashboard has no parking_activity key`,
      Object.prototype.hasOwnProperty.call(roleDashboardData, 'parking_activity'),
      false
    );
    expectEqual(
      `${name} dashboard has no gates key`,
      Object.prototype.hasOwnProperty.call(roleDashboardData, 'gates'),
      false
    );
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

  console.log('\n== user creation is role-aware ==');
  const CREATED = 201;
  const stamp = Date.now();

  // Registrar may create a student login. This account is never touched
  // again, so cleanupProbes() removes it by prefix at the end of the run —
  // if you change `verify-stu-` below, update PROBE_USER_USERNAME_PREFIXES.
  await check(
    'registrar creates student login',
    registrar,
    'POST',
    '/users',
    CREATED,
    { username: `verify-stu-${stamp}`, password: 'Verify@12345', role: 'student' } // prefix: PROBE_USER_USERNAME_PREFIXES
  );

  // Registrar may not create privileged accounts.
  await check(
    'registrar cannot create registrar',
    registrar,
    'POST',
    '/users',
    FORBIDDEN,
    { username: `verify-reg-${stamp}`, password: 'Verify@12345', role: 'registrar' }
  );
  await check(
    'registrar cannot create superadmin',
    registrar,
    'POST',
    '/users',
    FORBIDDEN,
    { username: `verify-sa-${stamp}`, password: 'Verify@12345', role: 'superadmin' }
  );

  // Superadmin may create a registrar. Also never touched again — same
  // cleanup-by-prefix note as the student login above.
  await check(
    'superadmin creates registrar',
    superadmin,
    'POST',
    '/users',
    CREATED,
    { username: `verify-reg2-${stamp}`, password: 'Verify@12345', role: 'registrar' } // prefix: PROBE_USER_USERNAME_PREFIXES
  );

  // The stored role must be what was requested.
  const createdList = await request(superadmin, 'GET', '/users?limit=100');
  const createdItems = (createdList.json.data ?? []) as { username: string; role: string }[];
  const madeStudent = createdItems.find((u) => u.username === `verify-stu-${stamp}`);
  expectEqual('created student has role student', madeStudent?.role, 'student');

  console.log('\n== users list carries person data and filters ==');
  // Fixture lookups: walk every page (fetchAllUsers) rather than trusting
  // page 1 — see the comment on fetchAllUsers for why a single-page fetch is
  // not safe here.
  const listRows = await fetchAllUsers(superadmin);

  const juan = listRows.find((u) => u.username === '2025-0001');
  expectEqual('list joins person name', juan?.person?.full_name, 'Juan Dela Cruz');
  expectEqual('list exposes person type', juan?.person?.type, 'student');

  const testadminRow = listRows.find((u) => u.username === 'testadmin');
  expectEqual('superadmin row has no person', testadminRow?.person, null);

  const filtered = await request(superadmin, 'GET', '/users?type=student&limit=100');
  const filteredRows = (filtered.json.data ?? []) as { username: string; person: { type: string } | null }[];
  expectEqual(
    'type=student returns only students, and is not empty',
    filteredRows.length > 0 &&
      filteredRows.every((u) => u.person?.type === 'student') &&
      filteredRows.some((u) => u.username === '2025-0001'),
    true
  );

  const bySection = await request(
    superadmin,
    'GET',
    `/users?department_section=${encodeURIComponent('BSIT - 4A')}&limit=100`
  );
  const sectionRows = (bySection.json.data ?? []) as { username: string }[];
  expectEqual(
    'department filter narrows to that section',
    sectionRows.some((u) => u.username === '2025-0001') &&
      !sectionRows.some((u) => u.username === '2025-0002'),
    true
  );

  console.log('\n== single-user activate / deactivate ==');

  // Find Juan's user id and person id via the joined list. Walk every page —
  // these are seeded fixtures, not this run's own fresh rows, so they are
  // exactly the kind of lookup that can silently land past page 1.
  const statusRows = await fetchAllUsers(superadmin);
  const juanRow = statusRows.find((u) => u.username === '2025-0001');
  if (!juanRow?.person) {
    throw new Error(
      `seed missing: searched all ${statusRows.length} accounts for username '2025-0001' with a linked person — run npm run seed:test`
    );
  }
  const juanUserId = juanRow.id;
  const selfRow = statusRows.find((u) => u.username === 'testadmin');
  if (!selfRow) {
    throw new Error(`seed missing: searched all ${statusRows.length} accounts for username 'testadmin'`);
  }
  const empStaffRow = statusRows.find((u) => u.username === 'EMP-1001');
  if (!empStaffRow) {
    throw new Error(`seed missing: searched all ${statusRows.length} accounts for username 'EMP-1001'`);
  }

  // The route now admits every staff-side role (STAFF_SIDE_GUARD), so a bare
  // "only superadmin" denial no longer holds. Registrar outranks staff
  // (rank 2 > 1) but does not write person:staff, so domain still denies it —
  // exercised here on a single-target PATCH; the peer/domain matrix on
  // students is covered in the "rank enforcement on accounts" section below.
  await check(
    'registrar cannot deactivate a staff account (domain)',
    registrar,
    'PATCH',
    `/users/${empStaffRow.id}/status`,
    FORBIDDEN,
    { active: false }
  );
  await check(
    'student cannot deactivate',
    student,
    'PATCH',
    `/users/${juanUserId}/status`,
    FORBIDDEN,
    { active: false }
  );

  // Superadmin cannot deactivate themselves.
  await check(
    'superadmin cannot deactivate self',
    superadmin,
    'PATCH',
    `/users/${selfRow.id}/status`,
    FORBIDDEN,
    { active: false }
  );

  // Deactivating flips both the login and the gate status.
  await check(
    'superadmin deactivates student',
    superadmin,
    'PATCH',
    `/users/${juanUserId}/status`,
    OK,
    { active: false }
  );

  const afterOff = await request(superadmin, 'GET', '/users?limit=100');
  const offRow = ((afterOff.json.data ?? []) as typeof statusRows).find(
    (u) => u.username === '2025-0001'
  );
  expectEqual('login disabled', (offRow as unknown as { is_active: boolean })?.is_active, false);
  expectEqual('person marked inactive', offRow?.person?.status, 'inactive');

  // A deactivated account cannot log in.
  const deniedLogin = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: '2025-0001', password: 'Student@123' }),
  });
  expectEqual('deactivated user cannot log in', deniedLogin.status, 401);

  // The gate denies the card with the existing reason string.
  const gatesRes = await request(superadmin, 'GET', '/gates');
  const gateList = (gatesRes.json.data ?? []) as { _id?: string; id?: string; name: string }[];
  const mainGate = gateList.find((g) => g.name === 'Main Entrance');
  const gateId = (mainGate?._id ?? mainGate?.id) as string;
  const tap = await request(superadmin, 'POST', '/scan/tap', {
    rfid_uid: 'A1B2C3D4',
    gate_id: gateId,
    direction: 'entry',
  });
  const tapData = (tap.json.data ?? {}) as { access_result?: string; reason?: string };
  expectEqual('gate denies inactive card', tapData.access_result, 'denied');
  expectEqual('denial reason is inactive_id', tapData.reason, 'inactive_id');

  // Reactivating restores both and clears the audit stamp.
  await check(
    'superadmin reactivates student',
    superadmin,
    'PATCH',
    `/users/${juanUserId}/status`,
    OK,
    { active: true }
  );
  const afterOn = await request(superadmin, 'GET', '/users?limit=100');
  const onRow = ((afterOn.json.data ?? []) as typeof statusRows).find(
    (u) => u.username === '2025-0001'
  );
  expectEqual('login re-enabled', (onRow as unknown as { is_active: boolean })?.is_active, true);
  expectEqual('person re-activated', onRow?.person?.status, 'active');
  expectEqual(
    'audit stamp cleared',
    (onRow as unknown as { deactivated_at: string | null })?.deactivated_at,
    null
  );

  // assertCanActOn (Task 2) denies peers and superiors on EVERY path,
  // superadmin-on-superadmin included — a deliberate reversal of the old
  // role-system spec's ruling that a superadmin may individually deactivate
  // another superadmin. Now that setStatus routes through
  // assertCanActOnPersonBackedAccount (which calls assertCanActOn first),
  // this must be a 403, not the 200 an earlier draft of this harness
  // expected. Use the prod-seeded 'admin' account as the target (not
  // 'testadmin', which is the account we are authenticated as — that would
  // conflate this with the self-action check above).
  // This is exactly the lookup that broke in practice: enough accumulated
  // probe accounts (sorted newest-first) pushed the prod-seeded 'admin'
  // account past a single 100-row page, and a page-1-only fetch reported it
  // as missing even though it existed. Walk every page instead.
  const adminRows = await fetchAllUsers(superadmin);
  const otherSuperadminRow = adminRows.find((u) => u.username === 'admin');
  if (!otherSuperadminRow) {
    throw new Error(
      `seed missing: searched all ${adminRows.length} accounts for the prod-seeded superadmin username 'admin'`
    );
  }
  const otherSuperadminId = otherSuperadminRow.id;

  await check(
    'superadmin cannot deactivate a peer superadmin individually (peer protection extends to superadmins)',
    superadmin,
    'PATCH',
    `/users/${otherSuperadminId}/status`,
    FORBIDDEN,
    { active: false }
  );
  const afterOtherAttempt = await request(superadmin, 'GET', '/users?limit=100');
  const otherAttemptRow = ((afterOtherAttempt.json.data ?? []) as typeof statusRows).find(
    (u) => u.username === 'admin'
  );
  expectEqual(
    'other superadmin login unaffected by the denied attempt',
    (otherAttemptRow as unknown as { is_active: boolean })?.is_active,
    true
  );

  console.log('\n== bulk activate / deactivate ==');

  // STAFF_SIDE_GUARD now admits registrar to the bulk routes at all — the
  // former "only superadmin" denial no longer holds at the route level.
  // The domain rule still governs what a bulk action actually touches:
  // registrar's write domain is person:student only, so a staff-type filter
  // resolves to zero targets (all excluded), not a 403. This exercises the
  // domain half of resolveBulkTargets without mutating any seeded account —
  // matched: 0 means nothing was written, so there is nothing to restore.
  const registrarStaffPreview = await request(
    registrar,
    'GET',
    '/users/bulk-status/preview?type=staff'
  );
  const registrarStaffPreviewData = (registrarStaffPreview.json.data ?? {}) as {
    matched?: number;
    excluded?: number;
  };
  expectEqual(
    'registrar bulk preview on staff filter responds 200 (route allows staff-side roles)',
    registrarStaffPreview.status,
    OK
  );
  expectEqual(
    'registrar bulk preview on staff filter matches nothing (domain excludes it)',
    registrarStaffPreviewData.matched,
    0
  );
  expectEqual(
    'registrar bulk preview on staff filter excludes at least one (domain)',
    (registrarStaffPreviewData.excluded ?? 0) > 0,
    true
  );

  const registrarStaffApply = await request(registrar, 'POST', '/users/bulk-status', {
    active: false,
    filter: { type: 'staff' },
  });
  const registrarStaffApplyData = (registrarStaffApply.json.data ?? {}) as {
    matched?: number;
    modified?: number;
  };
  expectEqual('registrar bulk apply on staff filter responds 200', registrarStaffApply.status, OK);
  expectEqual('registrar bulk apply on staff filter matches nothing', registrarStaffApplyData.matched, 0);
  expectEqual(
    'registrar bulk apply on staff filter modifies nothing',
    registrarStaffApplyData.modified,
    0
  );

  // Preview count must match what the mutation reports.
  const preview = await request(
    superadmin,
    'GET',
    '/users/bulk-status/preview?type=student'
  );
  const previewData = (preview.json.data ?? {}) as { matched: number; excluded: number };
  expectEqual('preview matches the three seeded students', previewData.matched, 3);

  const bulkOff = await request(superadmin, 'POST', '/users/bulk-status', {
    active: false,
    filter: { type: 'student' },
  });
  const bulkData = (bulkOff.json.data ?? {}) as {
    matched: number;
    modified: number;
    excluded: number;
  };
  // A plain expectEqual(bulkData.matched, previewData.matched) would pass
  // when the endpoint 404s and both sides are undefined — that is exactly
  // what happened in the Step 2 pre-implementation run. Require a real
  // number on both sides so a missing/broken endpoint cannot masquerade as
  // agreement.
  expectEqual(
    'bulk matched equals preview',
    typeof bulkData.matched === 'number' && bulkData.matched === previewData.matched,
    true
  );
  expectEqual('bulk modified all three', bulkData.modified, 3);

  // Every student is now off, in both places.
  const afterBulk = await request(superadmin, 'GET', '/users?type=student&limit=100');
  const bulkRows = (afterBulk.json.data ?? []) as {
    is_active: boolean;
    person: { status: string } | null;
  }[];
  expectEqual(
    'all students deactivated',
    bulkRows.length === 3 && bulkRows.every((u) => u.is_active === false),
    true
  );
  expectEqual(
    'all student cards inactive',
    bulkRows.length === 3 && bulkRows.every((u) => u.person?.status === 'inactive'),
    true
  );

  // Every rank-2-or-above account survives an unfiltered bulk deactivate,
  // regardless of who runs it — not just peers of the actor. rolesBelow()
  // alone would let a superadmin's bulk action sweep registrar (and, once
  // seeded, hr/oss) accounts just because they outrank them: that is a
  // blast-radius safety property, not a peer-protection one, and the two
  // must not be conflated. bulkEligibleRoles() floors bulk targets at rank 1
  // (staff/student) for every actor, so registrar survives here for the same
  // reason it always did — this is a derived rank floor now, not a
  // hand-maintained name list, so it cannot go stale when a role is added.
  // An admin account can still be deactivated, just never via a filter:
  // PATCH /users/:id/status names a specific target instead.
  const bulkAll = await request(superadmin, 'POST', '/users/bulk-status', {
    active: false,
    filter: {},
  });
  const bulkAllData = (bulkAll.json.data ?? {}) as { excluded: number };
  const afterAll = await request(superadmin, 'GET', '/users?limit=100');
  const allRows = (afterAll.json.data ?? []) as {
    username: string;
    role: string;
    is_active: boolean;
  }[];
  expectEqual(
    'superadmin still active after deactivate-all',
    allRows.find((u) => u.username === 'testadmin')?.is_active,
    true
  );
  expectEqual(
    'registrar still active after deactivate-all (rank floor, not name list)',
    allRows.find((u) => u.username === 'testregistrar')?.is_active,
    true
  );
  expectEqual('exclusions were counted', bulkAllData.excluded >= 2, true);

  // Restore everyone so the script is re-runnable.
  await check('bulk reactivate all', superadmin, 'POST', '/users/bulk-status', OK, {
    active: true,
    filter: {},
  });
  const restored = await request(superadmin, 'GET', '/users?limit=100');

  // Guard against silent truncation: if the account count ever exceeds the
  // page limit, a check over `restored.json.data` alone would only see part
  // of the list and could pass while accounts outside the page stay
  // deactivated. Fail loudly instead of truncating quietly.
  const restoredMeta = (restored.json.meta ?? {}) as { pagination?: { total: number } };
  expectEqual(
    'restore check covers every account (no silent truncation)',
    typeof restoredMeta.pagination?.total === 'number' && restoredMeta.pagination.total <= 100,
    true
  );

  const restoredRows = (restored.json.data ?? []) as {
    is_active: boolean;
    person: { status: string } | null;
  }[];
  expectEqual(
    'everyone restored: logins re-enabled',
    restoredRows.length > 0 && restoredRows.every((u) => u.is_active),
    true
  );

  // The reactivate path's Person write (the gate side) must also be
  // verified — asserting only is_active would miss a regression that leaves
  // linked cards inactive even after the login is re-enabled, and that
  // corruption would only surface later, at Task 14.
  const restoredWithPerson = restoredRows.filter((u) => u.person !== null);
  expectEqual(
    'everyone restored: linked cards re-activated',
    restoredWithPerson.length > 0 &&
      restoredWithPerson.every((u) => u.person?.status === 'active'),
    true
  );

  console.log('\n== bulk activate must not reopen a gate closed independently ==');

  // A superadmin kills a lost card via PATCH /persons/:id/status while
  // leaving the login active. Juan's User row is already active, so a later
  // "Activate all" must not touch his Person row — only users whose row
  // actually flips from inactive -> active should have their person
  // re-activated.
  const juanPersonId = juanRow.person.id;
  await check(
    'superadmin deactivates card only (login stays active)',
    superadmin,
    'PATCH',
    `/persons/${juanPersonId}/status`,
    OK,
    { status: 'inactive' }
  );

  const beforeActivateAll = await request(superadmin, 'GET', '/users?limit=100');
  const beforeActivateAllRow = ((beforeActivateAll.json.data ?? []) as typeof statusRows).find(
    (u) => u.username === '2025-0001'
  );
  expectEqual(
    'login still active after card-only deactivation',
    (beforeActivateAllRow as unknown as { is_active: boolean } | undefined)?.is_active,
    true
  );
  expectEqual(
    'card is inactive before bulk activate',
    beforeActivateAllRow?.person?.status,
    'inactive'
  );

  await check('bulk activate all (card-only scenario)', superadmin, 'POST', '/users/bulk-status', OK, {
    active: true,
    filter: {},
  });

  const afterActivateAllCard = await request(superadmin, 'GET', '/users?limit=100');
  const afterActivateAllCardRow = ((afterActivateAllCard.json.data ?? []) as typeof statusRows).find(
    (u) => u.username === '2025-0001'
  );
  expectEqual(
    'bulk activate does not reopen an independently-closed gate',
    afterActivateAllCardRow?.person?.status,
    'inactive'
  );

  // Restore state so the harness stays re-runnable.
  await check(
    'superadmin restores the card',
    superadmin,
    'PATCH',
    `/persons/${juanPersonId}/status`,
    OK,
    { status: 'active' }
  );
  const restoredCard = await request(superadmin, 'GET', '/users?limit=100');
  const restoredCardRow = ((restoredCard.json.data ?? []) as typeof statusRows).find(
    (u) => u.username === '2025-0001'
  );
  expectEqual('card restored to active', restoredCardRow?.person?.status, 'active');

  console.log('\n== deletion: real deletion, not just deactivation ==');

  // A throwaway person + user, never a seeded account — deletion is one-way
  // and would permanently corrupt a seeded fixture used by later runs.
  // DELETE /users/:id below only soft-deletes the User and marks the Person
  // 'inactive' — neither document actually goes away, so cleanupProbes()
  // removes both by prefix at the end of the run. If you change `verify-del-`
  // on either line below, update BOTH PROBE_PERSON_ID_PREFIXES and
  // PROBE_USER_USERNAME_PREFIXES.
  const delStamp = Date.now();
  const throwawayRfid = 'DEAD' + (delStamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const throwawayIdNumber = `verify-del-${delStamp}`; // prefix: PROBE_PERSON_ID_PREFIXES

  const personRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'Verify Deletion Throwaway',
    type: 'student',
    id_number: throwawayIdNumber,
    department_section: 'BSIT - 4A',
    rfid_uid: throwawayRfid,
  });
  expectEqual('throwaway person created', personRes.status, 201);
  const throwawayPersonId = (personRes.json.data as { _id?: string; id?: string } | undefined)
    ?._id ?? (personRes.json.data as { _id?: string; id?: string } | undefined)?.id;
  if (!throwawayPersonId) throw new Error('throwaway person creation did not return an id');

  const delUsername = `verify-del-${delStamp}`; // prefix: PROBE_USER_USERNAME_PREFIXES
  const delUserRes = await request(superadmin, 'POST', '/users', {
    username: delUsername,
    password: 'Verify@12345',
    role: 'student',
    person_id: throwawayPersonId,
  });
  expectEqual('throwaway user created', delUserRes.status, 201);
  const throwawayUserId = (delUserRes.json.data as { id?: string } | undefined)?.id;
  if (!throwawayUserId) throw new Error('throwaway user creation did not return an id');

  // Relies on the just-created throwaway user landing on this first page: the
  // list sorts by createdAt descending, so the newest row is always here
  // regardless of how many accounts exist overall.
  const beforeDeleteList = await request(superadmin, 'GET', '/users?limit=100');
  const beforeDeleteRows = (beforeDeleteList.json.data ?? []) as { username: string }[];
  expectEqual(
    'throwaway user visible before deletion',
    beforeDeleteRows.some((u) => u.username === delUsername),
    true
  );

  const previewBeforeDelete = await request(superadmin, 'GET', '/users/bulk-status/preview');
  const beforeCount = (previewBeforeDelete.json.data as { matched?: number } | undefined)?.matched;
  if (typeof beforeCount !== 'number') throw new Error('bulk preview did not return a matched count');

  await check(
    'superadmin deletes throwaway user',
    superadmin,
    'DELETE',
    `/users/${throwawayUserId}`,
    OK
  );

  const afterDeleteList = await request(superadmin, 'GET', '/users?limit=100');
  const afterDeleteRows = (afterDeleteList.json.data ?? []) as { username: string }[];
  expectEqual(
    'deleted user absent from list',
    afterDeleteRows.some((u) => u.username === delUsername),
    false
  );

  const personAfterDelete = await request(superadmin, 'GET', `/persons/${throwawayPersonId}`);
  expectEqual(
    'deleted user person marked inactive (gate closed)',
    (personAfterDelete.json.data as { status?: string } | undefined)?.status,
    'inactive'
  );

  const previewAfterDelete = await request(superadmin, 'GET', '/users/bulk-status/preview');
  expectEqual(
    'bulk preview count drops by one after deletion',
    (previewAfterDelete.json.data as { matched?: number } | undefined)?.matched,
    beforeCount - 1
  );

  // The core of this task: Activate All must not resurrect a deleted user or
  // reopen their gate access.
  await check('activate all after deletion', superadmin, 'POST', '/users/bulk-status', OK, {
    active: true,
    filter: {},
  });
  const afterActivateAllList = await request(superadmin, 'GET', '/users?limit=100');
  const afterActivateAllRows = (afterActivateAllList.json.data ?? []) as { username: string }[];
  expectEqual(
    'Activate All does not resurrect the deleted user',
    afterActivateAllRows.some((u) => u.username === delUsername),
    false
  );
  const personAfterActivateAll = await request(
    superadmin,
    'GET',
    `/persons/${throwawayPersonId}`
  );
  expectEqual(
    'Activate All does not reopen the deleted user gate access',
    (personAfterActivateAll.json.data as { status?: string } | undefined)?.status,
    'inactive'
  );

  await check(
    'single-user activate on deleted user is 404',
    superadmin,
    'PATCH',
    `/users/${throwawayUserId}/status`,
    404,
    { active: true }
  );

  const deletedLogin = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: delUsername, password: 'Verify@12345' }),
  });
  expectEqual('deleted user cannot log in', deletedLogin.status, 401);

  await check(
    'registrar cannot delete users',
    registrar,
    'DELETE',
    `/users/${throwawayUserId}`,
    FORBIDDEN
  );

  console.log('\n== rank enforcement on accounts ==');

  // Peer creation — the hole assertCanCreateRole closes.
  await check('hr cannot create a peer hr', hr, 'POST', '/users', FORBIDDEN, {
    username: 'rbac-peer-hr', password: 'Verify@12345', role: 'hr',
  });
  await check('hr cannot create a registrar', hr, 'POST', '/users', FORBIDDEN, {
    username: 'rbac-peer-reg', password: 'Verify@12345', role: 'registrar',
  });
  await check('superadmin cannot create a superadmin', superadmin, 'POST', '/users', FORBIDDEN, {
    username: 'rbac-peer-super', password: 'Verify@12345', role: 'superadmin',
  });

  console.log('\n== break-glass promotion ==');

  // The API must never mint a superadmin, whoever asks.
  await check('api refuses to create a superadmin', superadmin, 'POST', '/users', FORBIDDEN, {
    username: 'rbac-api-super', password: 'Verify@12345', role: 'superadmin',
  });

  // Promotion is idempotent and refuses unknown usernames. Run against the
  // account that is ALREADY superadmin so the harness leaves no new privileged
  // account behind — promoting testadmin is a no-op by construction.
  const promoted = await grantSuperadmin('testadmin');
  expectEqual('promoting an existing superadmin is a no-op', promoted.promoted, false);
  expectEqual('promotion reports the username', promoted.username, 'testadmin');

  let rejectedUnknown = false;
  try {
    await grantSuperadmin('rbac-no-such-user');
  } catch {
    rejectedUnknown = true;
  }
  expectEqual('promotion refuses an unknown username', rejectedUnknown, true);

  // Widened reads.
  await check('hr GET /users', hr, 'GET', '/users', OK);
  await check('oss GET /users', oss, 'GET', '/users', OK);

  // Rank on status changes. Resolve the registrar's own user id first. This
  // array is scanned repeatedly below for several seeded usernames/roles
  // (including a bare `.find(...)!` for 'superadmin' with no presence check),
  // so it is fetched via fetchAllUsers rather than a single page.
  const rankUserRows = await fetchAllUsers(superadmin);
  expectEqual('user list is non-empty', rankUserRows.length > 0, true);
  const registrarRow = rankUserRows.find((u) => u.role === 'registrar');
  // Must be a PERSON-BACKED student, not one of the person-less accounts this
  // very script creates earlier (e.g. `verify-stu-<stamp>`, created without a
  // person_id) — those sort first (newest first) and would let the domain
  // check pass trivially (no Person to write, so rank alone governs, per the
  // dangling-person_id rule). '2025-0001' is the seeded student with a real
  // linked Person, so the domain rule is actually exercised below.
  const studentRow = rankUserRows.find((u) => u.username === '2025-0001');
  expectEqual('a registrar account exists to target', Boolean(registrarRow), true);
  expectEqual('a person-backed student account exists to target', Boolean(studentRow), true);

  // NOTE: userStatusSchema declares `{ active: boolean }` — NOT `is_active`.
  // Sending the wrong key yields a 422 that looks like an authorization pass.
  await check(
    'hr cannot deactivate a peer registrar',
    hr, 'PATCH', `/users/${registrarRow!.id}/status`, FORBIDDEN, { active: false }
  );
  await check(
    'superadmin cannot deactivate a peer superadmin',
    superadmin, 'PATCH', `/users/${rankUserRows.find((u) => u.role === 'superadmin')!.id}/status`,
    FORBIDDEN, { active: false }
  );
  // DOMAIN WINS over rank on this toggle. HR outranks a student account, but
  // the toggle also writes that student's Person, which HR may not write. All
  // four of these are needed: any one alone passes against a rank-only build.
  const staffRow = rankUserRows.find((u) => u.username === 'EMP-1001');
  expectEqual('a staff account exists to target', Boolean(staffRow), true);

  await check(
    'hr may NOT deactivate a student account (domain)',
    hr, 'PATCH', `/users/${studentRow!.id}/status`, FORBIDDEN, { active: false }
  );
  await check(
    'registrar may NOT deactivate a staff account (domain)',
    registrar, 'PATCH', `/users/${staffRow!.id}/status`, FORBIDDEN, { active: false }
  );
  await check(
    'hr may deactivate a staff account',
    hr, 'PATCH', `/users/${staffRow!.id}/status`, OK, { active: false }
  );
  await check(
    'hr may reactivate that staff account',
    hr, 'PATCH', `/users/${staffRow!.id}/status`, OK, { active: true }
  );
  await check(
    'registrar may deactivate a student account',
    registrar, 'PATCH', `/users/${studentRow!.id}/status`, OK, { active: false }
  );
  await check(
    'registrar may reactivate that student account',
    registrar, 'PATCH', `/users/${studentRow!.id}/status`, OK, { active: true }
  );

  // resetPassword writes no Person, so it is rank-only — a deliberate
  // asymmetry, recorded in the spec. HR may reset a student's password.
  await check(
    'hr cannot reset passwords at all (superadmin-only route)',
    hr, 'PATCH', `/users/${studentRow!.id}/password`, FORBIDDEN, { password: 'Verify@12345' }
  );

  // Self-targeting, for each staff-side role.
  for (const [name, token] of [
    ['superadmin', superadmin], ['registrar', registrar], ['hr', hr], ['oss', oss],
  ] as const) {
    const me = rankUserRows.find((u) => u.username === (
      name === 'superadmin' ? 'testadmin'
      : name === 'registrar' ? 'testregistrar'
      : name === 'hr' ? 'testhr' : 'testoss'
    ));
    expectEqual(`${name} account is listed`, Boolean(me), true);
    await check(`${name} cannot deactivate itself`, token, 'PATCH', `/users/${me!.id}/status`, FORBIDDEN, { active: false });
  }

  // OSS has no person domain, so it cannot create a login attached to a
  // person. GET /persons is readable by all four staff-side roles (see the
  // "person write domains" block below), so which token resolves the person
  // id here doesn't matter for this check — superadmin is used because the
  // thing under test is POST /users, not read access to /persons.
  const personsForAttach = await request(superadmin, 'GET', '/persons?limit=1');
  const firstPerson = ((personsForAttach.json.data as { _id?: string; id?: string }[]) ?? [])[0];
  expectEqual('a person exists to attach', Boolean(firstPerson), true);
  await check('oss cannot create a login for a person', oss, 'POST', '/users', FORBIDDEN, {
    username: 'rbac-oss-login', password: 'Verify@12345', role: 'student',
    person_id: String(firstPerson!._id ?? firstPerson!.id),
  });

  // Bulk: a filter that WOULD match a peer must leave that peer untouched, and
  // preview must agree with apply. Asserting only the response count would pass
  // against an implementation that excluded nothing.
  //
  // An UNFILTERED scan, not a `search` term, is what exercises this: every
  // seeded Person's full_name/id_number/rfid_uid is substring-clean (no
  // shared token across student and staff records), so any non-empty
  // `type`/`department_section`/`search` filter resolves through
  // buildFilter's person_id $in [...] and structurally can never surface a
  // person-less peer account (superadmin/registrar/hr/oss all have
  // person_id: null). `filter: {}` skips that person_id narrowing entirely,
  // so peers and out-of-domain persons alike are real bulk candidates and
  // the exclusion loop actually has something to exclude.
  const rankPreview = await request(hr, 'GET', '/users/bulk-status/preview');
  const rankPreviewBody = rankPreview.json.data as { matched?: number; excluded?: number };
  expectEqual('preview returns a matched count', typeof rankPreviewBody?.matched, 'number');
  expectEqual('preview excludes at least the peers and self', (rankPreviewBody?.excluded ?? 0) > 0, true);

  // bulkStatusSchema declares `{ active: boolean, filter: bulkFilterSchema }`,
  // and bulkFilterSchema accepts only `type`, `department_section`, `search`,
  // each a plain string.
  const rankApplied = await request(hr, 'POST', '/users/bulk-status', { active: false, filter: {} });
  const rankAppliedBody = rankApplied.json.data as { matched?: number; excluded?: number };
  expectEqual('bulk apply matched equals preview matched', rankAppliedBody?.matched, rankPreviewBody?.matched);
  expectEqual('bulk apply excluded equals preview excluded', rankAppliedBody?.excluded, rankPreviewBody?.excluded);

  // Re-read BOTH a peer and a student. Asserting only the response counts would
  // pass against an implementation that excluded nothing, and checking only the
  // peer would pass against a role-only predicate that still swept every
  // student on campus — the worst hole in this subsystem.
  const rankAfterBulk = await request(superadmin, 'GET', '/users?limit=100');
  const rankAfterRows = (rankAfterBulk.json.data as { id: string; is_active: boolean }[]) ?? [];
  expectEqual('post-bulk user list is non-empty', rankAfterRows.length > 0, true);
  expectEqual(
    'peer registrar survives hr bulk deactivate',
    rankAfterRows.find((u) => u.id === registrarRow!.id)?.is_active,
    true
  );
  expectEqual(
    'out-of-domain student survives hr bulk deactivate',
    rankAfterRows.find((u) => u.id === studentRow!.id)?.is_active,
    true
  );

  // Restore anything the bulk actually deactivated. Use superadmin (every
  // domain) with the same unfiltered scan so the restore isn't itself
  // limited by hr's write domain.
  await request(superadmin, 'POST', '/users/bulk-status', { active: true, filter: {} });

  console.log('\n== person write domains ==');

  // Reads are shared — this is what lets OSS attach an owner to a vehicle.
  await check('hr GET /persons', hr, 'GET', '/persons', OK);
  await check('oss GET /persons', oss, 'GET', '/persons', OK);

  // There is NO DELETE /persons/:id route, so these rows are removed by
  // cleanupProbes() at the end of the run instead, matched by the
  // `verify-rbac-` prefix (never used by a seeded fixture). Same
  // timestamp-suffixed id_number/RFID convention as the throwaway block
  // above. If you change the `verify-rbac-` prefix on either line below,
  // update PROBE_PERSON_ID_PREFIXES too.
  const rbacStamp = Date.now();
  const probeStudentId = `verify-rbac-s-${rbacStamp}`; // prefix: PROBE_PERSON_ID_PREFIXES
  const probeStaffId = `verify-rbac-t-${rbacStamp}`; // prefix: PROBE_PERSON_ID_PREFIXES
  const probeStudentRfid = 'BEEF' + (rbacStamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const probeStaffRfid = 'CAFE' + (rbacStamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');

  // Writes are scoped.
  const madeStudentPerson = await request(registrar, 'POST', '/persons', {
    full_name: 'RBAC Probe Student', type: 'student',
    id_number: probeStudentId, department_section: 'BSIT 4-A', rfid_uid: probeStudentRfid,
  });
  expectEqual('registrar may create a student', madeStudentPerson.status, 201);

  await check('registrar may NOT create a staff person', registrar, 'POST', '/persons', FORBIDDEN, {
    full_name: 'RBAC Probe Staff', type: 'staff',
    id_number: probeStaffId, department_section: 'Registrar Office', rfid_uid: probeStaffRfid,
  });

  const madeStaff = await request(hr, 'POST', '/persons', {
    full_name: 'RBAC Probe Staff', type: 'staff',
    id_number: probeStaffId, department_section: 'Registrar Office', rfid_uid: probeStaffRfid,
  });
  expectEqual('hr may create a staff person', madeStaff.status, 201);

  await check('hr may NOT create a student', hr, 'POST', '/persons', FORBIDDEN, {
    full_name: 'RBAC Probe Student 2', type: 'student',
    id_number: `${probeStudentId}-b`, department_section: 'BSIT 4-A',
  });
  await check('oss may NOT create any person', oss, 'POST', '/persons', FORBIDDEN, {
    full_name: 'RBAC Probe OSS', type: 'student',
    id_number: `${probeStudentId}-c`, department_section: 'BSIT 4-A',
  });

  // Type-change escalation, both directions.
  const idOf = (r: { json: Record<string, unknown> }) => {
    const d = r.json.data as { _id?: string; id?: string } | undefined;
    return String(d?._id ?? d?.id ?? '');
  };
  const probeStudent = { _id: idOf(madeStudentPerson) };
  const probeStaff = { _id: idOf(madeStaff) };
  expectEqual('probe student has an id', probeStudent._id.length > 0, true);
  expectEqual('probe staff has an id', probeStaff._id.length > 0, true);

  await check(
    'registrar cannot push a student out of its domain',
    registrar, 'PATCH', `/persons/${probeStudent!._id}`, FORBIDDEN, { type: 'staff' }
  );
  await check(
    'registrar cannot claim a staff record by retyping it',
    registrar, 'PATCH', `/persons/${probeStaff!._id}`, FORBIDDEN, { type: 'student' }
  );
  await check(
    'registrar may still edit a student in-domain',
    registrar, 'PATCH', `/persons/${probeStudent!._id}`, OK, { department_section: 'BSIT 4-B' }
  );

  // Status is a write, so it is domain-scoped too.
  await check(
    'hr may deactivate a staff person',
    hr, 'PATCH', `/persons/${probeStaff!._id}/status`, OK, { status: 'inactive' }
  );
  await check(
    'hr may NOT deactivate a student person',
    hr, 'PATCH', `/persons/${probeStudent!._id}/status`, FORBIDDEN, { status: 'inactive' }
  );

  console.log('\n== reactivation defers to rank when a linked User exists (regression counterexample) ==');

  // The old special case only refused reactivation when the linked User was
  // soft-deleted (deleted_at set). That misses a real hole: HR and OSS logins
  // can be person-backed too — userService.create permits exactly that, and
  // only the SEEDED office accounts (testhr/testoss) happen to be
  // person-less. So a merely-deactivated (is_active: false, NOT deleted)
  // person-backed HR account was reachable through PATCH /persons/:id/status
  // by any OTHER HR account, even though that same actor would be denied on
  // the equivalent PATCH /users/:id/status by assertCanActOn's peer rule.
  // Build exactly that account and prove the gap is closed: a peer gets 403,
  // a superadmin still succeeds.
  const reactStamp = Date.now();
  const reactPersonIdNumber = `verify-rbac-hr2-${reactStamp}`; // prefix: PROBE_PERSON_ID_PREFIXES ('verify-rbac-')
  const reactRfid = 'FEED' + (reactStamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');

  const reactPersonRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'RBAC Reactivation Probe',
    type: 'staff',
    id_number: reactPersonIdNumber,
    department_section: 'HR Office',
    rfid_uid: reactRfid,
  });
  expectEqual('person-backed probe person created', reactPersonRes.status, 201);
  const reactPersonId = idOf(reactPersonRes);
  expectEqual('probe person has an id', reactPersonId.length > 0, true);

  const reactUsername = `rbac-hr2-${reactStamp}`; // prefix: PROBE_USER_USERNAME_PREFIXES ('rbac-')
  const reactUserRes = await request(superadmin, 'POST', '/users', {
    username: reactUsername,
    password: 'Verify@12345',
    role: 'hr',
    person_id: reactPersonId,
  });
  expectEqual('superadmin creates a person-backed hr account (rank-2)', reactUserRes.status, 201);
  const reactUserId = (reactUserRes.json.data as { id?: string } | undefined)?.id;
  expectEqual('probe hr account has an id', typeof reactUserId, 'string');

  // Superadmin deactivates it through the normal route — this is what
  // deactivating a colleague's login actually looks like, and it closes the
  // gate as a side effect.
  await check(
    'superadmin deactivates the person-backed hr account',
    superadmin, 'PATCH', `/users/${reactUserId}/status`, OK, { active: false }
  );
  const reactAfterOff = await request(superadmin, 'GET', `/persons/${reactPersonId}`);
  expectEqual(
    'linked person went inactive with the login',
    (reactAfterOff.json.data as { status?: string } | undefined)?.status,
    'inactive'
  );

  // The counterexample itself: a DIFFERENT, peer-rank hr account (the seeded
  // testhr) must be denied here. Before this fix, assertCanWrite(hr,
  // 'person:staff') passed and the deleted_at-only check never fired, so this
  // reopened the gate — something that same actor could not do through
  // PATCH /users/:id/status.
  await check(
    'a peer hr account cannot reactivate it via PATCH /persons/:id/status',
    hr, 'PATCH', `/persons/${reactPersonId}/status`, FORBIDDEN, { status: 'active' }
  );
  const reactAfterPeerAttempt = await request(superadmin, 'GET', `/persons/${reactPersonId}`);
  expectEqual(
    'the denied peer attempt left the card inactive',
    (reactAfterPeerAttempt.json.data as { status?: string } | undefined)?.status,
    'inactive'
  );

  // Superadmin's short-circuit still works — this is a legitimate
  // reactivation, identical in outcome to PATCH /users/:id/status {active:true}.
  await check(
    'superadmin can still reactivate it',
    superadmin, 'PATCH', `/persons/${reactPersonId}/status`, OK, { status: 'active' }
  );
  const reactAfterSuperadmin = await request(superadmin, 'GET', `/persons/${reactPersonId}`);
  expectEqual(
    'card reactivated by superadmin',
    (reactAfterSuperadmin.json.data as { status?: string } | undefined)?.status,
    'active'
  );

  console.log('\n== vehicle write domain ==');

  await check('hr GET /vehicles', hr, 'GET', '/vehicles', OK);
  await check('oss GET /vehicles', oss, 'GET', '/vehicles', OK);
  await check('student GET /vehicles denied', student, 'GET', '/vehicles', FORBIDDEN);

  // Vehicle.owner_person_id is UNIQUE and there is NO DELETE /vehicles/:id
  // route, so a probe vehicle cannot reuse an owner that already has one —
  // create a fresh throwaway owner per run instead, same convention as the
  // person probes above. cleanupProbes() below removes both this owner
  // (id_number prefix already covered by PROBE_PERSON_ID_PREFIXES) and the
  // vehicle itself (PROBE_VEHICLE_PLATE_PREFIX) at the end of the run — if
  // you change the `verify-rbac-v-` or `RBAC-` prefix below, update the
  // matching constant near cleanupProbes() too, or this starts leaking again.
  const vStamp = Date.now();
  const vSuffix = (vStamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const ownerRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'RBAC Vehicle Owner', type: 'student',
    id_number: `verify-rbac-v-${vStamp}`, department_section: 'BSIT 4-A', // prefix: PROBE_PERSON_ID_PREFIXES
    rfid_uid: 'FACE' + vSuffix,
  });
  expectEqual('throwaway vehicle owner created', ownerRes.status, 201);
  const ownerData = ownerRes.json.data as { _id?: string; id?: string } | undefined;
  const ownerId = String(ownerData?._id ?? ownerData?.id ?? '');
  expectEqual('throwaway owner has an id', ownerId.length > 0, true);

  const vehicleBody = {
    owner_person_id: ownerId,
    plate_number: `RBAC-${vSuffix}`, // prefix: PROBE_VEHICLE_PLATE_PREFIX — keep these in sync
    rfid_uid: 'D0E1' + vSuffix,
    vehicle_type: 'Motorcycle',
    vehicle_model: 'Honda Adv',
  };

  await check('registrar may NOT create a vehicle', registrar, 'POST', '/vehicles', FORBIDDEN, vehicleBody);
  await check('hr may NOT create a vehicle', hr, 'POST', '/vehicles', FORBIDDEN, vehicleBody);

  const created = await request(oss, 'POST', '/vehicles', vehicleBody);
  expectEqual('oss may create a vehicle', created.status, 201);
  const vData = created.json.data as { _id?: string; id?: string } | undefined;
  const vehicleId = String(vData?._id ?? vData?.id ?? '');
  expectEqual('created vehicle has an id', vehicleId.length > 0, true);

  await check(
    'oss may deactivate its own vehicle',
    oss, 'PATCH', `/vehicles/${vehicleId}/status`, OK, { status: 'inactive' }
  );
  await check(
    'hr may NOT change vehicle status',
    hr, 'PATCH', `/vehicles/${vehicleId}/status`, FORBIDDEN, { status: 'active' }
  );

  console.log('\n== records (scan log) ==');

  await check('superadmin GET /logs', superadmin, 'GET', '/logs', OK);
  await check('registrar GET /logs denied', registrar, 'GET', '/logs', FORBIDDEN);
  await check('hr GET /logs denied', hr, 'GET', '/logs', FORBIDDEN);
  await check('oss GET /logs denied', oss, 'GET', '/logs', FORBIDDEN);
  await check('student GET /logs denied', student, 'GET', '/logs', FORBIDDEN);

  const logs = await request(superadmin, 'GET', '/logs?limit=50');
  const logRows = (logs.json.data as Record<string, unknown>[]) ?? [];
  // Length floor: every assertion below is vacuously true on an empty array.
  expectEqual('log rows exist to inspect', logRows.length > 0, true);

  const personRow = logRows.find((r) => r.entity_type === 'person' && r.subject !== null);
  expectEqual('a person scan row exists', Boolean(personRow), true);
  const subject = personRow!.subject as { full_name?: string } | null;
  expectEqual('subject is resolved, not an ObjectId', typeof subject?.full_name, 'string');
  expectEqual('resolved name is non-empty', (subject?.full_name ?? '').length > 0, true);

  expectEqual('rows expose a gate field', 'gate' in personRow!, true);
  const logsMeta = logs.json.meta as { pagination?: { total?: number }; truncated?: boolean } | undefined;
  expectEqual('meta exposes a total', typeof logsMeta?.pagination?.total, 'number');
  expectEqual('meta exposes a truncated flag', typeof logsMeta?.truncated, 'boolean');

  // I5: from=to=<today> must include a tap made today. This assertion is
  // able to fail: `new Date("YYYY-MM-DD")` parses as UTC midnight, so in any
  // timezone ahead of UTC the query's $lte boundary lands hours before the
  // tap's local timestamp and today's own rows silently vanish from the
  // response — the exact defect being guarded against.
  const dateCheckGates = await request(superadmin, 'GET', '/gates');
  const dateCheckGateList = (dateCheckGates.json.data ?? []) as {
    _id?: string;
    id?: string;
    name: string;
  }[];
  const dateCheckGate = dateCheckGateList.find((g) => g.name === 'Main Entrance');
  const dateCheckGateId = (dateCheckGate?._id ?? dateCheckGate?.id) as string;
  expectEqual('a gate exists for the date-filter probe tap', Boolean(dateCheckGateId), true);

  const dateCheckTap = await request(superadmin, 'POST', '/scan/tap', {
    rfid_uid: 'A1B2C3D4',
    gate_id: dateCheckGateId,
    direction: 'exit',
  });
  expectEqual('date-filter probe tap responds 200', dateCheckTap.status, OK);
  const dateCheckTapData = dateCheckTap.json.data as { scan_time?: string } | undefined;
  expectEqual('date-filter probe tap is logged', typeof dateCheckTapData?.scan_time, 'string');

  const todayLocal = (() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  })();
  const todayLogs = await request(
    superadmin,
    'GET',
    `/logs?from=${todayLocal}&to=${todayLocal}&limit=200`
  );
  expectEqual('from=to=today responds 200', todayLogs.status, OK);
  const todayRows = (todayLogs.json.data ?? []) as { scan_time: string }[];
  expectEqual(
    'from=to=today returns rows made today (local-day range, not UTC-cut)',
    todayRows.length > 0,
    true
  );

  // access_result filter must actually filter.
  const deniedOnly = await request(superadmin, 'GET', '/logs?access_result=denied&limit=50');
  const deniedRows = (deniedOnly.json.data as { access_result: string }[]) ?? [];
  expectEqual('denied filter returns rows', deniedRows.length > 0, true);
  expectEqual('denied filter returns only denials', deniedRows.every((r) => r.access_result === 'denied'), true);

  // A malformed gate_id must be a clean 422, not a 500 with a leaked BSON
  // message — the same defect the anomaly report shipped with.
  await check('malformed gate_id is 422', superadmin, 'GET', '/logs?gate_id=not-an-id', 422);
}

/**
 * Prefixes this harness uses for the probe Person/User/Vehicle records it
 * creates. There is deliberately no `DELETE /persons/:id` or
 * `DELETE /vehicles/:id` route (see the module comments above the "person
 * write domains" and "vehicle write domain" sections), so cleanup has to go
 * straight at the database — the same pattern rebuildOccupancy.ts uses for
 * config-script DB access. Every prefix here was found by grepping this file
 * for the literal strings passed as `id_number`/`username`/`plate_number`,
 * not guessed:
 *   - Person.id_number: 'verify-rbac-' (student/staff/vehicle-owner probes),
 *     'verify-del-' (the deletion-test throwaway, left 'inactive' rather
 *     than removed by DELETE /users/:id).
 *   - User.username: 'verify-stu-' and 'verify-reg2-' (created and never
 *     touched again), 'verify-del-' (soft-deleted by DELETE /users/:id,
 *     which sets deleted_at but does not remove the document).
 *   - Vehicle.plate_number: 'RBAC-' (seeded plates use 'NCST-', see
 *     testSeed.ts — 'RBAC-' never collides with a fixture). Each run's
 *     vehicle probe's owner Person is removed by PROBE_PERSON_ID_PREFIXES
 *     above, so leaving the vehicle behind would orphan it — a strictly
 *     worse defect than the original leak, since GET /vehicles has the same
 *     100-row page cap as /persons and /users.
 * Matching by prefix — not by this run's own stamp — means a run also mops
 * up any litter left by earlier, pre-fix runs, and it is structurally unable
 * to touch a seeded fixture: no seeded username, id_number, or plate_number
 * starts with any of these prefixes.
 *
 * If a future edit adds a new probe-creating call site, grep for
 * "prefix: PROBE_" comments at each existing creation site — every one names
 * the constant it must be added to. There is no automated check tying a new
 * prefix to these arrays (no test framework exists to host one); see the
 * report for a proposal on what a cheap automated guard could look like.
 */
const PROBE_PERSON_ID_PREFIXES = ['verify-rbac-', 'verify-del-'];
const PROBE_USER_USERNAME_PREFIXES = [
  'verify-stu-',
  'verify-reg2-',
  'verify-del-',
  // Expected-403 probes below (registrar/hr/oss trying to mint a peer or a
  // superadmin) never create a row on the pass path, which is exactly why
  // this list previously omitted them — but the run that matters most is
  // the one where the guard under test REGRESSES: the POST that should have
  // been denied instead succeeds, and now the account it names is real and
  // stays real, live, at `superadmin` in `rbac-peer-super`'s case. Cleanup
  // must cover the failure path, not just the path where everything already
  // worked.
  'verify-reg-', // registrar POSTs a would-be registrar/superadmin login
  'verify-sa-',  // registrar POSTs a would-be superadmin login
  'rbac-', // rbac-peer-hr, rbac-peer-reg, rbac-peer-super, rbac-api-super, rbac-oss-login, rbac-no-such-user
];
const PROBE_VEHICLE_PLATE_PREFIXES = ['RBAC-'];

/**
 * Removes every Person/User/Vehicle row this harness has ever created (this
 * run's and any earlier run's), so the collections stop growing. Must run
 * even when `runChecks()` throws or logs failures — see the try/finally
 * around its call in `main()` — but must never itself change the process
 * exit code; `summary()` is what decides pass/fail, and it runs after this,
 * untouched.
 *
 * Vehicles are deleted before Persons: a probe Vehicle's owner_person_id
 * points at a probe Person, and while Mongo enforces no real foreign key
 * here, deleting the referencing row first keeps the intermediate DB state
 * consistent (never a Vehicle pointing at an already-deleted Person) in case
 * this function is ever interrupted between the two deletes.
 */
async function cleanupProbes(): Promise<void> {
  console.log('\n== cleanup: removing probe records this harness created ==');
  // Connection lifecycle is owned by main() (connectDB()/disconnectDB() wrap
  // both runChecks() and this call) rather than opened and closed here,
  // because runChecks() now needs a live connection too — grantSuperadmin()
  // reads/writes UserModel directly, not over HTTP like the rest of the
  // harness. Connecting only once per run also means this function's own
  // deleteMany calls below share that same connection instead of racing a
  // second connect/disconnect pair around it.
  const vehicleRegex = new RegExp(`^(${PROBE_VEHICLE_PLATE_PREFIXES.join('|')})`);
  const personRegex = new RegExp(`^(${PROBE_PERSON_ID_PREFIXES.join('|')})`);
  const userRegex = new RegExp(`^(${PROBE_USER_USERNAME_PREFIXES.join('|')})`);

  const vehicleResult = await VehicleModel.deleteMany({ plate_number: { $regex: vehicleRegex } });
  const personResult = await PersonModel.deleteMany({ id_number: { $regex: personRegex } });
  const userResult = await UserModel.deleteMany({ username: { $regex: userRegex } });

  console.log(
    `  removed ${vehicleResult.deletedCount} probe vehicle(s) (plate_number matching ${PROBE_VEHICLE_PLATE_PREFIXES.join(', ')})`
  );
  console.log(
    `  removed ${personResult.deletedCount} probe person(s) (id_number matching ${PROBE_PERSON_ID_PREFIXES.join(', ')})`
  );
  console.log(
    `  removed ${userResult.deletedCount} probe user(s) (username matching ${PROBE_USER_USERNAME_PREFIXES.join(', ')})`
  );
}

/**
 * Cleanup must run whether runChecks() throws, logs soft failures, or passes
 * cleanly — a red run must never leak probe records. The try/finally is what
 * guarantees that: `finally` runs on every exit path out of the `try`,
 * including a thrown error, before that error propagates.
 *
 * Exit-code correctness is the other half of the contract. `summary()` is
 * the ONLY thing allowed to decide the process exit code (via its
 * `process.exit(1)` on failure), and it must run strictly after cleanup so
 * a red run's non-zero exit is never skipped:
 *   - runChecks() throws  -> finally cleans up -> the throw re-propagates
 *     past summary() (never called) -> caught below -> process.exit(1).
 *   - runChecks() returns with soft failures logged -> finally cleans up ->
 *     summary() runs and calls process.exit(1) itself.
 *   - runChecks() returns clean -> finally cleans up -> summary() prints the
 *     pass message and returns -> normal exit 0.
 * Nothing in cleanupProbes() calls process.exit or swallows an error, so it
 * cannot mask a failure in either direction.
 */
async function main(): Promise<void> {
  // Connect once, up front: runChecks() now calls grantSuperadmin() directly
  // (not over HTTP), which reads/writes UserModel and needs a live mongoose
  // connection before that call runs, not just during cleanupProbes() at the
  // end. Disconnect happens in the outer finally so it still runs on every
  // exit path, same guarantee as before.
  await connectDB();
  try {
    try {
      await runChecks();
    } finally {
      await cleanupProbes();
    }
    summary();
  } finally {
    await disconnectDB();
  }
}

main().catch((err) => {
  console.error('\nverifyRoles crashed:', err);
  process.exit(1);
});
