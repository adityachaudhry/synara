import { createEmbeddedAppHistory as createAppHistory } from "./appNavigation";

export interface SynaraHistory {
  readonly location: { readonly pathname: string };
  push(path: string): void;
  replace(path: string): void;
  back(): void;
  forward(): void;
  flush(): void;
}

export function createEmbeddedAppHistory(initialPath = "/"): SynaraHistory {
  return createAppHistory(initialPath);
}
