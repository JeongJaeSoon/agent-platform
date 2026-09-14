import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

export class MemoryS3Client {
  readonly objects = new Map<string, Uint8Array>();
  failPuts = 0;

  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      if (this.failPuts > 0) {
        this.failPuts -= 1;
        throw new Error("injected PutObject failure");
      }
      const key = command.input.Key;
      if (!key) throw new Error("PutObject key is required");
      this.objects.set(key, await toBytes(command.input.Body));
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const key = command.input.Key;
      const bytes = key === undefined ? undefined : this.objects.get(key);
      if (!bytes) throw new Error(`NoSuchKey: ${key}`);
      return {
        Body: {
          transformToByteArray: async () => bytes.slice(),
        },
      };
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? "";
      return {
        Contents: [...this.objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .sort()
          .map((Key) => ({ Key })),
      };
    }
    throw new Error(`Unsupported command: ${command?.constructor.name}`);
  }
}

async function toBytes(body: unknown): Promise<Uint8Array> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body.slice();
  throw new Error("Unsupported PutObject body");
}
