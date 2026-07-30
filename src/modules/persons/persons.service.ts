import { FilterQuery } from 'mongoose';
import { personRepo } from './persons.repository';
import { IPerson } from './persons.model';
import { ApiError } from '../../utils/ApiError';
import { getPagination, buildMeta } from '../../utils/pagination';
import { ROLES, personDomain } from '../../constants/roles';
import { Actor, assertCanWrite, assertCanActOn } from '../../utils/authority';
import { userRepo } from '../users/users.repository';

interface ListQuery {
  page?: string;
  limit?: string;
  type?: string;
  status?: string;
  section?: string;
  search?: string;
}

export const personService = {
  async list(query: ListQuery) {
    const p = getPagination(query as Record<string, unknown>);
    const filter: FilterQuery<IPerson> = {};
    if (query.type) filter.type = query.type;
    if (query.status) filter.status = query.status;
    if (query.section) filter.department_section = query.section;
    if (query.search) {
      const rx = { $regex: query.search, $options: 'i' };
      filter.$or = [{ full_name: rx }, { id_number: rx }];
    }
    const { items, total } = await personRepo.findPaginated(filter, p);
    return { items, meta: buildMeta(total, p.page, p.limit) };
  },

  async exportCsv(query: ListQuery): Promise<string> {
    const filter: FilterQuery<IPerson> = {};
    if (query.type) filter.type = query.type;
    if (query.status) filter.status = query.status;
    if (query.section) filter.department_section = query.section;
    if (query.search) {
      const rx = { $regex: query.search, $options: 'i' };
      filter.$or = [{ full_name: rx }, { id_number: rx }];
    }
    const rows = await personRepo.findAll(filter);
    const header =
      'full_name,type,id_number,department_section,contact_email,photo_url,rfid_uid';
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = rows.map((r) =>
      [
        r.full_name,
        r.type,
        r.id_number,
        r.department_section,
        r.contact_email,
        r.photo_url,
        r.rfid_uid,
      ]
        .map(esc)
        .join(',')
    );
    return [header, ...lines].join('\n');
  },

  async sections(type?: string) {
    return personRepo.distinctSections(type);
  },

  async get(id: string) {
    const person = await personRepo.findById(id);
    if (!person) throw new ApiError('NOT_FOUND', 'Person not found');
    return person;
  },

  async create(data: Partial<IPerson>, actor: Actor) {
    if (!data.type) throw new ApiError('VALIDATION_ERROR', 'type is required');
    assertCanWrite(actor, personDomain(data.type));

    if (data.id_number) {
      const dup = await personRepo.findByIdNumber(data.id_number);
      if (dup) throw new ApiError('DUPLICATE_ID');
    }
    if (data.rfid_uid) {
      const existing = await personRepo.findByRfid(data.rfid_uid);
      if (existing) throw new ApiError('DUPLICATE_RFID');
    } else {
      data.status = data.status ?? 'pending';
    }
    return personRepo.create(data);
  },

  async import(rows: Partial<IPerson>[], actor: Actor) {
    const skipped: { row: number; reason: string }[] = [];
    let created = 0;
    for (let i = 0; i < rows.length; i++) {
      try {
        await this.create(rows[i], actor);
        created++;
      } catch (err) {
        const reason =
          err instanceof ApiError && err.code === 'FORBIDDEN'
            ? 'your role cannot register this person type'
            : err instanceof ApiError && err.code === 'DUPLICATE_ID'
              ? 'id_number already registered'
              : err instanceof ApiError && err.code === 'DUPLICATE_RFID'
                ? 'rfid_uid already registered'
                : (err as { code?: number }).code === 11000
                  ? 'duplicate key (id_number or rfid_uid)'
                  : (err as Error).message;
        skipped.push({ row: i + 1, reason });
      }
    }
    return { created, skipped };
  },

  /**
   * A type change moves a record BETWEEN domains, so both sides are checked.
   *
   * Checking one direction only leaves the other open: check the incoming type
   * alone and a registrar can claim a staff record by retyping it to student;
   * check the existing type alone and a registrar can push a student out to
   * staff, beyond their own reach and into HR's without HR knowing.
   */
  async update(id: string, data: Partial<IPerson>, actor: Actor) {
    const existing = await personRepo.findById(id);
    if (!existing) throw new ApiError('NOT_FOUND', 'Person not found');

    assertCanWrite(actor, personDomain(existing.type));
    if (data.type && data.type !== existing.type) {
      assertCanWrite(actor, personDomain(data.type));
    }

    // A superadmin's DELETE /users/:id soft-deletes the linked login AND sets
    // this Person's status to 'inactive' in the same action, closing the
    // gate. assertCanWrite alone does not see that: a registrar/HR account
    // with ordinary write authority over this person's domain could
    // otherwise silently reopen the gate — a card whose login the
    // superadmin killed would work again — while the login itself stays
    // dead and hidden from the Accounts list (buildFilter excludes
    // deleted_at). Only a superadmin may reverse that; anyone else needs to
    // go through a superadmin, who can restore the User first.
    //
    // A merely-deactivated (not deleted) login also needs a rank check, not
    // just a domain check. HR and OSS logins can be person-backed too — only
    // the seeded office accounts happen to be person-less — so without this,
    // an HR account could reactivate a *peer* HR account's Person here even
    // though PATCH /users/:id/status would deny that same actor for
    // assertCanActOn's peer/self rule. Deferring to assertCanActOn whenever a
    // linked User exists makes this route produce the exact same outcome as
    // the /users route the actor would otherwise have to use, closing that
    // gap while leaving every legitimate reactivation of a subordinate's
    // account working.
    if (data.status === 'active' && actor.role !== ROLES.SUPERADMIN) {
      const linkedUser = await userRepo.findByPersonId(id);
      if (linkedUser?.deleted_at) {
        throw new ApiError(
          'FORBIDDEN',
          "This person's account was deleted by an administrator; ask a superadmin to restore it."
        );
      }
      if (linkedUser && !linkedUser.is_active) {
        assertCanActOn(actor, linkedUser);
      }
    }

    const updated = await personRepo.updateById(id, data);
    if (!updated) throw new ApiError('NOT_FOUND', 'Person not found');
    return updated;
  },

  async setStatus(id: string, status: 'active' | 'inactive', actor: Actor) {
    return this.update(id, { status }, actor);
  },

  async reassignRfid(id: string, rfid_uid: string, actor: Actor) {
    const clash = await personRepo.findByRfid(rfid_uid);
    if (clash && String(clash._id) !== id) throw new ApiError('DUPLICATE_RFID');
    return this.update(id, { rfid_uid }, actor);
  },
};
