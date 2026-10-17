// Per-player rate limits, kept in Nakama's in-process local cache.
//
// Fixed windows are approximate (two runtime VMs can race on the same
// counter), which is fine for keeping a misbehaving client from hammering
// expensive calls. The cache is per node, which matches open-source Nakama
// running as a single node.

namespace RateLimit {
  /** Count one call, or return false (counting nothing) when the player is at the limit. */
  export function allow(nk: nkruntime.Nakama, userId: string, bucket: string, limit: number, windowSec: number): boolean {
    if (limit <= 0) {
      return true;
    }
    const window = Math.floor(Util.nowSeconds() / windowSec);
    const key = "rl:" + bucket + ":" + userId + ":" + window;
    let count = 0;
    const current = nk.localcacheGet(key);
    if (typeof current === "number") {
      count = current;
    }
    if (count >= limit) {
      return false;
    }
    nk.localcachePut(key, count + 1, windowSec + 1);
    return true;
  }

  /** Count one call, or refuse it with rate_limited when the player is at the limit. */
  export function check(nk: nkruntime.Nakama, userId: string, bucket: string, limit: number, windowSec: number): void {
    if (!allow(nk, userId, bucket, limit, windowSec)) {
      Util.fail(Code.RESOURCE_EXHAUSTED, "rate_limited: too many " + bucket + " requests, try again later");
    }
  }
}
