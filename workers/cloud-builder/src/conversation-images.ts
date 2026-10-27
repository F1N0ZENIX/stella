/**
 * Images a cloud conversation keeps in R2 instead of in its Durable Object.
 *
 * A model bills an image by its pixels (~1k tokens), but an inline block
 * carries its base64, ~2 MB for a fitted photo. Held in pi entries, every
 * request reloaded, decoded and serialized every image in context, which ran
 * the object out of its 128 MB. Each image is instead fitted once, written to
 * the drive bucket under the conversation's own prefix, and stored in the
 * entry as a reference (`image-ref.ts`). A request then carries a signed URL
 * the provider fetches itself: the object never holds the bytes again.
 *
 * Where a provider takes no URLs the model gateway inlines them (it is a
 * stateless Worker, and the fallback is per request); here the bytes come
 * back only for paths that cannot carry a URL at all (Claude Code's tool
 * results, agent logs other computers read).
 *
 * Keys: `conversation-images/<sha256(owner)>/<conversation>/<sha256(bytes)>.<ext>`.
 * Content-addressed, so the same screenshot read twice is one object. Only
 * keys under this owner's prefix are ever signed or read back, so a reference
 * forged into an imported entry can't reach another owner's images. A
 * conversation purge sweeps its prefix; an owner purge sweeps the owner's.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Buffer } from "node:buffer";
import { Effect } from "effect";
import {
  base64EncodedLength,
  DURABLE_OBJECT_READ_IMAGE_CAPS,
} from "@stella/runtime/kernel/shared/image-caps.js";
import {
  sanitizeInlineImagePayload,
  UNPROCESSABLE_IMAGE_NOTE,
} from "@stella/runtime/kernel/shared/image-payload.js";
import {
  IMAGE_REF_PREFIX,
  imageRef,
  imageRefKey,
  isImageRef,
} from "@stella/runtime/kernel/shared/image-ref.js";
import { fitImageWithImagesBinding } from "./cloud-image-fit.js";
import { sha256BytesHex, sha256Hex } from "./hash.js";
import { presignR2Url, r2Signer, type R2Signer } from "./r2-presign.js";
import { sweepR2Prefix } from "./build-session/shared/keys.js";

export const CONVERSATION_IMAGES_ROOT = "conversation-images/";

/**
 * A signed URL is stable for this window, so the same image keeps the same URL
 * across a conversation's requests and the providers' prompt caches still
 * match; it then stays valid for `URL_LIFETIME_SECONDS` from the window's
 * start, so a URL handed out at the window's end still outlives a long
 * request and its retries by hours.
 */
const URL_WINDOW_MS = 6 * 60 * 60_000;
const URL_LIFETIME_SECONDS = 12 * 60 * 60;

const R2_TIMEOUT_MS = 30_000;

export const MISSING_IMAGE_NOTE =
  "[Image unavailable: it is no longer in storage.]";

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export type ConversationImageScope = { ownerId: string; conversationId: string };

export type ConversationImagesEnv = Pick<
  Cloudflare.Env,
  "DRIVE" | "R2_DRIVE_BUCKET" | "R2_ACCESS_KEY_ID" | "R2_SECRET_ACCESS_KEY" | "R2_S3_ENDPOINT"
> & { IMAGES?: Cloudflare.Env["IMAGES"] };

export const ownerConversationImagesPrefix = async (ownerId: string): Promise<string> =>
  `${CONVERSATION_IMAGES_ROOT}${await sha256Hex(ownerId)}/`;

export const conversationImagesPrefix = async (scope: ConversationImageScope): Promise<string> =>
  `${await ownerConversationImagesPrefix(scope.ownerId)}${scope.conversationId}/`;

const withTimeout = <T>(work: Promise<T>, label: string): Promise<T> =>
  Effect.runPromise(
    Effect.tryPromise(() => work).pipe(
      Effect.timeout(R2_TIMEOUT_MS),
      Effect.mapError((error) =>
        error._tag === "TimeoutError"
          ? new Error(`${label} timed out.`)
          : error,
      ),
    ),
  );

