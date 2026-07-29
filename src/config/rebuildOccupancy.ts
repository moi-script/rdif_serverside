/**
 * Rebuilds the occupancy collection from scan_logs.
 *
 * Occupancy is a read-optimised second source of truth; scan_logs is the
 * record of what actually happened. If the two ever disagree — after a restore,
 * a manual edit, or a bug — this reconciles occupancy back to the logs.
 *
 * Only scans since the last reset boundary matter: anything older is expired by
 * definition. Manual-override rows need no special handling; they are granted
 * exits, and replaying them as exits is exactly right.
 *
 * Run with: npm run rebuild:occupancy
 */
import mongoose from 'mongoose';
import { connectDB } from './db';
import { ScanLogModel } from '../modules/scan/scan.model';
import { OccupancyModel } from '../modules/occupancy/occupancy.model';
import { lastResetBoundary } from '../utils/occupancyWindow';

interface Pending {
  entity_type: 'person' | 'vehicle';
  entity_id: mongoose.Types.ObjectId;
  since: Date;
  last_gate_id: mongoose.Types.ObjectId | null;
}

async function main(): Promise<void> {
  await connectDB();
  // Mongoose builds indexes in the background. deleteMany + insertMany below
  // races that build unless we wait for it: an earlier task in this feature
  // hit duplicates being written before the unique (entity_type, entity_id)
  // index finished, which then failed the index build permanently and
  // silently disabled passback detection. server.ts and the verify harness
  // both wait on this same call for the same reason.
  await OccupancyModel.init();
  const boundary = lastResetBoundary(new Date());
  console.log(`[rebuild] replaying granted scans since ${boundary.toISOString()}`);

  const logs = await ScanLogModel.find({
    scan_time: { $gte: boundary },
    access_result: 'granted',
    entity_id: { $ne: null },
  })
    .sort({ scan_time: 1 })
    .lean();

  // Last write wins per entity, in chronological order.
  const inside = new Map<string, Pending>();
  for (const log of logs) {
    if (!log.entity_id) continue;
    const key = `${log.entity_type}:${String(log.entity_id)}`;
    if (log.direction === 'entry') {
      inside.set(key, {
        entity_type: log.entity_type,
        entity_id: log.entity_id,
        since: log.scan_time,
        last_gate_id: log.gate_id ?? null,
      });
    } else {
      inside.delete(key);
    }
  }

  await OccupancyModel.deleteMany({});
  if (inside.size > 0) {
    // Only `inside` rows are written. A missing document already means outside,
    // so writing `outside` rows would bloat the collection to the full roster.
    await OccupancyModel.insertMany(
      [...inside.values()].map((p) => ({
        entity_type: p.entity_type,
        entity_id: p.entity_id,
        state: 'inside' as const,
        since: p.since,
        last_gate_id: p.last_gate_id,
        cleared_by: null,
        cleared_at: null,
      }))
    );
  }

  console.log(`[rebuild] ${logs.length} scans replayed, ${inside.size} entities marked inside`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[rebuild:occupancy] failed', err);
  process.exit(1);
});
