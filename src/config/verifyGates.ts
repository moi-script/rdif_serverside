/**
 * Asserts the photo pipeline and gate terminal behavior in
 * docs/superpowers/specs/2026-07-27-photo-and-gate-terminals-design.md.
 *
 * Requires: `npm run dev` running, and `npm run seed:test` already applied.
 * Run with: npm run verify:gates
 */
import { detectImageType } from '../utils/imageType';

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

  const superadmin = await login('testadmin', 'Admin@123');
  const registrar = await login('testregistrar', 'Registrar@123');
  const student = await login('2025-0001', 'Student@123');
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  // Juan Dela Cruz — seeded by seed:test.
  const list = await request(superadmin, 'GET', '/persons?limit=100');
  const persons = (list.json.data ?? []) as { _id: string; id_number: string }[];
  if (persons.length < 4) {
    throw new Error(`expected at least 4 seeded persons, got ${persons.length}`);
  }
  const juan = persons.find((p) => p.id_number === '2025-0001');
  if (!juan) throw new Error('seeded person 2025-0001 not found — run npm run seed:test');
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

  const maria = persons.find((p) => p.id_number === '2025-0002');
  // Presence floor: without this, every assertion below would compare
  // undefined to undefined and pass vacuously.
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

  // Restore: the seed leaves Juan and Maria without photos, so remove what we added.
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
  if (!mainGate || !parkingIn) throw new Error('expected gates missing — run npm run seed:test');

  const registrarMint = await request(registrar, 'POST', `/gates/${mainGate._id}/key`);
  expectEqual('registrar cannot mint a key', registrarMint.status, 403);

  const firstMint = await request(superadmin, 'POST', `/gates/${mainGate._id}/key`);
  expectEqual('superadmin can mint a key', firstMint.status, 201);
  const firstKey = (firstMint.json.data as { key?: string } | undefined)?.key;
  expectEqual('minted key has the documented shape', /^gk_live_[0-9a-f]{40}$/.test(firstKey ?? ''), true);

  const parkingMint = await request(superadmin, 'POST', `/gates/${parkingIn._id}/key`);
  const parkingKey = (parkingMint.json.data as { key?: string } | undefined)?.key;
  expectEqual('parking key minted', typeof parkingKey, 'string');

  // Minting again must revoke the first key.
  const secondMint = await request(superadmin, 'POST', `/gates/${mainGate._id}/key`);
  const secondKey = (secondMint.json.data as { key?: string } | undefined)?.key;
  expectEqual('second mint succeeded', secondMint.status, 201);
  expectEqual('second key differs from the first', firstKey !== secondKey, true);

  summary();
}

main().catch((err) => {
  console.error('[verify:gates] failed', err);
  process.exit(1);
});