type Block = { type: string };
const refOf = (part: Block): string | undefined => {
  const data = (part as { data?: unknown }).data;
  return part.type === "image" && isImageRef(data) ? data : undefined;
};
const isInlineImage = (part: Block): boolean => {
  const { data, mimeType } = part as { data?: unknown; mimeType?: unknown };
  return part.type === "image" && typeof data === "string" && typeof mimeType === "string" && !isImageRef(data);
};

export class ConversationImages {
  readonly #env: ConversationImagesEnv;
  readonly #scope: () => ConversationImageScope | null;
  readonly #log: (event: string, fields: Record<string, unknown>) => void;
  #signer: R2Signer | null | undefined;
  #prefixes?: { scope: string; owner: string; conversation: string };

  constructor(options: {
    env: ConversationImagesEnv;
    scope: () => ConversationImageScope | null;
    log: (event: string, fields: Record<string, unknown>) => void;
  }) {
    this.#env = options.env;
    this.#scope = options.scope;
    this.#log = options.log;
  }

  /** Whether images can be stored here at all; without it they stay inline, as before. */
  get available(): boolean {
    return Boolean(this.#env.DRIVE && this.#scope());
  }

  async #prefix(): Promise<{ owner: string; conversation: string } | null> {
    const scope = this.#scope();
    if (!scope) return null;
    const id = `${scope.ownerId}\0${scope.conversationId}`;
    if (this.#prefixes?.scope !== id) {
      const owner = await ownerConversationImagesPrefix(scope.ownerId);
      this.#prefixes = { scope: id, owner, conversation: `${owner}${scope.conversationId}/` };
    }
    return this.#prefixes;
  }

  #signerOf(): R2Signer | null {
    if (this.#signer === undefined) this.#signer = r2Signer(this.#env, this.#env.R2_DRIVE_BUCKET);
    return this.#signer;
  }

