/**
 * Asserts the anti-passback behaviour in
 * docs/superpowers/specs/2026-07-29-anti-passback-design.md.
 *
 * Requires: MongoDB reachable at `MONGODB_URI`, `npm run dev` running (the
 * HTTP-based checks below tap through the real server), and `npm run
 * seed:test` already applied.
 * Run with: npm run verify:passback
 */
import mongoose, { Types } from 'mongoose';
import { connectDB } from './db';
import { OccupancyModel } from '../modules/occupancy/occupancy.model';
import { occupancyRepo } from '../modules/occupancy/occupancy.repository';
import { lastResetBoundary } from '../utils/occupancyWindow';
import { PersonModel } from '../modules/persons/persons.model';
import { VehicleModel } from '../modules/vehicles/vehicles.model';

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
  console.log('All anti-passback checks passed.');
}

/** Builds a local-time Date on a fixed calendar day, so assertions read clearly. */
function at(day: number, hh: number, mm: number): Date {
  return new Date(2026, 6, day, hh, mm, 0, 0); // month 6 = July
}

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

interface TapData {
  access_result: 'granted' | 'denied';
  reason: string | null;
  person?: { full_name: string };
}

/** Taps as a superadmin, which names the gate in the body (see scan.routes.ts). */
async function tap(
  token: string,
  rfid_uid: string,
  gate_id: string,
  direction: 'entry' | 'exit'
): Promise<TapData> {
  const { json } = await request(token, 'POST', '/scan/tap', { rfid_uid, gate_id, direction });
  return (json.data ?? {}) as TapData;
}

/** Resolves the seeded gates by name so the harness does not hardcode ObjectIds. */
async function gateIdsByName(token: string): Promise<Record<string, string>> {
  const { json } = await request(token, 'GET', '/gates');
  const list = (json.data ?? []) as { _id: string; name: string }[];
  return Object.fromEntries(list.map((g) => [g.name, g._id]));
}

