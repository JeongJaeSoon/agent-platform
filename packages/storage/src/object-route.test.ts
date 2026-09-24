import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
  createObjectRouteSigner,
  type ObjectRouteGrant,
  type ObjectRouteRequest,
} from "./object-route.ts";

const SCOPE = "sessions/s1/";
const ACCESS_KEY = "AKIDEXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const AT = new Date("2026-09-24T01:02:03.000Z");

const signer = createObjectRouteSigner({
  bucket: "claude-sessions",
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET },
  endpoint: "http://localstack:4566",
  region: "ap-northeast-1",
  now: () => AT,
});

function request(
  method: string,
  target: string,
  headers: Array<[string, string]> = [],
): ObjectRouteRequest {
  return { method, target, headers };
}

async function signed(req: ObjectRouteRequest): Promise<ObjectRouteGrant> {
  const result = await signer.sign(req, SCOPE);
  if (result.kind !== "signed") throw new Error(result.reason);
  return result;
}

/**
 * What S3 does with the request on the wire, written independently of the
 * signer: canonicalize the path and query as sent, recompute the signature
 * from the secret, and compare. A target that differs from what was signed
 * by one byte fails here the way it would fail at S3.
 */
function verify(grant: ObjectRouteGrant, method: string): void {
  const headers = new Map(grant.headers);
  headers.set("host", new URL(grant.url).host);
  const authorization = headers.get("authorization") ?? "";
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      authorization,
    );
  if (match === null) throw new Error(`unexpected ${authorization}`);
  const [, keyId, day, region, signedNames, signature] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  expect(keyId).toBe(ACCESS_KEY);
  const mark = grant.target.indexOf("?");
  const path = mark < 0 ? grant.target : grant.target.slice(0, mark);
  const rawQuery = mark < 0 ? "" : grant.target.slice(mark + 1);
  const encode = (value: string) =>
    encodeURIComponent(value).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  const query = rawQuery
    .split("&")
    .filter((piece) => piece !== "")
    .map((piece) => {
      const [name = "", value = ""] = piece.split("=");
      return [
        encode(decodeURIComponent(name)),
        encode(decodeURIComponent(value)),
      ];
    })
    .sort(([a = ""], [b = ""]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const names = signedNames.split(";");
  const canonical = [
    method,
    path,
    query,
    ...names.map((name) => `${name}:${(headers.get(name) ?? "").trim()}`),
    "",
    signedNames,
    headers.get("x-amz-content-sha256"),
  ].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = [
    "AWS4-HMAC-SHA256",
    headers.get("x-amz-date"),
    scope,
    createHash("sha256").update(canonical).digest("hex"),
  ].join("\n");
  let key: Buffer = createHmac("sha256", `AWS4${SECRET}`).update(day).digest();
  for (const part of [region, "s3", "aws4_request"]) {
    key = createHmac("sha256", key).update(part).digest();
  }
  expect(createHmac("sha256", key).update(toSign).digest("hex")).toBe(
    signature,
  );
}

describe("the object store route's signer (94S-251)", () => {
  test("a get under the session prefix is signed for exactly its path", async () => {
    const grant = await signed(
      request(
        "GET",
        "/claude-sessions/sessions/s1/transcript/part-0?x-id=GetObject",
        [["x-amz-checksum-mode", "ENABLED"]],
      ),
    );
    expect(grant.url).toBe("http://localstack:4566");
    // The SDK's label is not part of the request S3 sees.
    expect(grant.target).toBe("/claude-sessions/sessions/s1/transcript/part-0");
    expect(new Map(grant.headers).get("x-amz-content-sha256")).toBe(
      "UNSIGNED-PAYLOAD",
    );
    verify(grant, "GET");
  });

  test("a versioned head keeps its version, encoded the way it is signed", async () => {
    const grant = await signed(
      request(
        "HEAD",
        "/claude-sessions/sessions/s1/a%20b.json?versionId=v%2B1%3D",
      ),
    );
    expect(grant.target).toBe(
      "/claude-sessions/sessions/s1/a%20b.json?versionId=v%2B1%3D",
    );
    verify(grant, "HEAD");
  });

  test("a create-only put carries its condition, length and checksum, all signed", async () => {
    const grant = await signed(
      request(
        "PUT",
        "/claude-sessions/sessions/s1/checkpoints/m.json?x-id=PutObject",
        [
          ["content-length", "14"],
          ["content-type", "application/octet-stream"],
          ["if-none-match", "*"],
          ["x-amz-sdk-checksum-algorithm", "CRC32"],
          ["x-amz-checksum-crc32", "AAAAAA=="],
        ],
      ),
    );
    const headers = new Map(grant.headers);
    expect(headers.get("if-none-match")).toBe("*");
    expect(headers.get("content-length")).toBe("14");
    expect(headers.get("authorization")).toContain("if-none-match");
    verify(grant, "PUT");
  });

  test("a list of the session prefix is signed with its query sorted and encoded", async () => {
    const grant = await signed(
      request(
        "GET",
        "/claude-sessions?prefix=sessions%2Fs1%2F&list-type=2&continuation-token=a%2Fb%2Bc%3D%3D&x-id=ListObjectsV2",
      ),
    );
    expect(grant.target).toBe(
      "/claude-sessions/?continuation-token=a%2Fb%2Bc%3D%3D&list-type=2&prefix=sessions%2Fs1%2F",
    );
    verify(grant, "GET");
  });

  test("on AWS the bucket is the host, and a session token is signed along", async () => {
    const aws = createObjectRouteSigner({
      bucket: "claude-sessions",
      credentials: {
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET,
        sessionToken: "session-token",
      },
      region: "ap-northeast-1",
      now: () => AT,
    });
    const grant = await aws.sign(
      request("GET", "/claude-sessions/sessions/s1/x"),
      SCOPE,
    );
    if (grant.kind !== "signed") throw new Error(grant.reason);
    expect(grant.url).toBe(
      "https://claude-sessions.s3.ap-northeast-1.amazonaws.com",
    );
    expect(grant.target).toBe("/sessions/s1/x");
    expect(new Map(grant.headers).get("x-amz-security-token")).toBe(
      "session-token",
    );
    verify(grant, "GET");
  });

  const refusals: Array<[string, ObjectRouteRequest]> = [
    [
      "another session's object",
      request("GET", "/claude-sessions/sessions/s2/x"),
    ],
    [
      "a session whose id extends this one",
      request("GET", "/claude-sessions/sessions/s10/x"),
    ],
    [
      "the prefix itself as a key",
      request("GET", "/claude-sessions/sessions/s1/"),
    ],
    ["a dot segment", request("GET", "/claude-sessions/sessions/s1/../s2/x")],
    [
      "an encoded dot segment",
      request("GET", "/claude-sessions/sessions/s1/%2e%2e/s2/x"),
    ],
    [
      "an encoded slash",
      request("GET", "/claude-sessions/sessions/s1/a%2F..%2F..%2Fs2%2Fx"),
    ],
    ["a malformed escape", request("GET", "/claude-sessions/sessions/s1/%zz")],
    ["another bucket", request("GET", "/other-bucket/sessions/s1/x")],
    ["a delete", request("DELETE", "/claude-sessions/sessions/s1/x")],
    ["a post", request("POST", "/claude-sessions/sessions/s1/x?uploads")],
    ["a bucket put", request("PUT", "/claude-sessions")],
    [
      "a legal hold",
      request("PUT", "/claude-sessions/sessions/s1/x?legal-hold", [
        ["content-length", "0"],
        ["if-none-match", "*"],
      ]),
    ],
    [
      "a retention",
      request("PUT", "/claude-sessions/sessions/s1/x?retention", [
        ["content-length", "0"],
        ["if-none-match", "*"],
      ]),
    ],
    [
      "an ACL",
      request("PUT", "/claude-sessions/sessions/s1/x?acl", [
        ["content-length", "0"],
        ["if-none-match", "*"],
      ]),
    ],
    [
      "a copy from another session",
      request("PUT", "/claude-sessions/sessions/s1/x", [
        ["content-length", "0"],
        ["if-none-match", "*"],
        ["x-amz-copy-source", "/claude-sessions/sessions/s2/x"],
      ]),
    ],
    [
      "an Object Lock header",
      request("PUT", "/claude-sessions/sessions/s1/x", [
        ["content-length", "0"],
        ["if-none-match", "*"],
        ["x-amz-object-lock-legal-hold", "OFF"],
      ]),
    ],
    [
      "a governance bypass",
      request("GET", "/claude-sessions/sessions/s1/x", [
        ["x-amz-bypass-governance-retention", "true"],
      ]),
    ],
    [
      "an aws-chunked body",
      request("PUT", "/claude-sessions/sessions/s1/x", [
        ["content-length", "20"],
        ["if-none-match", "*"],
        ["content-encoding", "aws-chunked"],
      ]),
    ],
    ["a put with no length", request("PUT", "/claude-sessions/sessions/s1/x")],
    [
      "an overwrite, a put that is not create-only",
      request("PUT", "/claude-sessions/sessions/s1/x", [
        ["content-length", "4"],
      ]),
    ],
    [
      "a condition other than create-only",
      request("PUT", "/claude-sessions/sessions/s1/x", [
        ["content-length", "0"],
        ["if-none-match", '"etag"'],
      ]),
    ],
    [
      "a list of another session",
      request("GET", "/claude-sessions?list-type=2&prefix=sessions%2Fs2%2F"),
    ],
    [
      "a list of every session",
      request("GET", "/claude-sessions?list-type=2&prefix=sessions%2F"),
    ],
    ["a list with no prefix", request("GET", "/claude-sessions?list-type=2")],
    [
      "a version listing",
      request("GET", "/claude-sessions?versions&prefix=sessions%2Fs1%2F"),
    ],
    [
      "a list that names its prefix twice",
      request(
        "GET",
        "/claude-sessions?list-type=2&prefix=sessions%2Fs1%2F&prefix=sessions%2Fs2%2F",
      ),
    ],
    [
      "a literal plus in the query",
      request("GET", "/claude-sessions/sessions/s1/x?versionId=a+b"),
    ],
    [
      "a request labelled as another operation",
      request("GET", "/claude-sessions/sessions/s1/x?x-id=DeleteObject"),
    ],
    [
      "a target that is not a path",
      request("GET", "claude-sessions/sessions/s1/x"),
    ],
  ];

  for (const [what, req] of refusals) {
    test(`refuses ${what}`, async () => {
      const result = await signer.sign(req, SCOPE);
      expect(result.kind).toBe("refused");
    });
  }
});
