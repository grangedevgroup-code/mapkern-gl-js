import type { WorkerMessage, WorkerReply } from "./pool.ts";

interface WorkerScope {
  postMessage(message: WorkerReply, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerMessage>) => void): void;
}

export type TaskHandler = (
  payload: unknown,
  signal: AbortSignal,
) => Promise<{ result: unknown; transfer?: Transferable[] }>;

const settings = new Map<string, unknown>();

export function setting<T>(key: string): T | undefined {
  return settings.get(key) as T | undefined;
}

export function startWorker(tasks: Record<string, TaskHandler>): void {
  const scope = globalThis as unknown as WorkerScope;
  const handlers = new Map<string, TaskHandler>(Object.entries(tasks));
  handlers.set("ping", async (payload) => ({ result: payload }));
  const running = new Map<number, AbortController>();
  scope.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "cancel") {
      running.get(message.id)?.abort();
      running.delete(message.id);
      return;
    }
    if (message.id === 0) {
      settings.set(message.type, message.payload);
      return;
    }
    const handler = handlers.get(message.type);
    if (!handler) {
      scope.postMessage({ id: message.id, error: { message: `Unknown worker task "${message.type}"` } });
      return;
    }
    const controller = new AbortController();
    running.set(message.id, controller);
    handler(message.payload, controller.signal)
      .then(({ result, transfer }) => {
        if (controller.signal.aborted) return;
        scope.postMessage({ id: message.id, result }, transfer ?? []);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const err = error instanceof Error ? error : new Error(String(error));
        scope.postMessage({ id: message.id, error: { message: err.message, name: err.name } });
      })
      .finally(() => running.delete(message.id));
  });
}
