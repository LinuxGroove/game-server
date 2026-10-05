// Per-player rate limits, kept in Nakama's in-process local cache.
//
// Fixed windows are approximate (two runtime VMs can race on the same
// counter), which is fine for keeping a misbehaving client from hammering
// expensive calls. The cache is per node, which matches open-source Nakama
// running as a single node.

namespace RateLimit {
  export function check(nk: nkruntime.Nakama, userId: string, bucket: string, limit: number, windowSec: number): void {
    if (limit <= 0) {
      return;
    }
    const window = Math.floor(Util.nowSeconds() / windowSec);
    const key = "rl:" + bucket + ":" + userId + ":" + window;
    let count = 0;
    const current = nk.localcacheGet(key);
    if (typeof current === "number") {
      count = current;
    }
    if (count >= limit) {
      Util.fail(Code.RESOURCE_EXHAUSTED, "rate_limited: too many " + bucket + " requests, try again later");
    }
    nk.localcachePut(key, count + 1, windowSec + 1);
  }
}
