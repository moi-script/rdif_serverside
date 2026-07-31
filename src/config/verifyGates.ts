/**
 * Asserts the photo pipeline and gate terminal behavior in
 * docs/superpowers/specs/2026-07-27-photo-and-gate-terminals-design.md.
 *
 * Requires: `npm run dev` running, and `npm run seed:test` already applied.
 * Run with: npm run verify:gates
 */
import { detectImageType } from '../utils/imageType';
import { installVerifyBypass } from './verifyBypass';

// Installs the X-Verify-Bypass header on every fetch() this process makes,
// once, before any request goes out — see verifyBypass.ts and the matching
// comment in verifyRoles.ts. Unset VERIFY_BYPASS_TOKEN means this run is
// subject to the real rate limits.
installVerifyBypass();

const failures: string[] = [];
let checks = 0;

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
  console.log('All gate and photo checks passed.');
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
]);
const TEXT = Buffer.from('this is not an image at all, not even close');

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000/api';

// Must match scanService.dateKey(), which buckets attendance by the SERVER'S
// LOCAL calendar date. toISOString() would give the UTC date, which differs
// from the local date for part of every day in any non-UTC timezone and makes
// this assertion fail by the clock rather than by behavior.
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = (await res.json()) as { data?: { accessToken?: string } };
  const token = body.data?.accessToken;
  if (!token) throw new Error(`login failed for '${username}' (HTTP ${res.status})`);
  return token;
}

async function request(
  token: string | null,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // Some responses have no JSON body; the status is what matters.
  }
  return { status: res.status, json };
}

/**
 * Looks up a seeded Person by exact `id_number`, using the `?search=` param
 * (personService.list matches it against full_name and id_number) instead of
 * fetching a page and scanning it. GET /persons caps `limit` at 100
 * server-side (see utils/pagination.ts) with no way to raise it, so a
 * page-1-only fetch silently reports "not found" for a real row sitting past
 * page 1 once the collection grows — that is exactly what broke this script
 * against an un-cleaned-up verify:roles run ("seeded person 2025-0001 not
 * found" when the person existed, just off-page). `search` is a substring
 * match, not exact, so results still need an exact-match filter afterward.
 */
async function findPersonByIdNumber(
  token: string,
  idNumber: string
): Promise<{ _id: string; id_number: string }> {
  const res = await request(token, 'GET', `/persons?search=${encodeURIComponent(idNumber)}&limit=100`);
  const candidates = (res.json.data ?? []) as { _id: string; id_number: string }[];
  const match = candidates.find((p) => p.id_number === idNumber);
  if (!match) {
    throw new Error(
      `seeded person not found: searched /persons?search=${idNumber} for an exact id_number match ` +
        `(${candidates.length} candidate(s) returned) — run npm run seed:test`
    );
  }
  return match;
}

/** Posts a multipart photo. `headers` supplies the credential (Bearer or X-Gate-Key). */
async function uploadPhoto(
  headers: Record<string, string>,
  personId: string,
  bytes: Buffer,
  filename: string,
  declaredMime: string
): Promise<{ status: number; json: Record<string, unknown> }> {
  const form = new FormData();
  form.append('photo', new Blob([bytes as unknown as BlobPart], { type: declaredMime }), filename);
  const res = await fetch(`${BASE}/persons/${personId}/photo`, {
    method: 'POST',
    headers,
    body: form,
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // no body
  }
  return { status: res.status, json };
}

/** A real 1x1 JPEG, so uploads exercise the same path a browser would. */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);