  /** A key this owner may read, or null for a reference that isn't its own. */
  async #ownedKey(data: string): Promise<string | null> {
    const prefix = await this.#prefix();
    const key = imageRefKey(data);
    if (!prefix || !key.startsWith(prefix.owner) || key.includes("..")) return null;
    return key;
  }

  /**
   * An inline image as a stored reference: checked, fitted to the model's
   * limits, written once. A reference passes through; an image that can't be
   * decoded becomes the note the request path would have sent anyway. When
   * storage is unavailable or the write fails, the image stays inline.
   */
  async store(block: ImageContent): Promise<ImageContent | TextContent> {
    if (isImageRef(block.data)) return block;
    const bucket = this.#env.DRIVE;
    const prefix = await this.#prefix();
    if (!bucket || !prefix) return block;
    const sanitized = sanitizeInlineImagePayload(block.data, block.mimeType);
    if (!sanitized) return { type: "text", text: UNPROCESSABLE_IMAGE_NOTE };
    let bytes: Uint8Array = Buffer.from(sanitized.data, "base64");
    let mimeType: string = sanitized.mediaType;
    const caps = DURABLE_OBJECT_READ_IMAGE_CAPS;
    if (this.#env.IMAGES) {
      const fitted = await fitImageWithImagesBinding(this.#env.IMAGES, bytes, mimeType, caps).catch(() => null);
      if (fitted) {
        bytes = fitted.bytes;
        mimeType = fitted.mimeType;
      } else if (base64EncodedLength(bytes.byteLength) > caps.maxBytes) {
        return { type: "text", text: UNPROCESSABLE_IMAGE_NOTE };
      }
    }
    return await this.storeFitted(bytes, mimeType);
  }

  /**
   * Bytes already fitted to the model's limits, stored as a reference; inline
   * when storage is unavailable or the write fails.
   */
  async storeFitted(bytes: Uint8Array, mimeType: string): Promise<ImageContent> {
    const bucket = this.#env.DRIVE;
    const prefix = await this.#prefix();
    if (!bucket || !prefix) return { type: "image", mimeType, data: Buffer.from(bytes).toString("base64") };
    const key = `${prefix.conversation}${await sha256BytesHex(bytes)}.${EXTENSIONS[mimeType] ?? "bin"}`;
    try {
      if (!(await withTimeout(bucket.head(key), "Image lookup"))) {
        await withTimeout(bucket.put(key, bytes, { httpMetadata: { contentType: mimeType } }), "Image write");
      }
    } catch (error) {
      this.#log("conversation_image_store_failed", {
        bytes: bytes.byteLength,
        message: error instanceof Error ? error.message : String(error),
      });
      return { type: "image", mimeType, data: Buffer.from(bytes).toString("base64") };
    }
    return { type: "image", mimeType, data: imageRef(key) };
  }

  /** `content` with every inline image stored; the same array when there was none. */
  async storeContent<T extends Block>(content: readonly T[]): Promise<readonly T[]> {
    if (!this.available || !content.some((part) => part.type === "image" && refOf(part) === undefined)) {
      return content;
    }
    const out: T[] = [];
    for (const part of content) {
      out.push(
        isInlineImage(part)
          ? ((await this.store(part as unknown as ImageContent)) as unknown as T)
          : part,
      );
    }
    return out;
  }

  /**
   * An image prepared elsewhere under this owner (an attachment's model-ready
   * copy) copied into this conversation, so the conversation keeps it
   * after the original goes and its purge takes it. `name` names the copy, so
   * attaching the same file again reuses it. Null when it can't be copied.
   */
  async adopt(sourceKey: string, name: string): Promise<ImageContent | "missing" | null> {
    const bucket = this.#env.DRIVE;
    const prefix = await this.#prefix();
    if (!bucket || !prefix || !sourceKey.startsWith(prefix.owner)) return null;
    try {
      // Streamed bucket to bucket through the binding: no S3 round trip, and
      // the bytes never sit whole in the isolate. The read is also the check
      // that the source is there.
      const object = await withTimeout(bucket.get(sourceKey), "Image read");
      if (!object) return "missing";
      const mimeType = object.httpMetadata?.contentType ?? "";
      const extension = EXTENSIONS[mimeType];
      if (!extension) {
        await object.body.cancel();
        return null;
      }
      const key = `${prefix.conversation}${name}.${extension}`;
      await withTimeout(bucket.put(key, object.body, { httpMetadata: { contentType: mimeType } }), "Image write");
      return { type: "image", mimeType, data: imageRef(key) };
    } catch (error) {
      this.#log("conversation_image_adopt_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Deletes every image this conversation stored; `done` is false while more remain. */
  async purge(): Promise<{ deleted: number; done: boolean }> {
    const bucket = this.#env.DRIVE;
    const prefix = await this.#prefix();
    if (!bucket || !prefix) return { deleted: 0, done: true };
    return await sweepR2Prefix(bucket, prefix.conversation);
  }

  /** A provider-fetchable GET URL for a reference, stable within a window; null when it can't be signed. */
  async signedUrl(data: string, now = Date.now()): Promise<string | null> {
    const key = await this.#ownedKey(data);
    const signer = this.#signerOf();
    if (!key || !signer) return null;
    return await presignR2Url(signer, {
      method: "GET",
      key,
      expiresInSeconds: URL_LIFETIME_SECONDS,
      now: Math.floor(now / URL_WINDOW_MS) * URL_WINDOW_MS,
    });
  }

  /** The base64 of a reference, read back; null when it isn't this owner's or is gone. */
  async bytesBase64(data: string): Promise<string | null> {
    const key = await this.#ownedKey(data);
    const bucket = this.#env.DRIVE;
    if (!key || !bucket) return null;
    const object = await withTimeout(bucket.get(key), "Image read").catch(() => null);
    if (!object) return null;
    return Buffer.from(await object.arrayBuffer()).toString("base64");
  }

  /** A reference back inline, for a path that can only carry bytes; a note when it can't be read. */
  async inline(block: ImageContent): Promise<ImageContent | TextContent> {
    if (!isImageRef(block.data)) return block;
    const data = await this.bytesBase64(block.data);
    return data === null ? { type: "text", text: MISSING_IMAGE_NOTE } : { ...block, data };
  }

  async inlineContent<T extends Block>(content: readonly T[]): Promise<readonly T[]> {
    if (!content.some((part) => refOf(part) !== undefined)) return content;
    const out: T[] = [];
    for (const part of content) {
      out.push(
        refOf(part) !== undefined
          ? ((await this.inline(part as unknown as ImageContent)) as unknown as T)
          : part,
      );
    }
    return out;
  }

  /**
   * A model request with every stored image as a signed URL, in the shape of
   * the request's own protocol: an OpenAI data URL (Chat Completions'
   * `image_url.url`, Responses' `image_url`) becomes the URL, and an Anthropic
   * base64 source becomes a URL source. An image that can't be signed goes
   * inline. Bodies without a reference pass untouched.
   */
  async rewriteRequest(request: Request): Promise<Request> {
    if (request.method !== "POST" || !request.body) return request;
    const type = request.headers.get("content-type") ?? "";
    if (type && !type.includes("json")) return request;
    const text = await request.text();
    const rebuilt = (body: string) => {
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      return new Request(request.url, { method: request.method, headers, body, signal: request.signal });
    };
    if (!text.includes(IMAGE_REF_PREFIX)) return rebuilt(text);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return rebuilt(text);
    }
    const now = Date.now();
    let urls = 0;
    let inlined = 0;
    let missing = 0;
    const resolve = async (data: string): Promise<{ url: string } | { base64: string } | null> => {
      const url = await this.signedUrl(data, now);
      if (url) {
        urls += 1;
        return { url };
      }
      const base64 = await this.bytesBase64(data);
      if (base64 !== null) {
        inlined += 1;
        return { base64 };
      }
      missing += 1;
      return null;
    };
    const DATA_URL_REF = /^data:([^;,]+);base64,(stella-r2-image:.+)$/su;
    const walk = async (value: unknown): Promise<unknown> => {
      if (typeof value === "string") {
        if (isImageRef(value)) {
          // A bare base64 field (a protocol without URL sources): the bytes.
          inlined += 1;
          return (await this.bytesBase64(value)) ?? BLANK_GIF;
        }
        const match = DATA_URL_REF.exec(value);
        if (!match) return value;
        const resolved = await resolve(match[2]!);
        // An unreadable image in a URL slot can't be dropped from here; a
        // 1x1 transparent GIF keeps the request well-formed.
        if (!resolved) return `data:image/gif;base64,${BLANK_GIF}`;
        return "url" in resolved ? resolved.url : `data:${match[1]};base64,${resolved.base64}`;
      }
      if (Array.isArray(value)) {
        const out: unknown[] = [];
        for (const item of value) out.push(await walk(item));
        return out;
      }
      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (record.type === "base64" && isImageRef(record.data)) {
          const resolved = await resolve(record.data);
          if (!resolved) return { type: "base64", media_type: "image/gif", data: BLANK_GIF };
          return "url" in resolved
            ? { type: "url", url: resolved.url }
            : { ...record, data: resolved.base64 };
        }
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(record)) out[key] = await walk(item);
        return out;
      }
      return value;
    };
    const body = JSON.stringify(await walk(json));
    if (inlined > 0 || missing > 0) {
      this.#log("conversation_image_request_fallback", { urls, inlined, missing });
    }
    return rebuilt(body);
  }
}

const BLANK_GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
