import { Types } from 'mongoose';
import { personPhotoRepo } from './personPhotos.repository';
import { PersonModel } from './persons.model';
import { detectImageType } from '../../utils/imageType';
import { ApiError } from '../../utils/ApiError';

const INTERNAL_PHOTO_URL = (id: string) => `/persons/${id}/photo`;

function assertValidId(id: string): void {
  if (!Types.ObjectId.isValid(id)) throw new ApiError('NOT_FOUND', 'Person not found');
}

export const personPhotoService = {
  async upload(personId: string, file: Express.Multer.File | undefined) {
    assertValidId(personId);
    if (!file) throw new ApiError('VALIDATION_ERROR', 'No photo uploaded (field name: photo)');

    const person = await PersonModel.findById(personId);
    if (!person) throw new ApiError('NOT_FOUND', 'Person not found');

    // The declared Content-Type is ignored; only the bytes decide.
    const mime = detectImageType(file.buffer);
    if (!mime) {
      throw new ApiError('VALIDATION_ERROR', 'File is not a JPEG, PNG, or WebP image');
    }

    const saved = await personPhotoRepo.upsert(personId, file.buffer, mime);
    person.photo_url = INTERNAL_PHOTO_URL(personId);
    await person.save();

    return { photo_url: person.photo_url, mime: saved.mime, byte_size: saved.byte_size };
  },

  async get(personId: string) {
    assertValidId(personId);
    const photo = await personPhotoRepo.findByPersonId(personId);
    if (!photo) throw new ApiError('NOT_FOUND', 'No photo on file');
    return photo;
  },

  async remove(personId: string) {
    assertValidId(personId);
    const person = await PersonModel.findById(personId);
    if (!person) throw new ApiError('NOT_FOUND', 'Person not found');

    await personPhotoRepo.deleteByPersonId(personId);

    // Only clear photo_url when it points at us. An externally hosted URL
    // (bulk CSV import) is not ours to erase.
    if (person.photo_url === INTERNAL_PHOTO_URL(personId)) {
      person.photo_url = undefined;
      await person.save();
    }
    return { photo_url: person.photo_url ?? null };
  },
};
