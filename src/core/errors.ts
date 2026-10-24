export type MapletErrorCode =
  | "webgl-unavailable"
  | "shader-compile"
  | "invalid-option"
  | "invalid-style"
  | "source-error"
  | "tile-error"
  | "network"
  | "http"
  | "auth"
  | "decode"
  | "context-lost"
  | "worker";

export class MapletError extends Error {
  readonly code: MapletErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(code: MapletErrorCode, message: string, detail: Record<string, unknown> = {}, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MapletError";
    this.code = code;
    this.detail = detail;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
