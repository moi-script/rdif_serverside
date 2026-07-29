import { FilterQuery, Types } from 'mongoose';
import { AttendanceModel, IAttendance } from '../attendance/attendance.model';
import { ScanLogModel, IScanLog } from '../scan/scan.model';

interface AttendanceReportQuery {
  from?: string;
  to?: string;
  status?: string;
}

interface GateActivityQuery {
  gate_id?: string;
  from?: string;
  to?: string;
}

interface AnomalyQuery {
  from?: string;
  to?: string;
}

export const reportService = {
  async attendance(query: AttendanceReportQuery) {
    const filter: FilterQuery<IAttendance> = {};
    if (query.status) filter.status = query.status;
    if (query.from || query.to) {
      const range: Record<string, string> = {};
      if (query.from) range.$gte = query.from;
      if (query.to) range.$lte = query.to;
      filter.date = range;
    }
    const rows = await AttendanceModel.find(filter).sort({ date: -1 }).lean();
    return { count: rows.length, rows };
  },

  async gateActivity(query: GateActivityQuery) {
    const match: FilterQuery<IScanLog> = {};
    if (query.gate_id) {
      match.gate_id = new Types.ObjectId(query.gate_id) as unknown as IScanLog['gate_id'];
    } else {
      // Manual-override rows have no gate. Without this they aggregate into a
      // null bucket that reads as a phantom gate.
      match.gate_id = { $ne: null } as unknown as IScanLog['gate_id'];
    }
    if (query.from || query.to) {
      const range: Record<string, Date> = {};
      if (query.from) range.$gte = new Date(query.from);
      if (query.to) range.$lte = new Date(query.to);
      match.scan_time = range;
    }
    const rows = await ScanLogModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: { gate_id: '$gate_id', access_result: '$access_result' },
          count: { $sum: 1 },
        },
      },
    ]);
    return { count: rows.length, rows };
  },

  /**
   * Every scan the passback system considers abnormal: refused repeat entries,
   * exits with no matching entry, occupancy writes that failed on exit, and
   * superadmin overrides. Capped at 500 rows — unlike the older reports here,
   * this one is bounded on purpose.
   */
  async anomalies(query: AnomalyQuery) {
    const match: Record<string, unknown> = {
      reason: {
        $in: ['already_inside', 'exit_without_entry', 'manual_override', 'occupancy_unavailable'],
      },
    };
    if (query.from || query.to) {
      const range: Record<string, Date> = {};
      if (query.from) range.$gte = new Date(query.from);
      if (query.to) range.$lte = new Date(query.to);
      match.scan_time = range;
    }

    const rows = await ScanLogModel.aggregate([
      { $match: match },
      { $sort: { scan_time: -1 } },
      { $limit: 500 },
      { $lookup: { from: 'people', localField: 'entity_id', foreignField: '_id', as: 'person' } },
      { $lookup: { from: 'gates', localField: 'gate_id', foreignField: '_id', as: 'gate' } },
      {
        $project: {
          _id: 0,
          scan_time: 1,
          reason: 1,
          direction: 1,
          access_result: 1,
          entity_type: 1,
          rfid_uid: 1,
          name: { $arrayElemAt: ['$person.full_name', 0] },
          gate: { $ifNull: [{ $arrayElemAt: ['$gate.name', 0] }, 'Manual override'] },
        },
      },
    ]);
    return { count: rows.length, rows };
  },
};
