import bcrypt from 'bcrypt';
import { connectDB, disconnectDB } from './db';
import { env } from './env';
import { UserModel } from '../modules/users/users.model';
import { GateModel } from '../modules/gates/gates.model';
import { ROLES } from '../constants/roles';

const GATES = [
  { name: 'Main Entrance', type: 'person' as const, location: 'Front Building Gate A' },
  { name: 'Side Gate', type: 'person' as const, location: 'South Wing Gate B' },
  { name: 'Parking Entrance', type: 'vehicle' as const, location: 'Parking Lot Entry' },
  { name: 'Parking Exit', type: 'vehicle' as const, location: 'Parking Lot Exit' },
];

async function seed(): Promise<void> {
  await connectDB();

  // Admin (idempotent)
  const existingAdmin = await UserModel.findOne({ username: env.ADMIN_USERNAME });
  if (existingAdmin) {
    console.log(`[seed] admin '${env.ADMIN_USERNAME}' already exists — skipping`);
  } else {
    const password_hash = await bcrypt.hash(env.ADMIN_PASSWORD, 12);
    await UserModel.create({
      username: env.ADMIN_USERNAME,
      password_hash,
      role: ROLES.ADMIN,
      person_id: null,
      must_change_password: true,
      is_active: true,
    });
    console.log(`[seed] created admin '${env.ADMIN_USERNAME}'`);
  }

  // Gates (idempotent by name)
  for (const g of GATES) {
    const exists = await GateModel.findOne({ name: g.name });
    if (exists) {
      console.log(`[seed] gate '${g.name}' already exists — skipping`);
    } else {
      await GateModel.create(g);
      console.log(`[seed] created gate '${g.name}'`);
    }
  }

  await disconnectDB();
  console.log('[seed] done');
}

seed().catch(async (err) => {
  console.error('[seed] failed', err);
  await disconnectDB().catch(() => undefined);
  process.exit(1);
});
