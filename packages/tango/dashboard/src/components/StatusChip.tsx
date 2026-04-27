
export default function StatusChip({ status }: { status: string }) {
  const s = status.toLowerCase();
  return (
    <span className={`status-chip status-${s}`} aria-label={`status ${status}`}>
      {status}
    </span>
  );
}
