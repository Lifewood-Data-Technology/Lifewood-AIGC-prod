import type { DatabaseStatement } from "./database";

/** Internal adapter: the existing business transaction also records its upload receipt. */
export type UploadExecution = {
  prepareOnly?: boolean;
  identity?: (kind:string)=>string;
  commit?: (statements: DatabaseStatement[], result: object, guard?: {sql: string; values: (string | number | null)[]}) => Promise<unknown>;
};
