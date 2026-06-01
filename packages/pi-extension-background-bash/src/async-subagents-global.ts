import backgroundBashExtension from "./index.js";

// Async-subagents launches child Pi with --no-extensions and then explicitly loads
// configured default extensions. Loading this wrapper from ~/.async-subagents/config.json
// is the opt-in signal for child agents, so enable the background-bash extension for
// this process before delegating to the normal entrypoint.
process.env.PI_BACKGROUND_BASH_ENABLED = process.env.PI_BACKGROUND_BASH_ENABLED || "1";

export default backgroundBashExtension;
