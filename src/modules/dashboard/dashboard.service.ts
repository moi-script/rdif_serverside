import { PersonModel } from '../persons/persons.model';
import { VehicleModel } from '../vehicles/vehicles.model';
import { ScanLogModel } from '../scan/scan.model';
import { GateModel } from '../gates/gates.model';
import { AttendanceModel } from '../attendance/attendance.model';
import { ROLES, Role } from '../../constants/roles';

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function gateStatuses() {
  const gates = await GateModel.find().lean();
  return Promise.all(
    gates.map(async (g) => {
      const last = await ScanLogModel.findOne({ gate_id: g._id }).sort({ scan_time: -1 }).lean();
      const lastScan = last?.scan_time ?? null;
      const online = lastScan ? Date.now() - new Date(lastScan).getTime() < 5 * 60 * 1000 : false;
      return { name: g.name, last_scan: lastScan, status: online ? 'online' : 'offline' };
    })
  );
}

export const dashboardService = {
  async get(actor: { role: Role; personId: string | null }) {
    if (actor.role === ROLES.ADMIN) return this.adminView();
    if (actor.personId) return this.userView(actor.personId);
    return { gates: await gateStatuses() }; // unlinked / guard
  },

  async adminView() {
    const today = startOfToday();
    const [total_persons, total_vehicles, scan_events_today, denied_today, active_today, gates] =
      await Promise.all([
        PersonModel.countDocuments({}),
        VehicleModel.countDocuments({}),
        ScanLogModel.countDocuments({ scan_time: { $gte: today } }),
        ScanLogModel.countDocuments({ scan_time: { $gte: today }, access_result: 'denied' }),
        AttendanceModel.countDocuments({ date: todayKey() }),
        gateStatuses(),
      ]);
    return { total_persons, active_today, total_vehicles, scan_events_today, denied_today, gates };
  },

  async userView(personId: string) {
    const [person, vehicle, today, recent] = await Promise.all([
      PersonModel.findById(personId).lean(),
      VehicleModel.findOne({ owner_person_id: personId }).lean(),
      AttendanceModel.findOne({ person_id: personId, date: todayKey() }).lean(),
      AttendanceModel.find({ person_id: personId }).sort({ date: -1 }).limit(7).lean(),
    ]);
    return {
      person: person ? { full_name: person.full_name, status: person.status } : null,
      today: today
        ? { time_in: today.time_in, time_out: today.time_out, status: today.status }
        : null,
      recent_attendance: recent,
      vehicle: vehicle ? { plate_number: vehicle.plate_number, status: vehicle.status } : null,
    };
  },
};
