// Loads the compiled bundle (build/index.js) the way Nakama does, as one
// plain script, with small in-memory fakes for the Nakama APIs it calls.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import vm from "node:vm";

const BUNDLE = new URL("../build/index.js", import.meta.url);

export function load() {
  const sandbox = { console, Uint8Array, ArrayBuffer, JSON, Date, Math };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(BUNDLE, "utf8"), sandbox, { filename: "index.js" });
  return sandbox;
}

export const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

export function fakeNk() {
  const cache = new Map();
  const storage = new Map();
  return {
    uuidv4: () => randomUUID(),
    localcacheGet: (k) => cache.get(k),
    localcachePut: (k, v) => cache.set(k, v),
    binaryToString: (buf) => Buffer.from(buf).toString(),
    storageRead: (keys) =>
      keys.map((k) => storage.get(`${k.collection}/${k.key}/${k.userId}`)).filter(Boolean),
    storageWrite: (objs) =>
      objs.map((o) => {
        const id = `${o.collection}/${o.key}/${o.userId}`;
        const cur = storage.get(id);
        if (o.version === "*" && cur) throw new Error("exists");
        if (o.version && o.version !== "*" && (!cur || cur.version !== o.version)) throw new Error("version");
        const version = randomUUID();
        storage.set(id, { ...o, value: JSON.parse(JSON.stringify(o.value)), version });
        return { collection: o.collection, key: o.key, userId: o.userId, version };
      }),
    storage,
  };
}

export function ctx(vars, extra = {}) {
  return { env: {}, executionMode: "rpc", node: "test", version: "test", userId: "u1", username: "one", vars, ...extra };
}

/** Records relay messages so tests can assert who received what. */
export function fakeDispatcher() {
  const sent = [];
  const kicked = [];
  const labels = [];
  return {
    sent,
    kicked,
    labels,
    broadcastMessage(op, data, presences, sender) {
      sent.push({
        op,
        data: typeof data === "string" ? data : Buffer.from(data).toString(),
        to: presences === null ? null : presences.map((p) => p.sessionId),
        from: sender ? sender.sessionId : null,
      });
    },
    matchKick(presences) {
      kicked.push(...presences.map((p) => p.sessionId));
    },
    matchLabelUpdate(label) {
      labels.push(label);
    },
    take() {
      return sent.splice(0, sent.length);
    },
  };
}

export function presence(n) {
  return { userId: `user-${n}`, sessionId: `session-${n}`, username: `player${n}`, node: "test" };
}

/** A relay game message: [count][targets...][payload] as an ArrayBuffer. */
export function gameMessage(sender, op, targets, payload) {
  const bytes = Buffer.concat([Buffer.from([targets.length, ...targets]), Buffer.from(payload)]);
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
  return { sender, opCode: op, data, reliable: true, persistence: false, status: "", receiveTimeMs: 0 };
}

export function controlMessage(sender, op, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
  return { sender, opCode: op, data, reliable: true, persistence: false, status: "", receiveTimeMs: 0 };
}
