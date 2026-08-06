type Level = 'debug' | 'info' | 'warn' | 'error';
const ranks: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const configured = (process.env.LOG_LEVEL ?? 'info') as Level;

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (ranks[level] < (ranks[configured] ?? ranks.info)) return;
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields })}\n`);
}
