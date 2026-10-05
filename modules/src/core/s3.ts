// Pre-signed URLs for S3-compatible object storage (AWS Signature V4).
//
// Ghosts, replays and other large blobs never pass through Nakama: the
// server signs a short-lived URL and the client talks to object storage
// directly. Works with Cloudflare R2, Backblaze B2, MinIO, Garage, SeaweedFS
// and AWS S3.
//
// Runtime env (runtime.env in the Nakama config, or snap config blobs.*):
//   S3_ENDPOINT           https://<account>.r2.cloudflarestorage.com
//   S3_REGION             region name, "auto" for R2 (default us-east-1)
//   S3_BUCKET             bucket name
//   S3_ACCESS_KEY_ID      access key
//   S3_SECRET_ACCESS_KEY  secret key
//   S3_PUBLIC_URL         optional public/CDN base URL for downloads
//   S3_VIRTUAL_HOST       "true" for bucket.host style URLs (default path style)
//   S3_INTERNAL_ENDPOINT  optional endpoint the server itself uses (deletes)

namespace S3 {
  export interface Config {
    scheme: string;
    host: string;
    internalScheme: string;
    internalHost: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    publicUrl: string;
    virtualHost: boolean;
  }

  function parseEndpoint(url: string): { scheme: string; host: string } | null {
    const m = /^(https?):\/\/([^\/?#]+)\/?$/.exec(url);
    return m ? { scheme: m[1], host: m[2].toLowerCase() } : null;
  }

  /** The configured object storage, or null when blobs are turned off. */
  export function config(ctx: nkruntime.Context): Config | null {
    const endpoint = parseEndpoint(Util.env(ctx, "S3_ENDPOINT", ""));
    const bucket = Util.env(ctx, "S3_BUCKET", "");
    const accessKeyId = Util.env(ctx, "S3_ACCESS_KEY_ID", "");
    const secretAccessKey = Util.env(ctx, "S3_SECRET_ACCESS_KEY", "");
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      return null;
    }
    const internal = parseEndpoint(Util.env(ctx, "S3_INTERNAL_ENDPOINT", "")) || endpoint;
    return {
      scheme: endpoint.scheme,
      host: endpoint.host,
      internalScheme: internal.scheme,
      internalHost: internal.host,
      region: Util.env(ctx, "S3_REGION", "us-east-1"),
      bucket: bucket,
      accessKeyId: accessKeyId,
      secretAccessKey: secretAccessKey,
      publicUrl: Util.env(ctx, "S3_PUBLIC_URL", "").replace(/\/+$/, ""),
      virtualHost: Util.env(ctx, "S3_VIRTUAL_HOST", "") === "true",
    };
  }

  /** RFC 3986 encoding as SigV4 wants it. Slashes are kept in paths. */
  export function uriEncode(s: string, keepSlash: boolean): string {
    let out = encodeURIComponent(s).replace(/[!'()*]/g, function (c) {
      return "%" + c.charCodeAt(0).toString(16).toUpperCase();
    });
    if (keepSlash) {
      out = out.replace(/%2F/g, "/");
    }
    return out;
  }

  export function amzDate(now: Date): string {
    return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  }

  /**
   * Build a pre-signed URL. Every header in `headers` is signed, so the
   * client must send exactly those values (this is how upload size and
   * content type are enforced).
   */
  export function presign(
    cfg: Config,
    method: string,
    key: string,
    expiresSec: number,
    headers: { [name: string]: string },
    now: Date,
    internal: boolean,
  ): string {
    const scheme = internal ? cfg.internalScheme : cfg.scheme;
    const endpointHost = internal ? cfg.internalHost : cfg.host;
    const host = cfg.virtualHost ? cfg.bucket + "." + endpointHost : endpointHost;
    const path = cfg.virtualHost ? "/" + uriEncode(key, true) : "/" + uriEncode(cfg.bucket, false) + "/" + uriEncode(key, true);

    const stamp = amzDate(now);
    const date = stamp.substr(0, 8);
    const scope = date + "/" + cfg.region + "/s3/aws4_request";

    const signed: { [name: string]: string } = { host: host };
    for (const name in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, name)) {
        signed[name.toLowerCase()] = String(headers[name]).replace(/\s+/g, " ").trim();
      }
    }
    const headerNames = Object.keys(signed).sort();
    const signedHeaders = headerNames.join(";");
    let canonicalHeaders = "";
    for (let i = 0; i < headerNames.length; i++) {
      canonicalHeaders += headerNames[i] + ":" + signed[headerNames[i]] + "\n";
    }

    const query: { [name: string]: string } = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": cfg.accessKeyId + "/" + scope,
      "X-Amz-Date": stamp,
      "X-Amz-Expires": String(expiresSec),
      "X-Amz-SignedHeaders": signedHeaders,
    };
    const queryNames = Object.keys(query).sort();
    const parts: string[] = [];
    for (let i = 0; i < queryNames.length; i++) {
      parts.push(uriEncode(queryNames[i], false) + "=" + uriEncode(query[queryNames[i]], false));
    }
    const canonicalQuery = parts.join("&");

    const canonicalRequest = [
      method.toUpperCase(),
      path,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, Sha256.hexOf(canonicalRequest)].join("\n");

    let k = Sha256.hmac(Sha256.utf8("AWS4" + cfg.secretAccessKey), Sha256.utf8(date));
    k = Sha256.hmac(k, Sha256.utf8(cfg.region));
    k = Sha256.hmac(k, Sha256.utf8("s3"));
    k = Sha256.hmac(k, Sha256.utf8("aws4_request"));
    const signature = Sha256.hex(Sha256.hmac(k, Sha256.utf8(stringToSign)));

    return scheme + "://" + host + path + "?" + canonicalQuery + "&X-Amz-Signature=" + signature;
  }

  /** Delete an object from the server side. Returns true when it is gone. */
  export function deleteObject(nk: nkruntime.Nakama, cfg: Config, key: string): boolean {
    const url = presign(cfg, "DELETE", key, 300, {}, new Date(), true);
    const res = nk.httpRequest(url, "delete", {}, "", 10000);
    return (res.code >= 200 && res.code < 300) || res.code === 404;
  }
}
