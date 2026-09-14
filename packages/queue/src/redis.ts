import type {
  EnqueueInput,
  LeaseCommand,
  PublishInput,
  QueueBackend,
  SubscribeInput,
} from "./index.ts";

function unsupported(): never {
  throw new Error("Redis queue backend is not implemented");
}

export class RedisQueueStub implements QueueBackend {
  async enqueue(_input: EnqueueInput): Promise<never> {
    return unsupported();
  }

  async consume(_sessionId: string, _consumerId: string): Promise<never> {
    return unsupported();
  }

  async publish(_input: PublishInput): Promise<never> {
    return unsupported();
  }

  async *subscribe(_input: SubscribeInput): AsyncIterable<never> {
    yield unsupported();
  }

  async lease(_command: LeaseCommand): Promise<never> {
    return unsupported();
  }
}
