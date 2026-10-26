export type MapkernErrorCode =
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

export class MapkernError extends Error {
  readonly code: MapkernErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(code: MapkernErrorCode, message: string, detail: Record<string, unknown> = {}, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MapkernError";
    this.code = code;
    this.detail = detail;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
