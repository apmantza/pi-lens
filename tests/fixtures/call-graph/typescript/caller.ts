import { helper } from "./callee";

export function caller(): number {
  return helper();
}