async function main(): Promise<void> {
  console.log('\n== magic-byte detection ==');
  expectEqual('jpeg detected', detectImageType(JPEG), 'image/jpeg');
  expectEqual('png detected', detectImageType(PNG), 'image/png');
  expectEqual('webp detected', detectImageType(WEBP), 'image/webp');
  expectEqual('text rejected', detectImageType(TEXT), null);
  expectEqual('empty buffer rejected', detectImageType(Buffer.alloc(0)), null);
  expectEqual('truncated jpeg rejected', detectImageType(Buffer.from([0xff, 0xd8])), null);
  // The real boundary: exactly matches the 3-byte JPEG magic but is too short
  // for a marker byte, which is what the `buf.length >= 4` guard exists for.
  // The 2-byte case above never reaches that guard's branch at all.
  expectEqual(
    'jpeg magic with no marker byte rejected',
    detectImageType(Buffer.from([0xff, 0xd8, 0xff])),
    null
  );

  const superadmin = await login('testadmin', 'Admin@123');
  const registrar = await login('testregistrar', 'Registrar@123');
  const student = await login('2025-0001', 'Student@123');
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  // Juan Dela Cruz — seeded by seed:test.
  const juan = await findPersonByIdNumber(superadmin, '2025-0001');
  const personId = juan._id;

  console.log('\n== photo upload validation ==');

  const notAnImage = await uploadPhoto(
    auth(registrar),
    personId,
    Buffer.from('definitely not an image, but I claim to be a jpeg'),
    'evil.jpg',
    'image/jpeg'
  );
  expectEqual('non-image with jpeg mime rejected', notAnImage.status, 422);

  const tooBig = await uploadPhoto(
    auth(registrar),
    personId,
    Buffer.concat([TINY_JPEG, Buffer.alloc(1_100_000, 0x20)]),
    'huge.jpg',
    'image/jpeg'
  );
  expectEqual('over-1MB upload rejected', tooBig.status, 413);

  console.log('\n== photo upload, serve, replace ==');

  const first = await uploadPhoto(auth(registrar), personId, TINY_JPEG, 'a.jpg', 'image/jpeg');
  expectEqual('registrar can upload', first.status, 201);
  expectEqual(
    'photo_url points at the internal route',
    (first.json.data as { photo_url?: string } | undefined)?.photo_url,
    `/persons/${personId}/photo`
  );

  const second = await uploadPhoto(auth(registrar), personId, TINY_JPEG, 'b.jpg', 'image/jpeg');
  expectEqual('re-upload replaces rather than erroring', second.status, 201);

  // The delete at the end of this block proves the re-upload replaced rather
  // than duplicated: if two documents existed, deleteOne would leave one behind
  // and the final 404 assertion would fail.
  const asStudent = await fetch(`${BASE}/persons/${personId}/photo`, {
    headers: auth(student),
  });
  expectEqual('any authenticated user may fetch a photo', asStudent.status, 200);
  expectEqual(
    'photo served as image/jpeg',
    asStudent.headers.get('content-type'),
    'image/jpeg'
  );
  expectEqual(
    'photo served with nosniff',
    asStudent.headers.get('x-content-type-options'),
    'nosniff'
  );

  const noCred = await fetch(`${BASE}/persons/${personId}/photo`);
  expectEqual('photo requires a credential', noCred.status, 401);

  console.log('\n== photo ownership ==');

  const maria = await findPersonByIdNumber(superadmin, '2025-0002');
  // Presence floor: without this, every assertion below would compare
  // undefined to undefined and pass vacuously. findPersonByIdNumber already
  // throws (with a clear "what was searched for" message) rather than
  // returning undefined, so this is now a belt-and-braces check.
  expectEqual('second seeded person found', !!maria, true);
  const otherId = maria?._id ?? '';

  // Maria has no photo from any earlier step, so give her one. Without this,
  // "student refused another person's photo" below would return 404 simply
  // because there is nothing to fetch, regardless of any ownership check —
  // that is exactly what made the original version of this assertion vacuous.
  const mariaUpload = await uploadPhoto(auth(registrar), otherId, TINY_JPEG, 'maria.jpg', 'image/jpeg');
  expectEqual('registrar can upload a photo for the second person', mariaUpload.status, 201);

  // 2025-0001 is Juan; the student token belongs to Juan.
  const ownPhoto = await fetch(`${BASE}/persons/${personId}/photo`, {
    headers: auth(student),
  });
  expectEqual('student may fetch their own photo', ownPhoto.status, 200);

  // Proves the photo exists right now, so the student's refusal just below
  // can only be attributable to the ownership rule, not to a missing photo.
  const registrarOthers = await fetch(`${BASE}/persons/${otherId}/photo`, {
    headers: auth(registrar),
  });
  expectEqual("registrar may fetch the second person's photo", registrarOthers.status, 200);

  const othersPhoto = await fetch(`${BASE}/persons/${otherId}/photo`, {
    headers: auth(student),
  });
  // 404 not 403: a 403 would confirm the photo exists and let an
  // unauthorized caller enumerate which ids have photos.
  expectEqual('student refused another person\'s photo', othersPhoto.status, 404);

  const registrarAny = await fetch(`${BASE}/persons/${personId}/photo`, {
    headers: auth(registrar),
  });
  expectEqual('registrar may fetch any photo', registrarAny.status, 200);

  const superadminAny = await fetch(`${BASE}/persons/${personId}/photo`, {
    headers: auth(superadmin),
  });
  expectEqual('superadmin may fetch any photo', superadminAny.status, 200);

  console.log('\n== profile carries photo_url ==');
  const overview = await request(superadmin, 'GET', `/persons/${personId}/overview`);
  const overviewPerson = (overview.json.data as { person?: { photo_url?: string | null } } | undefined)
    ?.person;
  // Presence floor before comparing, so a missing person object cannot make
  // the field assertion pass vacuously.
  expectEqual('overview returns a person', !!overviewPerson, true);
  expectEqual(
    'overview carries the internal photo_url',
    overviewPerson?.photo_url,
    `/persons/${personId}/photo`
  );

  // Clean up what this run added. Maria (the second seeded person) never had
  // a seed photo, so deleting hers restores her to the pre-run state. Juan
  // (2025-0001) is different: testSeed.ts (Task 11) now gives him a seeded
  // placeholder photo, so deleting it here — while exercising the DELETE
  // path — leaves the primary demo person without a face at the gate
  // terminal until someone reseeds. That is restored at the very end of
  // this function, after the later gate-fetch check re-uploads for him too.
  const cleaned = await request(superadmin, 'DELETE', `/persons/${personId}/photo`);
  expectEqual('photo deleted', cleaned.status, 200);
  const afterDelete = await fetch(`${BASE}/persons/${personId}/photo`, { headers: auth(student) });
  expectEqual('deleted photo returns 404', afterDelete.status, 404);

  const cleanedMaria = await request(superadmin, 'DELETE', `/persons/${otherId}/photo`);
  expectEqual("second person's photo deleted", cleanedMaria.status, 200);
  const afterDeleteMaria = await fetch(`${BASE}/persons/${otherId}/photo`, { headers: auth(registrar) });
  expectEqual("second person's deleted photo returns 404", afterDeleteMaria.status, 404);

  console.log('\n== gate direction ==');
  const gatesRes = await request(superadmin, 'GET', '/gates');
  const gates = (gatesRes.json.data ?? []) as {
    _id: string;
    name: string;
    type: string;
    direction?: string;
  }[];
  expectEqual('all four gates are seeded', gates.length, 4);

  const expectedGates: Record<string, { type: string; direction: string }> = {
    'Main Entrance': { type: 'person', direction: 'entry' },
    'Side Gate': { type: 'person', direction: 'exit' },
    'Parking Entrance': { type: 'vehicle', direction: 'entry' },
    'Parking Exit': { type: 'vehicle', direction: 'exit' },
  };
  for (const [name, want] of Object.entries(expectedGates)) {
    const gate = gates.find((g) => g.name === name);
    // Comparing undefined to undefined would pass vacuously; assert presence first.
    expectEqual(`gate '${name}' exists`, !!gate, true);
    expectEqual(`gate '${name}' type`, gate?.type, want.type);
    expectEqual(`gate '${name}' direction`, gate?.direction, want.direction);
  }

  console.log('\n== device key minting ==');
  const mainGate = gates.find((g) => g.name === 'Main Entrance');
  const parkingIn = gates.find((g) => g.name === 'Parking Entrance');
  const parkingOut = gates.find((g) => g.name === 'Parking Exit');
  if (!mainGate || !parkingIn || !parkingOut) {
    throw new Error('expected gates missing — run npm run seed:test');
  }

  const registrarMint = await request(registrar, 'POST', `/gates/${mainGate._id}/key`);
  expectEqual('registrar cannot mint a key', registrarMint.status, 403);

  const firstMint = await request(superadmin, 'POST', `/gates/${mainGate._id}/key`);
  expectEqual('superadmin can mint a key', firstMint.status, 201);
  const firstKey = (firstMint.json.data as { key?: string } | undefined)?.key;
  expectEqual('minted key has the documented shape', /^gk_live_[0-9a-f]{40}$/.test(firstKey ?? ''), true);

  const parkingMint = await request(superadmin, 'POST', `/gates/${parkingIn._id}/key`);
  const parkingKey = (parkingMint.json.data as { key?: string } | undefined)?.key;
  expectEqual('parking key minted', typeof parkingKey, 'string');

  const parkingOutMint = await request(superadmin, 'POST', `/gates/${parkingOut._id}/key`);
  const parkingOutKey = (parkingOutMint.json.data as { key?: string } | undefined)?.key;
  expectEqual('parking exit key minted', typeof parkingOutKey, 'string');

  // Minting again must revoke the first key.
  const secondMint = await request(superadmin, 'POST', `/gates/${mainGate._id}/key`);
  const secondKey = (secondMint.json.data as { key?: string } | undefined)?.key;
  expectEqual('second mint succeeded', secondMint.status, 201);
  expectEqual('second key differs from the first', firstKey !== secondKey, true);

  console.log('\n== tapping with a device key ==');
  const gateKey = (h: string) => ({
    'X-Gate-Key': h,
    'Content-Type': 'application/json',
  });

  async function tap(
    headers: Record<string, string>,
    body: Record<string, unknown>
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${BASE}/scan/tap`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // no body
    }
    return { status: res.status, json };
  }

  if (!secondKey || !parkingKey) throw new Error('key minting did not return a key');

  // Juan Dela Cruz's card, seeded active.
  const granted = await tap(gateKey(secondKey), { rfid_uid: 'A1B2C3D4' });
  expectEqual('valid key taps successfully', granted.status, 200);
  expectEqual(
    'person card granted at a person gate',
    (granted.json.data as { access_result?: string } | undefined)?.access_result,
    'granted'
  );

  // The device is not trusted to name its own gate.
  const spoofed = await tap(gateKey(secondKey), {
    rfid_uid: 'A1B2C3D4',
    gate_id: parkingIn._id,
    direction: 'exit',
  });
  expectEqual('body-supplied gate is ignored, not honoured', spoofed.status, 200);

  // scanService.listLogs aggregates and sorts scan_time: -1, so [0] is the
  // newest row. The freshness guard keeps this from passing on some
  // unrelated old row if that sort ever changes. The row's gate is now a
  // resolved { id, name } object (task 8), not a bare gate_id.
  const logs = await request(superadmin, 'GET', '/scan/logs?limit=1');
  const latest = (logs.json.data ?? []) as {
    gate?: { id?: string; name?: string } | null;
    direction?: string;
    scan_time?: string;
  }[];
  expectEqual('a log row was written', latest.length >= 1, true);
  expectEqual('newest log row is from this run', !!latest[0]?.scan_time, true);
  expectEqual(
    'newest log row is fresh',
    latest[0]?.scan_time ? Date.now() - new Date(latest[0].scan_time).getTime() < 60_000 : false,
    true
  );
  expectEqual('log records the key\'s gate, not the body\'s', latest[0]?.gate?.id, mainGate._id);
  expectEqual('log records the gate\'s direction', latest[0]?.direction, 'entry');

  // A person card at a vehicle gate must not open the barrier.
  const wrongGate = await tap(gateKey(parkingKey), { rfid_uid: 'A1B2C3D4' });
  expectEqual(
    'person card denied at a vehicle gate',
    (wrongGate.json.data as { access_result?: string } | undefined)?.access_result,
    'denied'
  );
  expectEqual(
    'denial reason is wrong_gate_type',
    (wrongGate.json.data as { reason?: string } | undefined)?.reason,
    'wrong_gate_type'
  );
  // wrong_gate_type must not leak who the cardholder is to a gate they are
  // not authorised for — checked by key absence, not by value, so this
  // cannot pass vacuously just because the field happens to be undefined.
  expectEqual(
    'wrong_gate_type denial carries no identity',
    'person' in (wrongGate.json.data as object),
    false
  );

  console.log('\n== vehicle taps and identity ==');

  // Juan's motorcycle, seeded active, at the vehicle-entry gate it belongs at.
  const vehicleGranted = await tap(gateKey(parkingKey), { rfid_uid: 'E5F6A7B8' });
  expectEqual(
    'granted vehicle tap grants',
    (vehicleGranted.json.data as { access_result?: string } | undefined)?.access_result,
    'granted'
  );
  const vehiclePerson = (vehicleGranted.json.data as { person?: { full_name?: string; plate_number?: string } } | undefined)
    ?.person;
  // Presence floor: without this, the field assertions below would compare
  // undefined to undefined and pass even if the identity was never returned.
  expectEqual('granted vehicle tap carries identity', !!vehiclePerson, true);
  expectEqual('granted vehicle tap carries the plate number', vehiclePerson?.plate_number, 'NCST-1234');
  expectEqual("granted vehicle tap carries the owner's name", vehiclePerson?.full_name, 'Juan Dela Cruz');

  // A deactivated person must read differently from an unregistered stranger.
  const deactivate = await request(superadmin, 'PATCH', `/persons/${personId}/status`, {
    status: 'inactive',
  });
  expectEqual('person deactivated for the inactive-ID check', deactivate.status, 200);
  const inactivePersonTap = await tap(gateKey(secondKey), { rfid_uid: 'A1B2C3D4' });
  expectEqual(
    'inactive person denied',
    (inactivePersonTap.json.data as { access_result?: string } | undefined)?.access_result,
    'denied'
  );
  expectEqual(
    'inactive person denial reason',
    (inactivePersonTap.json.data as { reason?: string } | undefined)?.reason,
    'inactive_id'
  );
  const inactivePersonView = (inactivePersonTap.json.data as { person?: { full_name?: string } } | undefined)
    ?.person;
  expectEqual('inactive person denial carries identity', !!inactivePersonView, true);
  expectEqual('inactive person denial carries the name', inactivePersonView?.full_name, 'Juan Dela Cruz');
  // Restore before the attendance/exit-gate checks below, which expect Juan active.
  const reactivate = await request(superadmin, 'PATCH', `/persons/${personId}/status`, {
    status: 'active',
  });
  expectEqual('person reactivated after the inactive-ID check', reactivate.status, 200);

  // Same distinction for a deactivated vehicle (Ana's car).
  const vehiclesRes = await request(superadmin, 'GET', '/vehicles?limit=100');
  const vehicles = (vehiclesRes.json.data ?? []) as { _id: string; rfid_uid: string }[];
  const anaCar = vehicles.find((v) => v.rfid_uid === 'F6A7B8C9');
  expectEqual('second seeded vehicle found', !!anaCar, true);
  const anaCarId = anaCar?._id ?? '';

  const deactivateVehicle = await request(superadmin, 'PATCH', `/vehicles/${anaCarId}/status`, {
    status: 'inactive',
  });
  expectEqual('vehicle deactivated for the inactive-ID check', deactivateVehicle.status, 200);
  const inactiveVehicleTap = await tap(gateKey(parkingKey), { rfid_uid: 'F6A7B8C9' });
  expectEqual(
    'inactive vehicle denial reason',
    (inactiveVehicleTap.json.data as { reason?: string } | undefined)?.reason,
    'inactive_id'
  );
  const inactiveVehicleView = (inactiveVehicleTap.json.data as { person?: { full_name?: string; plate_number?: string } } | undefined)
    ?.person;
  expectEqual('inactive vehicle denial carries identity', !!inactiveVehicleView, true);
  expectEqual('inactive vehicle denial carries the plate number', inactiveVehicleView?.plate_number, 'NCST-5678');
  const reactivateVehicle = await request(superadmin, 'PATCH', `/vehicles/${anaCarId}/status`, {
    status: 'active',
  });
  expectEqual('vehicle reactivated after the inactive-ID check', reactivateVehicle.status, 200);

  // The earlier grant left Juan's motorcycle occupancy-'inside'. Release it
  // here so the harness ends with the vehicle 'outside' and is safe to run
  // again in the same reset window — otherwise the next run's "granted
  // vehicle tap grants" check would be denied already_inside.
  if (!parkingOutKey) throw new Error('parking exit key minting did not return a key');
  const vehicleExitTap = await tap(gateKey(parkingOutKey), { rfid_uid: 'E5F6A7B8' });
  expectEqual(
    'vehicle exit releases occupancy',
    (vehicleExitTap.json.data as { access_result?: string } | undefined)?.access_result,
    'granted'
  );

  console.log('\n== an expired pass is denied ==');

  // The seeded vehicle used elsewhere in this harness (Juan's motorcycle,
  // plate NCST-1234).
  const expiredUid = 'E5F6A7B8';

  // Find it over HTTP, and read its current expiry so the restore is exact
  // rather than assumed.
  const vehicleListForExpiry = await request(superadmin, 'GET', '/vehicles?limit=100');
  const vehiclesForExpiry = (vehicleListForExpiry.json.data ?? []) as {
    _id: string;
    rfid_uid: string;
    valid_until: string;
  }[];
  expectEqual('vehicle list is non-empty', vehiclesForExpiry.length > 0, true);
  const expiredTarget = vehiclesForExpiry.find((v) => v.rfid_uid === expiredUid);
  expectEqual(`seeded vehicle ${expiredUid} is present`, Boolean(expiredTarget), true);
  const originalValidUntil = expiredTarget!.valid_until;

  const backdated = new Date(Date.now() - 86_400_000).toISOString();
  const patched = await request(superadmin, 'PATCH', `/vehicles/${expiredTarget!._id}`, {
    valid_until: backdated,
  });
  expectEqual('expiry was backdated', patched.status, 200);

  const expiredTap = await tap(gateKey(parkingKey), { rfid_uid: expiredUid });
  expectEqual(
    'an expired pass is denied',
    (expiredTap.json.data as { access_result?: string } | undefined)?.access_result,
    'denied'
  );
  expectEqual(
    'the denial reason is vehicle_expired',
    (expiredTap.json.data as { reason?: string } | undefined)?.reason,
    'vehicle_expired'
  );

  // A denied tap must never move occupancy. Read the roster and confirm this
  // vehicle is not on it. The occupancy projection does not expose entity_id
  // (see occupancy.repository.ts listInside) — for a vehicle it projects the
  // plate_number as `name`, so match on that instead.
  const roster = await request(superadmin, 'GET', '/occupancy?limit=100');
  const inside = (roster.json.data ?? []) as { entity_type?: string; name?: string }[];
  expectEqual(
    'an expired tap did not put the vehicle inside',
    inside.some((r) => r.entity_type === 'vehicle' && r.name === 'NCST-1234'),
    false
  );

  // Restore, and prove the pass works again — which also proves the denial
  // came from expiry rather than from some unrelated state.
  const restoredPatch = await request(superadmin, 'PATCH', `/vehicles/${expiredTarget!._id}`, {
    valid_until: originalValidUntil,
  });
  expectEqual('expiry restored', restoredPatch.status, 200);
  const restoredTap = await tap(gateKey(parkingKey), { rfid_uid: expiredUid });
  expectEqual(
    'the pass works again once restored',
    (restoredTap.json.data as { access_result?: string } | undefined)?.access_result,
    'granted'
  );

  // The restored tap left the vehicle occupancy-'inside'. Release it here so
  // the next run starts clean, or the next run's earlier "granted vehicle tap
  // grants" check would fail with a stale already_inside.
  if (!parkingOutKey) throw new Error('parking exit key minting did not return a key');
  const expiryCleanupExit = await tap(gateKey(parkingOutKey), { rfid_uid: expiredUid });
  expectEqual(
    'post-restore vehicle exit releases occupancy',
    (expiryCleanupExit.json.data as { access_result?: string } | undefined)?.access_result,
    'granted'
  );

  // An exit gate must close the attendance day the entry gate opened.
  const sideGate = gates.find((g) => g.name === 'Side Gate');
  if (!sideGate) throw new Error('Side Gate missing — run npm run seed:test');
  const sideMint = await request(superadmin, 'POST', `/gates/${sideGate._id}/key`);
  const sideKey = (sideMint.json.data as { key?: string } | undefined)?.key;
  expectEqual('side gate key minted', typeof sideKey, 'string');

  const exitTap = await tap(gateKey(sideKey ?? ''), { rfid_uid: 'A1B2C3D4' });
  expectEqual(
    'exit gate grants',
    (exitTap.json.data as { access_result?: string } | undefined)?.access_result,
    'granted'
  );

  const today = localDateKey(new Date());
  const att = await request(
    superadmin,
    'GET',
    `/attendance?person_id=${personId}&from=${today}&to=${today}&limit=5`
  );
  const rows = (att.json.data ?? []) as { time_in?: string | null; time_out?: string | null }[];
  // A length floor: .find on an empty array yields undefined, and every
  // assertion below it would then compare undefined to undefined and pass.
  expectEqual('an attendance row exists for today', rows.length >= 1, true);
  expectEqual('entry gate recorded a time_in', !!rows[0]?.time_in, true);
  expectEqual('exit gate recorded a time_out', !!rows[0]?.time_out, true);
  // Re-runnable: each run's exit tap refreshes time_out to now, so this holds
  // on the first run and every run after.
  expectEqual(
    'time_out came from this run',
    rows[0]?.time_out ? Date.now() - new Date(rows[0].time_out).getTime() < 60_000 : false,
    true
  );

  const unknownKey = await tap(gateKey('gk_live_' + 'a'.repeat(40)), { rfid_uid: 'A1B2C3D4' });
  expectEqual('unknown key rejected', unknownKey.status, 401);

  // firstKey was revoked when the second was minted.
  const revoked = await tap(gateKey(firstKey ?? ''), { rfid_uid: 'A1B2C3D4' });
  expectEqual('revoked key rejected', revoked.status, 401);

  console.log('\n== photo fetch by a gate terminal ==');
  await uploadPhoto(auth(registrar), personId, TINY_JPEG, 'gate.jpg', 'image/jpeg');
  const byGate = await fetch(`${BASE}/persons/${personId}/photo`, {
    headers: { 'X-Gate-Key': secondKey },
  });
  expectEqual('gate key may fetch a photo', byGate.status, 200);
  await request(superadmin, 'DELETE', `/persons/${personId}/photo`);

  // Restore Juan's seeded placeholder photo (see the comment above the first
  // cleanup block): this run deleted it twice while exercising DELETE, and
  // without this the primary demo person is left faceless at the gate
  // terminal until someone runs seed:test again.
  const restored = await uploadPhoto(auth(registrar), personId, TINY_JPEG, 'restore.jpg', 'image/jpeg');
  expectEqual('seeded photo restored for the primary demo person after the run', restored.status, 201);

  summary();
}

main().catch((err) => {
  console.error('[verify:gates] failed', err);
  process.exit(1);
});
