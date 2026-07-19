import { Types } from 'mongoose';
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
      return {
        name: g.name,
        type: g.type,
        location: g.location ?? null,
        last_scan: lastScan,
        status: online ? 'online' : 'offline',
      };
    })
  );
}

/** Latest vehicle scans, resolved to plate number + owner name for display. */
async function parkingActivity(limit: number) {
  return ScanLogModel.aggregate([
    { $match: { entity_type: 'vehicle' } },
    { $sort: { scan_time: -1 } },
    { $limit: limit },
    { $lookup: { from: 'vehicles', localField: 'entity_id', foreignField: '_id', as: 'vehicle' } },
    { $unwind: { path: '$vehicle', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: 'people', localField: 'vehicle.owner_person_id', foreignField: '_id', as: 'owner' } },
    { $lookup: { from: 'gates', localField: 'gate_id', foreignField: '_id', as: 'gate' } },
    {
      $project: {
        _id: 0,
        scan_time: 1,
        direction: 1,
        access_result: 1,
        rfid_uid: 1,
        plate_number: { $ifNull: ['$vehicle.plate_number', null] },
        owner_name: { $arrayElemAt: ['$owner.full_name', 0] },
        gate: { $ifNull: [{ $arrayElemAt: ['$gate.name', 0] }, 'Unknown gate'] },
      },
    },
  ]);
}

/** Latest scans across campus, joined with gate + person names for display. */
async function recentScans(limit: number) {
  return ScanLogModel.aggregate([
    { $sort: { scan_time: -1 } },
    { $limit: limit },
    { $lookup: { from: 'gates', localField: 'gate_id', foreignField: '_id', as: 'gate' } },
    { $lookup: { from: 'people', localField: 'entity_id', foreignField: '_id', as: 'person' } },
    {
      $project: {
        _id: 0,
        scan_time: 1,
        direction: 1,
        access_result: 1,
        entity_type: 1,
        reason: 1,
        rfid_uid: 1,
        gate: { $ifNull: [{ $arrayElemAt: ['$gate.name', 0] }, 'Unknown gate'] },
        name: { $arrayElemAt: ['$person.full_name', 0] },
      },
    },
  ]);
}

export const dashboardService = {
  async get(actor: { role: Role; personId: string | null }) {
    if (actor.role === ROLES.ADMIN) return this.adminView();
    if (actor.personId) return this.userView(actor.personId);
    return { gates: await gateStatuses() }; // unlinked / guard
  },

  async adminView() {
    const today = startOfToday();
    const [
      total_persons,
      by_type,
      total_vehicles,
      scan_events_today,
      granted_today,
      denied_today,
      active_today,
      gates,
      recent_scans,
      parking_activity,
    ] = await Promise.all([
      PersonModel.countDocuments({}),
      PersonModel.aggregate([{ $group: { _id: '$type', count: { $sum: 1 } } }]),
      VehicleModel.countDocuments({}),
      ScanLogModel.countDocuments({ scan_time: { $gte: today } }),
      ScanLogModel.countDocuments({ scan_time: { $gte: today }, access_result: 'granted' }),
      ScanLogModel.countDocuments({ scan_time: { $gte: today }, access_result: 'denied' }),
      AttendanceModel.countDocuments({ date: todayKey() }),
      gateStatuses(),
      recentScans(8),
      parkingActivity(8),
    ]);

    const persons_by_type = { student: 0, staff: 0, employee: 0 };
    for (const row of by_type as { _id: keyof typeof persons_by_type; count: number }[]) {
      if (row._id in persons_by_type) persons_by_type[row._id] = row.count;
    }

    return {
      total_persons,
      persons_by_type,
      active_today,
      total_vehicles,
      scan_events_today,
      granted_today,
      denied_today,
      gates,
      recent_scans,
      parking_activity,
    };
  },

  async userView(personId: string) {
    const oid = new Types.ObjectId(personId);
    const [person, vehicle, today, recent, statusAgg, scans] = await Promise.all([
      PersonModel.findById(personId).lean(),
      VehicleModel.findOne({ owner_person_id: personId }).lean(),
      AttendanceModel.findOne({ person_id: personId, date: todayKey() }).lean(),
      AttendanceModel.find({ person_id: personId }).sort({ date: -1 }).limit(7).lean(),
      AttendanceModel.aggregate([
        { $match: { person_id: oid } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      ScanLogModel.aggregate([
        { $match: { entity_type: 'person', entity_id: oid } },
        { $sort: { scan_time: -1 } },
        { $limit: 6 },
        { $lookup: { from: 'gates', localField: 'gate_id', foreignField: '_id', as: 'gate' } },
        {
          $project: {
            _id: 0,
            scan_time: 1,
            direction: 1,
            access_result: 1,
            gate: { $ifNull: [{ $arrayElemAt: ['$gate.name', 0] }, 'Unknown gate'] },
          },
        },
      ]),
    ]);

    const attendance_summary = { present: 0, late: 0, absent: 0 };
    for (const row of statusAgg as { _id: keyof typeof attendance_summary; count: number }[]) {
      if (row._id in attendance_summary) attendance_summary[row._id] = row.count;
    }

    return {
      person: person
        ? {
            full_name: person.full_name,
            type: person.type,
            id_number: person.id_number,
            department_section: person.department_section ?? null,
            contact_email: person.contact_email ?? null,
            rfid_uid: person.rfid_uid,
            status: person.status,
          }
        : null,
      today: today
        ? { time_in: today.time_in, time_out: today.time_out, status: today.status }
        : null,
      attendance_summary,
      recent_attendance: recent,
      vehicle: vehicle
        ? {
            plate_number: vehicle.plate_number,
            vehicle_type: vehicle.vehicle_type,
            vehicle_model: vehicle.vehicle_model ?? null,
            rfid_uid: vehicle.rfid_uid,
            status: vehicle.status,
          }
        : null,
      recent_scans: scans,
    };
  },
};
