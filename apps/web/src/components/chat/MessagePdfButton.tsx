import { useState } from "react";
import { DownloadIcon } from "~/lib/icons";
import { toastManager } from "../ui/toast";
import { MessageActionButton, MESSAGE_ACTION_ICON_CLASS_NAME } from "./MessageActionButton";

export function MessagePdfButton({ download, className }: { download: () => Promise<void>; className?: string }) {
  const [pending, setPending] = useState(false);
  return <MessageActionButton label="Download answer as PDF" tooltip={pending ? "Preparing PDF…" : "Download PDF"}
    disabled={pending} className={className} onClick={() => {
      setPending(true);
      void download().catch((error) => toastManager.add({
        type: "error", title: "Could not download PDF",
        description: error instanceof Error ? error.message : "Please try again.",
      })).finally(() => setPending(false));
    }}><DownloadIcon className={MESSAGE_ACTION_ICON_CLASS_NAME} /></MessageActionButton>;
}
