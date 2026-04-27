import { useState, useCallback } from "react";

export default function CommandButton({ command }: { command?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    if (!command) return;
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [command]);

  if (!command) return null;

  return (
    <div className="command-row">
      <code title={command}>{command}</code>
      <button onClick={copy} aria-label="Copy command to clipboard">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
