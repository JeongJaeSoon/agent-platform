// Run by client.ts under Node, so a stall it counts cannot be Bun's server.
import http from "node:http";

function listXml(keys) {
  let out =
    '<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult><IsTruncated>false</IsTruncated>';
  for (let i = 0; i < keys; i++) {
    out += `<Contents><Key>sessions/00000000-0000-4000-8000-000000000000/transcripts/generation-0000000001/-workspace/00000000-0000-4000-8000-000000000001/main/part-${String(i).padStart(10, "0")}.jsonl</Key><LastModified>2026-09-25T08:59:24.000Z</LastModified><ETag>&quot;d41d8cd98f00b204e9800998ecf8427e&quot;</ETag><Size>1234</Size><StorageClass>STANDARD</StorageClass></Contents>`;
  }
  return `${out}<KeyCount>${keys}</KeyCount></ListBucketResult>`;
}

const lists = new Map();
const server = http.createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    const url = new URL(request.url ?? "/", "http://stall");
    const keys = url.searchParams.get("keys");
    let body = Buffer.alloc(0);
    if (keys !== null) {
      body = lists.get(keys) ?? Buffer.from(listXml(Number(keys)));
      lists.set(keys, body);
    } else if (request.method === "GET") {
      body = Buffer.alloc(Number(url.searchParams.get("bytes") ?? "2000"), 120);
    }
    response.writeHead(200, {
      "content-type": "application/xml",
      "content-length": String(body.byteLength),
    });
    response.end(body);
  });
});
server.keepAliveTimeout = 255_000;
server.listen(0, "127.0.0.1", () => {
  console.log(JSON.stringify({ port: server.address().port }));
});
