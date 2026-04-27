export type AttentionLevel = "info" | "warning" | "error" | "success";

export type MonitorAttention = {
  title: string;
  level: AttentionLevel;
  monitor_id: string;
};
