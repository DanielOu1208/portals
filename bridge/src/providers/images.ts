// Images the phone attaches, as agents take them.

export type ImageType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** The image's type from its first bytes: the file name from the phone is only a name. Null for one agents cannot read (HEIC). */
export function imageType(data: Buffer): ImageType | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 6 && data.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (data.length >= 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** The notice for images left out of a message. */
export function skippedImagesText(skipped: number, agent: string): string {
  return `${skipped === 1 ? "An image was" : `${skipped} images were`} left out: ${agent} reads JPEG, PNG, GIF and WebP images.`;
}
