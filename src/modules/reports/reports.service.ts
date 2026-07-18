import { FilterQuery } from 'mongoose';
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
    if (query.gate_id) match.gate_id = query.gate_id as unknown as IScanLog['gate_id'];
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
};
