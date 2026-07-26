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
  const superadminLogin = await login('testadmin', 'Admin@123');
  const registrarLogin = await login('testregistrar', 'Registrar@123');
  const studentLogin = await login('2025-0001', 'Student@123');
  const staffLogin = await login('EMP-1001', 'Staff@123');

  const superadmin = superadminLogin.token;
  const registrar = registrarLogin.token;
  const student = studentLogin.token;
  const staff = staffLogin.token;

  console.log('\n== seeded accounts carry the expected roles ==');
  expectEqual('testadmin is superadmin', superadminLogin.role, 'superadmin');
  expectEqual('testregistrar is registrar', registrarLogin.role, 'registrar');
  expectEqual('2025-0001 is student', studentLogin.role, 'student');
  expectEqual('EMP-1001 is staff', staffLogin.role, 'staff');

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

  console.log('\n== user creation is role-aware ==');
  const CREATED = 201;
  const stamp = Date.now();

  // Registrar may create a student login.
  await check(
    'registrar creates student login',
    registrar,
    'POST',
    '/users',
    CREATED,
    { username: `verify-stu-${stamp}`, password: 'Verify@12345', role: 'student' }
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

  // Superadmin may create a registrar.
  await check(
    'superadmin creates registrar',
    superadmin,
    'POST',
    '/users',
    CREATED,
    { username: `verify-reg2-${stamp}`, password: 'Verify@12345', role: 'registrar' }
  );

  // The stored role must be what was requested.
  const createdList = await request(superadmin, 'GET', '/users?limit=100');
  const createdItems = (createdList.json.data ?? []) as { username: string; role: string }[];
  const madeStudent = createdItems.find((u) => u.username === `verify-stu-${stamp}`);
  expectEqual('created student has role student', madeStudent?.role, 'student');

  console.log('\n== users list carries person data and filters ==');
  const listRes = await request(superadmin, 'GET', '/users?limit=100');
  const listRows = (listRes.json.data ?? []) as {
    username: string;
    role: string;
    is_active: boolean;
    person: { full_name: string; type: string; department_section: string } | null;
  }[];

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

  // Find Juan's user id and person id via the joined list.
  const forStatus = await request(superadmin, 'GET', '/users?limit=100');
  const statusRows = (forStatus.json.data ?? []) as {
    id: string;
    username: string;
    person: { id: string; status: string } | null;
  }[];
  const juanRow = statusRows.find((u) => u.username === '2025-0001');
  if (!juanRow?.person) throw new Error('seed missing: student 2025-0001 with a person');
  const juanUserId = juanRow.id;
  const selfRow = statusRows.find((u) => u.username === 'testadmin');
  if (!selfRow) throw new Error('seed missing: testadmin');

  // Only superadmin may flip status.
  await check(
    'registrar cannot deactivate',
    registrar,
    'PATCH',
    `/users/${juanUserId}/status`,
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

  // A superadmin may deactivate ANOTHER superadmin individually — only the
  // bulk path (Task 8) protects privileged roles. Use the prod-seeded
  // 'admin' account as the target (not 'testadmin', which is the account we
  // are authenticated as, and self-action is FORBIDDEN).
  const forAdminTarget = await request(superadmin, 'GET', '/users?limit=100');
  const adminRows = (forAdminTarget.json.data ?? []) as { id: string; username: string }[];
  const otherSuperadminRow = adminRows.find((u) => u.username === 'admin');
  if (!otherSuperadminRow) throw new Error("seed missing: prod-seeded superadmin 'admin'");
  const otherSuperadminId = otherSuperadminRow.id;

  await check(
    'superadmin deactivates another superadmin',
    superadmin,
    'PATCH',
    `/users/${otherSuperadminId}/status`,
    OK,
    { active: false }
  );
  const afterOtherOff = await request(superadmin, 'GET', '/users?limit=100');
  const otherOffRow = ((afterOtherOff.json.data ?? []) as typeof statusRows).find(
    (u) => u.username === 'admin'
  );
  expectEqual(
    'other superadmin login disabled',
    (otherOffRow as unknown as { is_active: boolean })?.is_active,
    false
  );

  // Restore state so the harness stays re-runnable.
  await check(
    'superadmin reactivates the other superadmin',
    superadmin,
    'PATCH',
    `/users/${otherSuperadminId}/status`,
    OK,
    { active: true }
  );
  const afterOtherOn = await request(superadmin, 'GET', '/users?limit=100');
  const otherOnRow = ((afterOtherOn.json.data ?? []) as typeof statusRows).find(
    (u) => u.username === 'admin'
  );
  expectEqual(
    'other superadmin login re-enabled',
    (otherOnRow as unknown as { is_active: boolean })?.is_active,
    true
  );

  console.log('\n== bulk activate / deactivate ==');

  // Only superadmin.
  await check(
    'registrar cannot bulk deactivate',
    registrar,
    'POST',
    '/users/bulk-status',
    FORBIDDEN,
    { active: false, filter: { type: 'student' } }
  );
  await check(
    'registrar cannot preview bulk',
    registrar,
    'GET',
    '/users/bulk-status/preview?type=student',
    FORBIDDEN
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

  // Privileged accounts survive an unfiltered bulk deactivate.
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
    'registrar still active after deactivate-all',
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

  console.log('\n== deletion: real deletion, not just deactivation ==');

  // A throwaway person + user, never a seeded account — deletion is one-way
  // and would permanently corrupt a seeded fixture used by later runs.
  const delStamp = Date.now();
  const throwawayRfid = 'DEAD' + (delStamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const throwawayIdNumber = `verify-del-${delStamp}`;

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

  const delUsername = `verify-del-${delStamp}`;
  const delUserRes = await request(superadmin, 'POST', '/users', {
    username: delUsername,
    password: 'Verify@12345',
    role: 'student',
    person_id: throwawayPersonId,
  });
  expectEqual('throwaway user created', delUserRes.status, 201);
  const throwawayUserId = (delUserRes.json.data as { id?: string } | undefined)?.id;
  if (!throwawayUserId) throw new Error('throwaway user creation did not return an id');

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

  summary();
}

main().catch((err) => {
  console.error('\nverifyRoles crashed:', err);
  process.exit(1);
});
