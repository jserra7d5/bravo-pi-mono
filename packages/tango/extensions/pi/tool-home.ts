import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const realHome = process.env.TANGO_REAL_HOME;
  if (!realHome) return;

  const bashTool = createBashTool(process.cwd(), {
    spawnHook: ({ command, cwd, env }) => ({
      command,
      cwd,
      env: { ...env, HOME: realHome },
    }),
  });

  pi.registerTool({
    ...bashTool,
    execute: async (id, params, signal, onUpdate, _ctx) => bashTool.execute(id, params, signal, onUpdate),
  });
}
