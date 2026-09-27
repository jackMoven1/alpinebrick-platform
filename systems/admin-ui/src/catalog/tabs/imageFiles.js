export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024

/** Mirrors core's accepted types and ceiling (image.service.ts). null = OK. */
export function checkImageFile(file) {
  if (!ACCEPTED_TYPES.includes(file.type)) return `${file.name}: only JPEG, PNG or WebP photos can be uploaded`
  if (file.size > MAX_IMAGE_BYTES) return `${file.name}: larger than 15 MB`
  return null
}
