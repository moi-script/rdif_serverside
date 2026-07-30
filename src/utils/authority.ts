import { ApiError } from './ApiError';
import { Role, Domain, rankOf, WRITE_DOMAINS } from '../constants/roles';

export interface Actor {
  id: string;
  role: Role;
}

/**
 * Two independent rules govern this system and they must not be conflated:
 *
 *   - RANK governs actions on login accounts (User).
 *   - WRITE-DOMAIN governs actions on records (Person, Vehicle, Gadget).
 *
 * They are different rules because a Person is not a User. HR creating Ana's
 * profile and HR creating Ana's login are two separate authorizations, and
 * merging them produces an admin who can mint a peer by way of a profile.
 */

/**
 * May `actor` act on an existing account? Used for status changes, deletion,
 * and password resets.
 *
 * Peers and superiors are denied on every path — single and bulk alike. This
 * deliberately reverses the role-system spec's ruling that a superadmin may
 * individually deactivate another superadmin.
 */
export function assertCanActOn(actor: Actor, target: { _id: unknown; role: Role }): void {
  if (String(target._id) === actor.id) {
    throw new ApiError('FORBIDDEN', 'You cannot act on your own account');
  }
  if (rankOf(target.role) >= rankOf(actor.role)) {
    throw new ApiError(
      'FORBIDDEN',
      'You cannot act on an account at or above your own authority level'
    );
  }
}

/**
 * May `actor` create an account with this role?
 *
 * NOT redundant with assertCanActOn. On create there is no target row to
 * compare against, so the rule must apply to the REQUESTED role. Without this
 * guard an HR admin could POST /users { role: 'hr' } and mint a peer — the
 * exact thing peer protection exists to prevent — and it would sail past a
 * target-based check because no target exists yet.
 *
 * A consequence worth stating: POST /users { role: 'superadmin' } is 403 for
 * EVERYONE, superadmins included, since rank 3 >= rank 3. Superadmins are
 * created by `npm run seed` or `npm run grant:superadmin`, never over the API.
 */
export function assertCanCreateRole(actor: Actor, role: Role): void {
  if (rankOf(role) >= rankOf(actor.role)) {
    throw new ApiError(
      'FORBIDDEN',
      'You cannot create an account at or above your own authority level'
    );
  }
}

/** May `actor` write records of this class? */
export function assertCanWrite(actor: Actor, domain: Domain): void {
  if (!WRITE_DOMAINS[actor.role].includes(domain)) {
    throw new ApiError('FORBIDDEN', `Your role cannot modify ${domain} records`);
  }
}
