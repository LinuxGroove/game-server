// Shared helpers for every server module.
//
// Nakama loads this bundle as one plain script (no ES modules), so helpers
// live in namespaces and only functions registered in InitModule are global.

/** gRPC status codes, which Nakama maps to HTTP statuses for REST clients. */
const enum Code {
  INVALID_ARGUMENT = 3,
  NOT_FOUND = 5,
  ALREADY_EXISTS = 6,
  PERMISSION_DENIED = 7,
  RESOURCE_EXHAUSTED = 8,
  FAILED_PRECONDITION = 9,
  INTERNAL = 13,
  UNAVAILABLE = 14,
  UNAUTHENTICATED = 16,
}

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

namespace Util {
  /** An error Nakama returns to the client with this code and message. */
  export interface RuntimeError {
    message: string;
    code: number;
  }

  /** Throw an error the client sees as `code` with a stable `message`. */
  export function fail(code: Code, message: string): never {
    const err: RuntimeError = { message: message, code: code };
    throw err;
  }

  /** Parse an RPC payload. An empty payload is an empty object. */
  export function parsePayload(payload: string): { [key: string]: any } {
    if (!payload) {
      return {};
    }
    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch (e) {
      return fail(Code.INVALID_ARGUMENT, "payload must be a JSON object");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fail(Code.INVALID_ARGUMENT, "payload must be a JSON object");
    }
    return parsed;
  }

  export function requireUser(ctx: nkruntime.Context): string {
    if (!ctx.userId) {
      return fail(Code.UNAUTHENTICATED, "a player session is required");
    }
    return ctx.userId;
  }

  export function str(obj: { [key: string]: any }, field: string, maxLen: number, required: boolean): string {
    const v = obj[field];
    if (v === undefined || v === null || v === "") {
      if (required) {
        return fail(Code.INVALID_ARGUMENT, field + " is required");
      }
      return "";
    }
    if (typeof v !== "string") {
      return fail(Code.INVALID_ARGUMENT, field + " must be a string");
    }
    if (v.length > maxLen) {
      return fail(Code.INVALID_ARGUMENT, field + " is too long");
    }
    return v;
  }

  export function int(obj: { [key: string]: any }, field: string, min: number, max: number, fallback?: number): number {
    const v = obj[field];
    if (v === undefined || v === null) {
      if (fallback === undefined) {
        return fail(Code.INVALID_ARGUMENT, field + " is required");
      }
      return fallback;
    }
    if (typeof v !== "number" || Math.floor(v) !== v) {
      return fail(Code.INVALID_ARGUMENT, field + " must be an integer");
    }
    if (v < min || v > max) {
      return fail(Code.INVALID_ARGUMENT, field + " must be between " + min + " and " + max);
    }
    return v;
  }

  export function bool(obj: { [key: string]: any }, field: string, fallback: boolean): boolean {
    const v = obj[field];
    if (v === undefined || v === null) {
      return fallback;
    }
    if (typeof v !== "boolean") {
      return fail(Code.INVALID_ARGUMENT, field + " must be true or false");
    }
    return v;
  }

  /** Lower-case slug: letters, digits, '-' and '_', starting with a letter. */
  export function isSlug(s: string, maxLen: number): boolean {
    return s.length > 0 && s.length <= maxLen && /^[a-z][a-z0-9_-]*$/.test(s);
  }

  /**
   * Compare two dotted numeric versions ("1.2.10" vs "1.10.0").
   * Anything after '-' or '+' is ignored. Returns -1, 0 or 1.
   */
  export function compareVersions(a: string, b: string): number {
    const pa = a.split(/[-+]/)[0].split(".");
    const pb = b.split(/[-+]/)[0].split(".");
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const x = parseInt(pa[i] || "0", 10) || 0;
      const y = parseInt(pb[i] || "0", 10) || 0;
      if (x !== y) {
        return x < y ? -1 : 1;
      }
    }
    return 0;
  }

  export function isVersion(s: string): boolean {
    return /^\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/.test(s) && s.length <= 32;
  }

  // No 0/O, 1/I/L or U, so codes survive being read aloud across a room.
  const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

  /** A short human-friendly code, uppercase, from a random UUID. */
  export function randomCode(nk: nkruntime.Nakama, length: number): string {
    let out = "";
    while (out.length < length) {
      const hex = nk.uuidv4().replace(/-/g, "");
      for (let i = 0; i + 2 <= hex.length && out.length < length; i += 2) {
        const byte = parseInt(hex.substr(i, 2), 16);
        // 240 is the largest multiple of 30 below 256, so this stays unbiased.
        if (byte < 240) {
          out += CODE_ALPHABET.charAt(byte % CODE_ALPHABET.length);
        }
      }
    }
    return out;
  }

  /** Normalise a code someone typed: uppercase, no spaces or dashes. */
  export function normaliseCode(code: string): string {
    return code.toUpperCase().replace(/[\s-]/g, "");
  }

  export function isCode(code: string, length: number): boolean {
    if (code.length !== length) {
      return false;
    }
    for (let i = 0; i < code.length; i++) {
      if (CODE_ALPHABET.indexOf(code.charAt(i)) < 0) {
        return false;
      }
    }
    return true;
  }

  export function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  /** UTF-8 byte length of a string, for size limits. */
  export function byteLength(s: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) {
        n += 1;
      } else if (c < 0x800) {
        n += 2;
      } else if (c >= 0xd800 && c <= 0xdbff) {
        n += 4;
        i++;
      } else {
        n += 3;
      }
    }
    return n;
  }

  /** Read an optional runtime environment value (runtime.env in the config). */
  export function env(ctx: nkruntime.Context, key: string, fallback: string): string {
    const v = ctx.env ? ctx.env[key] : undefined;
    return v === undefined || v === "" ? fallback : v;
  }
}

namespace Objects {
  /**
   * Read-modify-write one storage object with optimistic concurrency.
   * `update` gets the current value (or null) and returns the new value.
   */
  export function update(
    nk: nkruntime.Nakama,
    collection: string,
    key: string,
    userId: string,
    permissionRead: nkruntime.ReadPermissionValues,
    update: (current: { [key: string]: any } | null) => { [key: string]: any },
  ): { [key: string]: any } {
    for (let attempt = 0; attempt < 5; attempt++) {
      const found = nk.storageRead([{ collection: collection, key: key, userId: userId }]);
      const current = found.length > 0 ? found[0] : null;
      const value = update(current ? current.value : null);
      try {
        nk.storageWrite([
          {
            collection: collection,
            key: key,
            userId: userId,
            value: value,
            version: current ? current.version : "*",
            permissionRead: permissionRead,
            permissionWrite: 0,
          },
        ]);
        return value;
      } catch (e) {
        // Someone else wrote in between; read again and retry.
      }
    }
    return Util.fail(Code.UNAVAILABLE, "busy: the server is busy, try again");
  }
}
