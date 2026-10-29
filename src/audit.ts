export type AuditLog = (event: string, details: Record<string, unknown>) => void;

// No file or platform APIs here so the hosted handler can import it on any runtime.
// The caller decides where lines go: a local file, or stdout for the host's log collector.
export function jsonAuditLog(write: (line: string) => void, extra: Record<string, unknown> = {}): AuditLog {
  return (event, details) => write(JSON.stringify({ ts: new Date().toISOString(), event, ...extra, ...details }));
}
