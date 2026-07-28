import { Types } from 'mongoose';
import { personSignatureRepo } from './personSignatures.repository';
import { PersonModel } from './persons.model';
import { detectImageType } from '../../utils/imageType';
import { ApiError } from '../../utils/ApiError';
import { ROLES, Role } from '../../constants/roles';

const INTERNAL_SIGNATURE_URL = (id: string) => `/persons/${id}/signature`;

export interface SignatureActor {
  role: Role;
  personId: string | null;
}

function assertValidId(id: string): void {
  if (!Types.ObjectId.isValid(id)) throw new ApiError('NOT_FOUND', 'Person not found');
}

/**
 * A signature belongs to the hand that drew it, so a portal user reaches only
 * their own. Registrars and superadmins reach anyone's, which is what lets them
 * capture a signature at the desk for someone with no portal login.
 *
 * Failure is 404 rather than 403 for the same reason as photos: a 403 confirms
 * the record exists, which lets an unauthorized caller enumerate who has a
 * signature on file.
 */
function assertMayManage(actor: SignatureActor, personId: string): void {
  const privileged = actor.role === ROLES.SUPERADMIN || actor.role === ROLES.REGISTRAR;
  if (privileged) return;
  if (actor.personId === personId) return;
  throw new ApiError('NOT_FOUND', 'No signature on file');
}

export const personSignatureService = {
  async upload(personId: string, actor: SignatureActor, file: Express.Multer.File | undefined) {
    assertValidId(personId);
    assertMayManage(actor, personId);
    if (!file) {
      throw new ApiError('VALIDATION_ERROR', 'No signature uploaded (field name: signature)');
    }

    const person = await PersonModel.findById(personId);
    if (!person) throw new ApiError('NOT_FOUND', 'Person not found');

    // The declared Content-Type is ignored; only the bytes decide. PNG alone,
    // because only PNG carries the transparent background the canvas exports.
    const mime = detectImageType(file.buffer);
    if (mime !== 'image/png') {
      throw new ApiError('VALIDATION_ERROR', 'Signature must be a PNG image');
    }

    const saved = await personSignatureRepo.upsert(personId, file.buffer);
    person.signature_url = INTERNAL_SIGNATURE_URL(personId);
    await person.save();

    return {
      signature_url: person.signature_url,
      mime: saved.mime,
      byte_size: saved.byte_size,
    };
  },

  async get(personId: string, actor: SignatureActor) {
    assertValidId(personId);
    assertMayManage(actor, personId);

    const signature = await personSignatureRepo.findByPersonId(personId);
    if (!signature) throw new ApiError('NOT_FOUND', 'No signature on file');
    return signature;
  },

  async remove(personId: string, actor: SignatureActor) {
    assertValidId(personId);
    assertMayManage(actor, personId);

    const person = await PersonModel.findById(personId);
    if (!person) throw new ApiError('NOT_FOUND', 'Person not found');

    await personSignatureRepo.deleteByPersonId(personId);

    if (person.signature_url === INTERNAL_SIGNATURE_URL(personId)) {
      person.signature_url = undefined;
      await person.save();
    }
    return { signature_url: person.signature_url ?? null };
  },
};
