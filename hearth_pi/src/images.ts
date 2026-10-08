// Image attachments in Home chats (for example a floor-plan photo). Images
// are owner data: they travel inside the durable user message (Pi Durable's
// UserInput accepts pi-ai ImageContent), are served back only through the
// owner-checked session routes and go to the session's model provider only.
// Image bytes are untrusted input: the type is decided by magic bytes, never
// by the declared name, and the size, count and dimensions are bounded.
import type { ImageContent } from "@earendil-works/pi-ai";
import { Fault, digest, insist, object } from "./safety.js";

export const IMAGE_LIMITS = Object.freeze({
  // Images in one message.
  perMessage: 4,
  // Decoded bytes per image and per message.
  bytes: 4 * 1024 * 1024,
  messageBytes: 10 * 1024 * 1024,
  // Longest side in pixels (the browser downscales to 2048 before sending).
  side: 4096,
  // Images in one conversation's active context: every model request
  // resends them, so a chat with many plans should be a new chat.
  perConversation: 12,
});
export const IMAGE_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
] as const);
export type ImageType = (typeof IMAGE_TYPES)[number];
export type ImageAttachment = { mimeType: ImageType; data: string };
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

// The image type by its first bytes. HEIC/HEIF/AVIF are recognized only to
// refuse them with a clear reason (browsers usually convert on upload).
export function sniffImage(bytes: Buffer): ImageType | "heic" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8)
    return bytes[2] === 0xff ? "image/jpeg" : null;
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (
    bytes.length >= 12 &&
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  )
    return "image/webp";
  if (
    bytes.length >= 12 &&
    bytes.toString("latin1", 4, 8) === "ftyp" &&
    /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif|avis)$/.test(
      bytes.toString("latin1", 8, 12),
    )
  )
    return "heic";
  return null;
}

// Width and height from the image header, or null when unreadable.
export function imageSize(
  bytes: Buffer,
  type: ImageType,
): { width: number; height: number } | null {
  try {
    if (type === "image/png") {
      if (bytes.length < 24 || bytes.toString("latin1", 12, 16) !== "IHDR")
        return null;
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (type === "image/webp") {
      const chunk = bytes.toString("latin1", 12, 16);
      if (chunk === "VP8 " && bytes.length >= 30)
        return {
          width: bytes.readUInt16LE(26) & 0x3fff,
          height: bytes.readUInt16LE(28) & 0x3fff,
        };
      if (chunk === "VP8L" && bytes.length >= 25) {
        const bits = bytes.readUInt32LE(21);
        return {
          width: (bits & 0x3fff) + 1,
          height: ((bits >> 14) & 0x3fff) + 1,
        };
      }
      if (chunk === "VP8X" && bytes.length >= 30)
        return {
          width: bytes.readUIntLE(24, 3) + 1,
          height: bytes.readUIntLE(27, 3) + 1,
        };
      return null;
    }
    // JPEG: walk the marker segments to the first start-of-frame.
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const length = bytes.readUInt16BE(i + 2);
      if (length < 2) return null;
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      )
        return {
          height: bytes.readUInt16BE(i + 5),
          width: bytes.readUInt16BE(i + 7),
        };
      i += 2 + length;
    }
    return null;
  } catch {
    return null;
  }
}

// Strict: an array of {mimeType, data} with canonical base64. Every image is
// re-identified by its bytes; a declared type that disagrees is refused.
export function parseImages(value: unknown): ImageAttachment[] {
  if (value === undefined) return [];
  insist(Array.isArray(value), "invalid_images");
  insist(value.length <= IMAGE_LIMITS.perMessage, "image_count", 413);
  let total = 0;
  const maxEncoded = Math.ceil(IMAGE_LIMITS.bytes / 3) * 4;
  return value.map((raw) => {
    const v = object(raw, ["mimeType", "data"]);
    insist(typeof v.data === "string", "invalid_image");
    insist(v.data.length <= maxEncoded, "image_too_large", 413);
    insist(
      v.data.length > 0 && v.data.length % 4 === 0 && BASE64.test(v.data),
      "invalid_image",
    );
    const bytes = Buffer.from(v.data, "base64");
    insist(bytes.length <= IMAGE_LIMITS.bytes, "image_too_large", 413);
    total += bytes.length;
    insist(total <= IMAGE_LIMITS.messageBytes, "image_too_large", 413);
    const type = sniffImage(bytes);
    insist(type !== "heic", "image_heic_unsupported", 415);
    insist(type, "image_type_unsupported", 415);
    insist(v.mimeType === type, "image_type_mismatch", 415);
    const size = imageSize(bytes, type);
    insist(size && size.width > 0 && size.height > 0, "invalid_image");
    insist(
      size.width <= IMAGE_LIMITS.side && size.height <= IMAGE_LIMITS.side,
      "image_dimensions",
      413,
    );
    return { mimeType: type, data: bytes.toString("base64") };
  });
}

