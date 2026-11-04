import { imageType } from "../images.ts";
import type { Prompt } from "../types.ts";

/** The bytes decide the MIME type, never the phone's file name. No prompt is sent if any image is unsupported. */
export function imageFiles(prompt: Prompt): { uri: string; name: string }[] {
  return prompt.images.map((image) => {
    const type = imageType(image.data);
    if (!type) throw new Error(`OpenCode cannot read "${image.filename}". Convert it to JPEG, PNG, GIF or WebP, then attach it again.`);
    return { uri: `data:${type};base64,${image.data.toString("base64")}`, name: image.filename };
  });
}
