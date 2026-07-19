import bcrypt from 'bcrypt';
import { connectDB, disconnectDB } from './db';
import { UserModel } from '../modules/users/users.model';
import { PersonModel } from '../modules/persons/persons.model';
import { ROLES } from '../constants/roles';

/**
 * Hardcoded test accounts for the testing phase.
 * Run with: npm run seed:test
 * Idempotent — safe to run multiple times.
 */

const HARDCODED_ADMIN = {
  username: 'testadmin',
  password: 'Admin@123',
};

// Student login username = their student number (id_number),
// so the client "Student number" field matches the users table directly.
const HARDCODED_STUDENTS = [
  {
    password: 'Student@123',
    full_name: 'Juan Dela Cruz',
    id_number: '2025-0001',
    department_section: 'BSIT - 4A',
    contact_email: 'juan.delacruz@student.ncst.edu.ph',
    rfid_uid: 'RFID-STU-0001',
  },
  {
    password: 'Student@123',
    full_name: 'Maria Santos',
    id_number: '2025-0002',
    department_section: 'BSCS - 3B',
    contact_email: 'maria.santos@student.ncst.edu.ph',
    rfid_uid: 'RFID-STU-0002',
  },
  {
    password: 'Student@123',
    full_name: 'Pedro Reyes',
    id_number: '2025-0003',
    department_section: 'BSIT - 2C',
    contact_email: 'pedro.reyes@student.ncst.edu.ph',
    rfid_uid: 'RFID-STU-0003',
  },
];

// Old-style usernames from the first seed run — remove so logins are clean.
const LEGACY_STUDENT_USERNAMES = ['student1', 'student2', 'student3'];

async function seedTest(): Promise<void> {
  await connectDB();

  // ---- Admin ----
  const existingAdmin = await UserModel.findOne({ username: HARDCODED_ADMIN.username });
  if (existingAdmin) {
    console.log(`[test-seed] admin '${HARDCODED_ADMIN.username}' already exists — skipping`);
  } else {
    const password_hash = await bcrypt.hash(HARDCODED_ADMIN.password, 12);
    await UserModel.create({
      username: HARDCODED_ADMIN.username,
      password_hash,
      role: ROLES.ADMIN,
      person_id: null,
      must_change_password: false,
      is_active: true,
    });
    console.log(
      `[test-seed] created admin '${HARDCODED_ADMIN.username}' (password: ${HARDCODED_ADMIN.password})`
    );
  }

  // ---- Clean up legacy student logins (student1/2/3) from the earlier seed ----
  const removed = await UserModel.deleteMany({ username: { $in: LEGACY_STUDENT_USERNAMES } });
  if (removed.deletedCount) {
    console.log(`[test-seed] removed ${removed.deletedCount} legacy student login(s): ${LEGACY_STUDENT_USERNAMES.join(', ')}`);
  }

  // ---- Students (login username = student number / id_number) ----
  for (const s of HARDCODED_STUDENTS) {
    // Person profile (idempotent by rfid_uid)
    let person = await PersonModel.findOne({ rfid_uid: s.rfid_uid });
    if (person) {
      console.log(`[test-seed] person '${s.full_name}' already exists — skipping profile`);
    } else {
      person = await PersonModel.create({
        full_name: s.full_name,
        type: 'student',
        id_number: s.id_number,
        department_section: s.department_section,
        contact_email: s.contact_email,
        rfid_uid: s.rfid_uid,
        status: 'active',
      });
      console.log(`[test-seed] created person '${s.full_name}' (rfid: ${s.rfid_uid})`);
    }

    // Login account — username IS the student number (idempotent by username)
    const existingUser = await UserModel.findOne({ username: s.id_number });
    if (existingUser) {
      console.log(`[test-seed] user '${s.id_number}' already exists — skipping login`);
    } else {
      const password_hash = await bcrypt.hash(s.password, 12);
      await UserModel.create({
        username: s.id_number,
        password_hash,
        role: ROLES.USER,
        person_id: person._id,
        must_change_password: false,
        is_active: true,
      });
      console.log(
        `[test-seed] created student login '${s.id_number}' (password: ${s.password}) -> '${s.full_name}'`
      );
    }
  }

  await disconnectDB();
  console.log('[test-seed] done');
}

seedTest().catch(async (err) => {
  console.error('[test-seed] failed', err);
  await disconnectDB().catch(() => undefined);
  process.exit(1);
});
