import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function asyncSubagentsChildFastTrack(pi: ExtensionAPI) {
  (pi as ExtensionAPI & { on(event: "before_provider_request", handler: (event: { payload?: Record<string, unknown> }) => Promise<Record<string, unknown>>): void }).on("before_provider_request", async (event) => ({
    ...(event.payload ?? {}),
    service_tier: "priority",
  }));
}
