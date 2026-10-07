/**
 * Pi model descriptors for Synara's model picker: thinking levels and display metadata.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ProviderListModelsResult } from "@synara/contracts";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const DEFAULT_PI_THINKING_LEVEL: ThinkingLevel = "medium";

const PI_THINKING_OPTIONS: ReadonlyArray<{
  readonly value: ThinkingLevel;
  readonly label: string;
  readonly description: string;
  readonly isDefault?: true;
}> = [
  { value: "off", label: "Off", description: "No extra reasoning" },
  { value: "minimal", label: "Minimal", description: "Light reasoning" },
  { value: "low", label: "Low", description: "Faster reasoning" },
  { value: "medium", label: "Medium", description: "Balanced reasoning", isDefault: true },
  { value: "high", label: "High", description: "Deeper reasoning" },
  { value: "xhigh", label: "Extra High", description: "Extra-high reasoning" },
  { value: "max", label: "Max", description: "Maximum reasoning" },
];
const PI_DEFAULT_SUPPORTED_THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
]);

function trimToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPiThinkingLevel(value: string | null | undefined): value is ThinkingLevel {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

export function normalizePiThinkingLevel(value: string | null | undefined): ThinkingLevel | undefined {
  return isPiThinkingLevel(value) ? value : undefined;
}

function getLocalSupportedThinkingLevels(
  model: Pick<Model<Api>, "reasoning" | "thinkingLevelMap">,
): Set<ThinkingLevel> {
  if (!model.reasoning) {
    return new Set();
  }

  const thinkingLevelMap = model.thinkingLevelMap;
  if (thinkingLevelMap && Object.keys(thinkingLevelMap).length > 0) {
    return new Set(
      PI_THINKING_OPTIONS.filter((option) => {
        const mapped = thinkingLevelMap[option.value as keyof typeof thinkingLevelMap];
        if (mapped === null) {
          return false;
        }
        return mapped !== undefined || PI_DEFAULT_SUPPORTED_THINKING_LEVELS.has(option.value);
      }).map((option) => option.value),
    );
  }

  return new Set(PI_DEFAULT_SUPPORTED_THINKING_LEVELS);
}

// Mirrors Pi SDK clamping so model discovery does not advertise levels that will be ignored.
export function getPiSupportedThinkingOptions(
  model: Pick<Model<Api>, "reasoning" | "thinkingLevelMap">,
): ReadonlyArray<(typeof PI_THINKING_OPTIONS)[number]> {
  if (!model.reasoning) {
    return [];
  }
  const supportedLevels = getLocalSupportedThinkingLevels(model);
  return PI_THINKING_OPTIONS.filter((option) => supportedLevels.has(option.value));
}

export function toPiProviderModelDescriptor(
  model: Model<Api>,
  getProviderDisplayName: (provider: string) => string,
): ProviderListModelsResult["models"][number] | null {
  const provider = trimToUndefined(model.provider);
  const modelId = trimToUndefined(model.id);
  if (!provider || !modelId || provider !== model.provider || modelId !== model.id) return null;
  const slug = `${provider}/${modelId}`;
  const supportedThinkingOptions = getPiSupportedThinkingOptions(model);
  return {
    slug,
    name: trimToUndefined(model.name) ?? slug,
    upstreamProviderId: provider,
    upstreamProviderName: trimToUndefined(getProviderDisplayName(model.provider)) ?? provider,
    ...(supportedThinkingOptions.length > 0
      ? {
          supportedReasoningEfforts: supportedThinkingOptions.map((option) => ({
            value: option.value,
            label: option.label,
            description: option.description,
          })),
          ...(supportedThinkingOptions.some((option) => option.value === DEFAULT_PI_THINKING_LEVEL)
            ? { defaultReasoningEffort: DEFAULT_PI_THINKING_LEVEL }
            : {}),
        }
      : {}),
  };
}

export function parseModelReference(
  modelId: string | null | undefined,
): { readonly provider?: string; readonly id: string } | undefined {
  const trimmed = trimToUndefined(modelId);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.includes("/")) {
    const [provider, ...rest] = trimmed.split("/");
    const id = rest.join("/");
    if (provider && id) {
      return { provider, id };
    }
  }
  if (trimmed.includes(":")) {
    const [provider, ...rest] = trimmed.split(":");
    const id = rest.join(":");
    if (provider && id) {
      return { provider, id };
    }
  }
  return { id: trimmed };
}
