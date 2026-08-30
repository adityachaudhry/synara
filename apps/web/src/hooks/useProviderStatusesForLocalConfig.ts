// FILE: useProviderStatusesForLocalConfig.ts
// Purpose: Normalize server provider health against local binary overrides for composer-like sends.
// Layer: Web hook
// Depends on: server config query, app settings, and provider availability normalization.

import type { ProviderKind, ServerProviderStatus } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";

import { getCustomBinaryPathForProvider, useAppSettings } from "../appSettings";
import { normalizeProviderStatusForLocalConfig } from "../lib/providerAvailability";
import { serverConfigQueryOptions, serverQueryKeys } from "../lib/serverReactQuery";

const EMPTY_PROVIDER_STATUSES: ServerProviderStatus[] = [];

export function useProviderStatusesForLocalConfig(
  confirmedCustomBinaryPathsByProvider?: Readonly<
    Partial<Record<ProviderKind, string | null | undefined>>
  >,
): readonly ServerProviderStatus[] {
  const { settings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const streamedProviderStatusesQuery = useQuery({
    queryKey: serverQueryKeys.providerStatuses(),
    queryFn: async () => EMPTY_PROVIDER_STATUSES,
    enabled: false,
  });

  return (
    streamedProviderStatusesQuery.data ??
    serverConfigQuery.data?.providers ??
    EMPTY_PROVIDER_STATUSES
  )
    .map((status) =>
      normalizeProviderStatusForLocalConfig({
        provider: status.provider,
        status,
        customBinaryPath: getCustomBinaryPathForProvider(settings, status.provider),
        confirmedCustomBinaryPath: confirmedCustomBinaryPathsByProvider?.[status.provider],
      }),
    )
    .flatMap((status) => (status ? [status] : []));
}
