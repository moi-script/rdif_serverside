import { FilterQuery, Types } from 'mongoose';
import { vehicleApplicationRepo } from './vehicleApplications.repository';
import { IVehicleApplication } from './vehicleApplications.model';
import { ApiError } from '../../utils/ApiError';
import { getPagination, buildMeta } from '../../utils/pagination';
import { Actor, assertCanWrite } from '../../utils/authority';
import { nextSchoolYearEnd } from '../../utils/schoolYear';
import { personRepo } from '../persons/persons.repository';
import { vehicleService } from '../vehicles/vehicles.service';

interface ListQuery {
  page?: string;
  limit?: string;
  owner_person_id?: string;
  plate_no?: string;
  school_year?: string;
  category?: string;
}

export interface CreateApplicationInput {
  category: 'new' | 'renewal';
  applicant_type: 'student' | 'employee';
  vehicle_type: 'motorcycle' | 'car' | 'tricycle' | 'other';
  owner_person_id: string;
  id_number: string;
  last_name: string;
  first_name: string;
  middle_name?: string;
  year_level?: string;
  school_year: string;
  email?: string;
  mobile_no?: string;
  tel_no?: string;
  permanent_address?: string;
  driver_name?: string;
  driver_license_no?: string;
  lto_cr_no?: string;
  lto_cr_date?: string;
  lto_or_no?: string;
  lto_or_date?: string;
  plate_no: string;
  mv_file_no?: string;
  make: string;
  model?: string;
  year?: string;
  color?: string;
  registered_owner_name: string;
  relationship?: string;
  signed_name: string;
  signed_date: string;
  rfid_uid: string;
  valid_until?: string;
}

export const vehicleApplicationService = {
  async list(query: ListQuery) {
    const p = getPagination(query as Record<string, unknown>);
    const filter: FilterQuery<IVehicleApplication> = {};
    if (query.owner_person_id) filter.owner_person_id = query.owner_person_id;
    if (query.plate_no) filter.plate_no = query.plate_no;
    if (query.school_year) filter.school_year = query.school_year;
    if (query.category) filter.category = query.category;
    const { items, total } = await vehicleApplicationRepo.findPaginated(filter, p);
    return { items, meta: buildMeta(total, p.page, p.limit) };
  },

  async get(id: string) {
    const application = await vehicleApplicationRepo.findById(id);
    if (!application) throw new ApiError('NOT_FOUND', 'Application not found');
    return application;
  },

  /**
   * Write order is load-bearing, not stylistic. There are no transactions (a
   * standalone Mongo has no replica set), so a partial failure is possible and
   * the order decides which side it leaves safe:
   *   1. application  — crash here: paperwork only, nobody gained access
   *   2. vehicle      — gate access begins only now
   *   3. vehicle_id   — system link back onto the application
   *
   * The reverse order would leave a vehicle opening the barrier with no
   * supporting document, which is the failure a pass audit exists to catch.
   * This is the creation-side mirror of the rule users.service states for
   * deactivation: the gate is the first thing closed and the last thing opened.
   */
  async create(input: CreateApplicationInput, actor: Actor) {
    assertCanWrite(actor, 'vehicle');

    const owner = await personRepo.findById(input.owner_person_id);
    if (!owner) throw new ApiError('NOT_FOUND', 'Applicant not found');

    // `model` is destructured out here (not spread through) because the
    // persisted field is named `vehicle_model` — a bare `model` property
    // collides with mongoose Document's own `.model()` method and fails to
    // typecheck. Mirrors the name Vehicle already uses for the same value,
    // for the same reason (see vehicles.model.ts). The wire-level field
    // (request body, paper form) stays `model`; only the persisted column
    // and this mapping are affected.
    const { model, ...rest } = input;
    const application = await vehicleApplicationRepo.create({
      ...rest,
      owner_person_id: new Types.ObjectId(input.owner_person_id),
      vehicle_model: model,
      lto_cr_date: input.lto_cr_date ? new Date(input.lto_cr_date) : undefined,
      lto_or_date: input.lto_or_date ? new Date(input.lto_or_date) : undefined,
      signed_date: new Date(input.signed_date),
      created_by: new Types.ObjectId(actor.id),
    });

    const vehicle = await vehicleService.create(
      {
        owner_person_id: application.owner_person_id,
        plate_number: input.plate_no,
        rfid_uid: input.rfid_uid,
        vehicle_type: input.vehicle_type,
        make: input.make,
        vehicle_model: input.model,
        color: input.color,
        valid_until: input.valid_until ? new Date(input.valid_until) : nextSchoolYearEnd(),
      },
      actor
    );

    const linked = await vehicleApplicationRepo.linkVehicle(String(application._id), vehicle._id);
    return { application: linked, vehicle };
  },
};