async function main(): Promise<void> {
  console.log('\n== reset boundary ==');

  // Before the cutoff: the boundary is YESTERDAY's occurrence.
  expectEqual(
    'morning tap resolves to yesterday 23:00',
    lastResetBoundary(at(15, 7, 5), '23:00').getTime(),
    at(14, 23, 0).getTime()
  );

  // After the cutoff: the boundary is TODAY's occurrence.
  expectEqual(
    'late-night tap resolves to today 23:00',
    lastResetBoundary(at(15, 23, 30), '23:00').getTime(),
    at(15, 23, 0).getTime()
  );

  // Exactly at the cutoff counts as "at or before", so it is today's.
  expectEqual(
    'a tap exactly at the cutoff resolves to today',
    lastResetBoundary(at(15, 23, 0), '23:00').getTime(),
    at(15, 23, 0).getTime()
  );

  // One minute before the cutoff is still the previous day's boundary. This is
  // the off-by-one the helper exists to get right.
  expectEqual(
    'one minute before the cutoff resolves to yesterday',
    lastResetBoundary(at(15, 22, 59), '23:00').getTime(),
    at(14, 23, 0).getTime()
  );

  // Midnight is the hardest case: 00:30 with a 23:00 cutoff must look BACK to
  // the previous calendar day, not forward to tonight.
  expectEqual(
    'after midnight resolves to the previous evening',
    lastResetBoundary(at(15, 0, 30), '23:00').getTime(),
    at(14, 23, 0).getTime()
  );

  // A midnight cutoff must not degenerate: at 00:00 the boundary is now.
  expectEqual(
    'a 00:00 cutoff resolves to today at midnight',
    lastResetBoundary(at(15, 0, 0), '00:00').getTime(),
    at(15, 0, 0).getTime()
  );

  // The default-parameter path is contract for Tasks 4, 5 and 7, so exercise it.
  expectEqual(
    'omitting resetTime uses the configured default',
    lastResetBoundary(at(15, 7, 5)).getTime(),
    lastResetBoundary(at(15, 7, 5), '23:00').getTime()
  );

  console.log('\n== occupancy repository ==');
  await connectDB();
  // Mongoose builds indexes in the background after the model is first used.
  // Without waiting for it here, the concurrency round below can fire its
  // duplicate writes before the unique index exists, which makes MongoDB
  // refuse to build it against the resulting duplicate keys — silently
  // disabling passback detection for the rest of the run. Waiting on init()
  // guarantees the index is live before any test traffic hits the collection.
  await OccupancyModel.init();

  const personId = new Types.ObjectId();
  const gateId = new Types.ObjectId();
  const boundary = lastResetBoundary(new Date());
  await OccupancyModel.deleteMany({ entity_id: personId });

  expectEqual(
    'first entry is admitted',
    await occupancyRepo.enter('person', personId, gateId, boundary),
    'admitted'
  );
  expectEqual(
    'second entry with no exit is refused',
    await occupancyRepo.enter('person', personId, gateId, boundary),
    'already_inside'
  );
  expectEqual(
    'exit releases the card',
    await occupancyRepo.release('person', personId, gateId),
    'released'
  );
  expectEqual(
    'entry after a real exit is admitted again',
    await occupancyRepo.enter('person', personId, gateId, boundary),
    'admitted'
  );
  expectEqual(
    'exit after a re-entry releases again',
    await occupancyRepo.release('person', personId, gateId),
    'released'
  );
  expectEqual(
    'exit while already outside is flagged',
    await occupancyRepo.release('person', personId, gateId),
    'exit_without_entry'
  );

  // Lazy expiry: a document stranded inside from BEFORE the boundary must be
  // treated as outside, so a missed exit tap is not a next-morning lockout.
  await occupancyRepo.enter('person', personId, gateId, boundary);
  await OccupancyModel.updateOne(
    { entity_id: personId },
    { $set: { since: new Date(boundary.getTime() - 60_000) } }
  );
  expectEqual(
    'state stranded before the boundary is treated as expired',
    await occupancyRepo.enter('person', personId, gateId, boundary),
    'admitted'
  );

  // The whole point of the design. Eight simultaneous entries on one card must
  // produce exactly ONE grant. A read-then-write implementation passes every
  // sequential check above and fails this one.
  for (let round = 1; round <= 10; round++) {
    const racer = new Types.ObjectId();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => occupancyRepo.enter('person', racer, gateId, boundary))
    );
    expectEqual(
      `round ${round}: exactly one grant under 8 concurrent entries`,
      results.filter((r) => r === 'admitted').length,
      1
    );
    await OccupancyModel.deleteMany({ entity_id: racer });
  }

  // Race against an EXISTING outside document, not a fresh insert. This path
  // resolves through the update predicate rather than the unique index, so it
  // needs its own proof.
  for (let round = 1; round <= 5; round++) {
    const racer = new Types.ObjectId();
    await occupancyRepo.enter('person', racer, gateId, boundary);
    await occupancyRepo.release('person', racer, gateId); // now state: 'outside'
    const results = await Promise.all(
      Array.from({ length: 8 }, () => occupancyRepo.enter('person', racer, gateId, boundary))
    );
    expectEqual(
      `outside-doc round ${round}: exactly one grant under 8 concurrent entries`,
      results.filter((r) => r === 'admitted').length,
      1
    );
    await OccupancyModel.deleteMany({ entity_id: racer });
  }

  // Race against a STALE inside document. Exactly one caller should heal it and
  // be admitted; the other seven must be refused.
  for (let round = 1; round <= 5; round++) {
    const racer = new Types.ObjectId();
    await occupancyRepo.enter('person', racer, gateId, boundary);
    await OccupancyModel.updateOne(
      { entity_id: racer },
      { $set: { since: new Date(boundary.getTime() - 60_000) } }
    );
    const results = await Promise.all(
      Array.from({ length: 8 }, () => occupancyRepo.enter('person', racer, gateId, boundary))
    );
    expectEqual(
      `stale-doc round ${round}: exactly one grant under 8 concurrent entries`,
      results.filter((r) => r === 'admitted').length,
      1
    );
    await OccupancyModel.deleteMany({ entity_id: racer });
  }

  await OccupancyModel.deleteMany({ entity_id: personId });

  console.log('\n== passback at the gate ==');
  const superadmin = await login('testadmin', 'Admin@123');
  const gates = await gateIdsByName(superadmin);
  const personEntry = gates['Main Entrance'];
  const personExit = gates['Side Gate'];
  const vehicleEntry = gates['Parking Entrance'];
  const vehicleExit = gates['Parking Exit'];

  // Juan Dela Cruz from seed:test. Start from a known state.
  const juan = await PersonModel.findOne({ id_number: '2025-0001' }).lean();
  if (!juan) throw new Error('run `npm run seed:test` first — student 2025-0001 is missing');
  await OccupancyModel.deleteMany({ entity_id: juan._id });
  const juanUid = juan.rfid_uid as string;

  const first = await tap(superadmin, juanUid, personEntry, 'entry');
  expectEqual('first entry granted', first.access_result, 'granted');
  expectEqual('first entry has no reason', first.reason, null);

  const second = await tap(superadmin, juanUid, personEntry, 'entry');
  expectEqual('repeat entry denied', second.access_result, 'denied');
  expectEqual('repeat entry names the passback', second.reason, 'already_inside');
  // The subtle half of the personView asymmetry: unlike wrong_gate_type, an
  // already_inside denial must KEEP the cardholder's identity so a guard can
  // see who the system thinks is inside. A future "harmonise the denial
  // branches" refactor that cleared it here would go green without this.
  expectEqual('already_inside denial keeps identity', second.person?.full_name, 'Juan Dela Cruz');

  const out = await tap(superadmin, juanUid, personExit, 'exit');
  expectEqual('exit granted', out.access_result, 'granted');
  expectEqual('exit has no reason', out.reason, null);

  const again = await tap(superadmin, juanUid, personEntry, 'entry');
  expectEqual('entry after a real exit granted', again.access_result, 'granted');

  await tap(superadmin, juanUid, personExit, 'exit');
  const orphanExit = await tap(superadmin, juanUid, personExit, 'exit');
  expectEqual('exit with no entry is never blocked', orphanExit.access_result, 'granted');
  expectEqual('exit with no entry is flagged', orphanExit.reason, 'exit_without_entry');

  // A denied tap must not move anyone's state. Tapping a person card at a
  // VEHICLE gate is denied for wrong_gate_type before occupancy is consulted;
  // if it leaked through, the entry below would come back already_inside.
  const wrongGate = await tap(superadmin, juanUid, vehicleEntry, 'entry');
  expectEqual('person card at a vehicle gate denied', wrongGate.reason, 'wrong_gate_type');
  const afterWrongGate = await tap(superadmin, juanUid, personEntry, 'entry');
  expectEqual('a denied tap left state untouched', afterWrongGate.access_result, 'granted');
  await tap(superadmin, juanUid, personExit, 'exit');

  // Vehicles are covered too.
  const car = await VehicleModel.findOne({}).lean();
  if (car) {
    await OccupancyModel.deleteMany({ entity_id: car._id });
    const carUid = car.rfid_uid;
    expectEqual(
      'vehicle first entry granted',
      (await tap(superadmin, carUid, vehicleEntry, 'entry')).access_result,
      'granted'
    );
    expectEqual(
      'vehicle repeat entry denied',
      (await tap(superadmin, carUid, vehicleEntry, 'entry')).reason,
      'already_inside'
    );
    expectEqual(
      'vehicle exit granted',
      (await tap(superadmin, carUid, vehicleExit, 'exit')).access_result,
      'granted'
    );
    await OccupancyModel.deleteMany({ entity_id: car._id });
  }

  await OccupancyModel.deleteMany({ entity_id: juan._id });
  await mongoose.disconnect();
  summary();
}

main().catch((err) => {
  console.error('[verify:passback] failed', err);
  process.exit(1);
});
