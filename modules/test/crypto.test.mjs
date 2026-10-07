import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { load } from "./harness.mjs";

const g = load();

test("sha256 matches node:crypto, including multi-block and unicode input", () => {
  const inputs = ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(1000), "héllo wörld 🎮 ランプ"];
  for (let i = 0; i < 20; i++) inputs.push(randomBytes(i * 7).toString("base64"));
  for (const s of inputs) {
    assert.equal(g.Sha256.hexOf(s), createHash("sha256").update(s, "utf8").digest("hex"), JSON.stringify(s));
  }
});

test("hmac-sha256 matches node:crypto, including keys longer than a block", () => {
  for (const key of ["k", "AWS4secret", "z".repeat(64), "y".repeat(100)]) {
    const mac = g.Sha256.hmac(g.Sha256.utf8(key), g.Sha256.utf8("message to sign"));
    assert.equal(g.Sha256.hex(mac), createHmac("sha256", key).update("message to sign").digest("hex"));
  }
});

test("presigned GET matches the AWS Signature V4 documentation example", () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
  const cfg = {
    scheme: "https",
    host: "s3.amazonaws.com",
    internalScheme: "https",
    internalHost: "s3.amazonaws.com",
    region: "us-east-1",
    bucket: "examplebucket",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    publicUrl: "",
    virtualHost: true,
  };
  const url = g.S3.presign(cfg, "GET", "test.txt", 86400, {}, new Date("2013-05-24T00:00:00Z"), false);
  assert.equal(
    url,
    "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
      "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
      "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
  );
});

test("presigned PUT signs size and content type, path style by default", () => {
  const cfg = g.S3.config({
    env: {
      S3_ENDPOINT: "http://127.0.0.1:9000",
      S3_BUCKET: "games",
      S3_ACCESS_KEY_ID: "id",
      S3_SECRET_ACCESS_KEY: "secret",
    },
  });
  const url = g.S3.presign(cfg, "PUT", "sandbox/ghost/u/b", 600, { "Content-Length": "12", "Content-Type": "application/octet-stream" }, new Date(), false);
  assert.match(url, /^http:\/\/127\.0\.0\.1:9000\/games\/sandbox\/ghost\/u\/b\?/);
  assert.match(url, /X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost/);
});

test("object storage is off unless fully configured", () => {
  assert.equal(g.S3.config({ env: {} }), null);
  assert.equal(g.S3.config({ env: { S3_ENDPOINT: "https://x.example", S3_BUCKET: "b" } }), null);
  assert.equal(g.S3.config({ env: { S3_ENDPOINT: "not a url", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "a", S3_SECRET_ACCESS_KEY: "s" } }), null);
});
