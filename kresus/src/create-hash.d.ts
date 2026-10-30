declare module "create-hash" {
  import type { Buffer } from "buffer";
  export default function createHash(algorithm: string): { update(data: Buffer): { digest(): Buffer } };
}
declare module "process" { const process: unknown; export default process; }
