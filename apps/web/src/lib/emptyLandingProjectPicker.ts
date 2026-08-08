export type EmptyLandingProjectPickerMode = "move-draft" | "replace-server-thread" | "hidden";

export interface EmptyLandingProjectPickerInput {
  readonly isCenteredEmptyLanding: boolean;
  readonly isLocalDraftThread: boolean;
  readonly isServerThread: boolean;
  readonly hasMessages: boolean;
  readonly hasLatestTurn: boolean;
  readonly projectKind: string | undefined;
}

export function resolveEmptyLandingProjectPickerMode({
  isCenteredEmptyLanding,
  isLocalDraftThread,
  isServerThread,
  hasMessages,
  hasLatestTurn,
  projectKind,
}: EmptyLandingProjectPickerInput): EmptyLandingProjectPickerMode {
  if (
    !isCenteredEmptyLanding ||
    projectKind !== "project" ||
    hasMessages ||
    hasLatestTurn
  ) {
    return "hidden";
  }
  if (isLocalDraftThread) {
    return "move-draft";
  }
  return isServerThread ? "replace-server-thread" : "hidden";
}
