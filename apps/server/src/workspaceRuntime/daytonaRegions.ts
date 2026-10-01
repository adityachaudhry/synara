/** Eligibility is control-plane evidence; sandbox failures remain separately fenced. */
export async function availableDaytonaContainerTargets(input: { apiKey: string; apiUrl?: string }) {
  const read = async (route: string) => {
    const response = await fetch(`${input.apiUrl ?? "https://app.daytona.io/api"}${route}`, {
      headers: { Authorization: `Bearer ${input.apiKey}` }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Daytona region inventory returned HTTP ${response.status}.`);
    return response.json();
  };
  const key = await read("/api-keys/current") as { organizationId: string };
  if (!key.organizationId) throw new Error("Daytona region inventory did not return an organization.");
  const classes = await read(`/organizations/${encodeURIComponent(key.organizationId)}/available-sandbox-classes`) as Array<{ regionId: string; sandboxClass: string }>;
  return new Set(classes.filter((entry) => entry.sandboxClass === "container").map((entry) => entry.regionId));
}
