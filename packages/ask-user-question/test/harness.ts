import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/pi/index.js";

export function harness(hasUI = true) {
  const tools = new Map<string, any>(), hooks = new Map<string, any[]>(), commands = new Map<string, any>(), shortcuts: any[] = [];
  const entries: any[] = [], messages: any[] = [], statuses: any[] = [], customOptions: any[] = [], order: string[] = []; let active: string[] = [];
  let uiDone: ((value: any) => void) | undefined; let component: any;
  const branch: any[] = [];
  const theme = { fg: (name: string, s: string) => `<${name}>${s}</${name}>`, bg: (_: string, s: string) => s, bold: (s: string) => s };
  const ctx = { hasUI, sessionManager: { getBranch: () => branch }, ui: { theme, custom: (factory: any, options: any) => new Promise((resolve) => { uiDone = resolve; component = factory({ requestRender() {} }, theme, {}, resolve); customOptions.push(options); order.push("ui"); }), setStatus: (...args: any[]) => statuses.push(args), notify() {} } } as unknown as ExtensionContext;
  const pi = {
    registerTool: (tool: any) => { tools.set(tool.name, tool); active.push(tool.name); }, registerCommand: (name: string, value: any) => commands.set(name, value), registerShortcut: (key: any, value: any) => shortcuts.push([key, value]), on: (name: string, fn: any) => hooks.set(name, [...(hooks.get(name) ?? []), fn]),
    appendEntry: (customType: string, data: any) => { entries.push({ customType, data }); branch.push({ type: "custom", customType, data }); order.push("append"); }, sendMessage: (message: any, options: any) => { messages.push({ message, options }); order.push("send"); }, getActiveTools: () => active, setActiveTools: (value: string[]) => { active = value; },
  } as unknown as ExtensionAPI;
  extension(pi);
  const execute = (name: string, params: any, id = `${name}-call`) => tools.get(name).execute(id, params, new AbortController().signal, () => {}, ctx);
  return { pi, ctx, tools, hooks, commands, shortcuts, entries, messages, statuses, customOptions, order, branch, execute, done: (value: any) => uiDone?.(value), component: () => component, active: () => active };
}
