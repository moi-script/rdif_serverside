import { Types } from 'mongoose';
import { OccupancyModel, IOccupancy } from './occupancy.model';
import { isDuplicateKey } from '../../utils/isDuplicateKey';
import { PaginationParams } from '../../utils/pagination';

export type EntityType = 'person' | 'vehicle';
export type EnterResult = 'admitted' | 'already_inside';
export type ExitResult = 'released' | 'exit_without_entry';

export const occupancyRepo = {
  /**
   * Flips the entity to `inside` only if it is currently outside, or if its
   * state predates `boundary` and is therefore stale.
   *
   * The filter and the write are ONE operation on purpose. If the document
   * exists and is genuinely fresh-inside, the filter matches nothing, the
   * upsert attempts an insert, and the unique index rejects it — that E11000
   * is the passback. Splitting this into a read then a write reintroduces the
   * race the whole feature exists to close.
   */
  async enter(
    entity_type: EntityType,
    entity_id: Types.ObjectId,
    gate_id: Types.ObjectId,
    boundary: Date
  ): Promise<EnterResult> {
    try {
      await OccupancyModel.findOneAndUpdate(
        {
          entity_type,
          entity_id,
          $or: [{ state: 'outside' }, { since: { $lt: boundary } }],
        },
        {
          $set: {
            state: 'inside',
            since: new Date(),
            last_gate_id: gate_id,
            cleared_by: null,
            cleared_at: null,
          },
        },
        { upsert: true, new: true }
      );
      return 'admitted';
    } catch (err: unknown) {
      if (isDuplicateKey(err)) return 'already_inside';
      throw err;
    }
  },

  /** Exit never fails. A miss means they were not inside, which is an anomaly, not a denial. */
  async release(
    entity_type: EntityType,
    entity_id: Types.ObjectId,
    gate_id: Types.ObjectId
  ): Promise<ExitResult> {
    const doc = await OccupancyModel.findOneAndUpdate(
      { entity_type, entity_id, state: 'inside' },
      { $set: { state: 'outside', since: new Date(), last_gate_id: gate_id } }
    );
    return doc ? 'released' : 'exit_without_entry';
  },

  clearById(id: string, clearedBy: Types.ObjectId): Promise<IOccupancy | null> {
    return OccupancyModel.findOneAndUpdate(
      { _id: id, state: 'inside' },
      { $set: { state: 'outside', since: new Date(), cleared_by: clearedBy, cleared_at: new Date() } },
      { new: false }
    ).lean<IOccupancy | null>();
  },

  /**
   * The presence roster. Applies the same staleness rule as `enter`, so a
   * stranded row never shows up as somebody standing on campus.
   */
  async listInside(boundary: Date, p: PaginationParams) {
    const filter = { state: 'inside', since: { $gte: boundary } };
    const [items, total] = await Promise.all([
      OccupancyModel.aggregate([
        { $match: filter },
        { $sort: { since: -1 } },
        { $skip: p.skip },
        { $limit: p.limit },
        { $lookup: { from: 'people', localField: 'entity_id', foreignField: '_id', as: 'person' } },
        { $lookup: { from: 'vehicles', localField: 'entity_id', foreignField: '_id', as: 'vehicle' } },
        { $lookup: { from: 'gates', localField: 'last_gate_id', foreignField: '_id', as: 'gate' } },
        {
          $project: {
            _id: 1,
            entity_type: 1,
            since: 1,
            name: {
              $ifNull: [
                { $arrayElemAt: ['$person.full_name', 0] },
                { $arrayElemAt: ['$vehicle.plate_number', 0] },
              ],
            },
            id_number: { $arrayElemAt: ['$person.id_number', 0] },
            gate: { $ifNull: [{ $arrayElemAt: ['$gate.name', 0] }, 'Unknown gate'] },
          },
        },
      ]),
      OccupancyModel.countDocuments(filter),
    ]);
    return { items, total };
  },
};