// Idempotency hash of a message with images: text plus each image's digest.
// Text-only messages keep the earlier plain digest(text).
export function inputHash(text: string, images: readonly ImageAttachment[]) {
  return images.length
    ? digest({
        text,
        images: images.map((i) => [i.mimeType, digest(i.data)]),
      })
    : digest(text);
}

export function userContent(
  text: string,
  images: readonly ImageAttachment[] | undefined,
): string | (ImageContent | { type: "text"; text: string })[] {
  if (!images?.length) return text;
  return [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...images.map((i) => ({
      type: "image" as const,
      data: i.data,
      mimeType: i.mimeType,
    })),
  ];
}

const isImageBlock = (
  value: unknown,
): value is { type: "image"; data: string; mimeType: string } =>
  !!value &&
  typeof value === "object" &&
  (value as { type?: unknown }).type === "image" &&
  typeof (value as { data?: unknown }).data === "string";

// Images in the user messages of active transcript entries.
export function countImages(
  entries: readonly { model?: readonly unknown[] }[],
): number {
  let count = 0;
  for (const entry of entries)
    for (const message of entry.model ?? []) {
      const content = (message as { role?: unknown; content?: unknown })
        .content;
      if (
        (message as { role?: unknown }).role === "user" &&
        Array.isArray(content)
      )
        count += content.filter(isImageBlock).length;
    }
  return count;
}
// JSON size of entries with image data counted as a fixed 1 KB each, so the
// text transcript limit is not consumed by attachments (they have their own).
export function transcriptBytes(entries: readonly unknown[]): number {
  return Buffer.byteLength(
    JSON.stringify(entries, (_key, value: unknown) =>
      isImageBlock(value)
        ? { type: "image", mimeType: value.mimeType, size: "x".repeat(1024) }
        : value,
    ),
  );
}

// Browser view of a conversation: image bytes are replaced by a reference
// to the owner-checked image route (entry id and position in that entry's
// user message). Queued inputs and anything else keep only the type.
export function withoutImageData<T>(view: T): T {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== "object") return value;
    if (isImageBlock(value)) return { type: "image", mimeType: value.mimeType };
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, strip(v)]),
    );
  };
  const v = view as {
    entries?: readonly { id: number; model?: readonly unknown[] }[];
  };
  const entries = (v.entries ?? []).map((entry) => {
    let index = 0;
    return {
      ...entry,
      model: entry.model?.map((message) => {
        const m = message as { role?: unknown; content?: unknown };
        if (m.role !== "user" || !Array.isArray(m.content))
          return strip(message);
        return {
          ...m,
          content: m.content.map((block) =>
            isImageBlock(block)
              ? {
                  type: "image",
                  mimeType: block.mimeType,
                  image: `${entry.id}/${index++}`,
                }
              : strip(block),
          ),
        };
      }),
    };
  });
  return { ...(strip(view) as T & object), entries } as T;
}

// One image of a user message in the active transcript, as bytes.
export function findImage(
  entries: readonly { id: number; model?: readonly unknown[] }[],
  entryId: number,
  index: number,
): { bytes: Buffer; mimeType: ImageType } {
  const entry = entries.find((e) => e.id === entryId);
  const images = (entry?.model ?? []).flatMap((message) => {
    const m = message as { role?: unknown; content?: unknown };
    return m.role === "user" && Array.isArray(m.content)
      ? m.content.filter(isImageBlock)
      : [];
  });
  const image = images[index];
  if (!image) throw new Fault(404, "image_not_found");
  const bytes = Buffer.from(image.data, "base64");
  const type = sniffImage(bytes);
  // Only types admitted by parseImages are ever served.
  insist(
    type && type !== "heic" && type === image.mimeType,
    "image_not_found",
    404,
  );
  return { bytes, mimeType: type };
}
