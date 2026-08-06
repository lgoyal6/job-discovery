import { createHash } from 'node:crypto';

export interface JobState { status: 'OPEN' | 'CLOSED'; sentAt: string | null; materialVersion: number }

export function transitionJob(previous: JobState | null, incoming: 'OPEN' | 'CLOSED'): { state: JobState; meaningfulChange: boolean } {
  if (!previous) return { state: { status: incoming, sentAt: null, materialVersion: 1 }, meaningfulChange: incoming === 'OPEN' };
  if (previous.status === 'CLOSED' && incoming === 'OPEN') return { state: { status: 'OPEN', sentAt: null, materialVersion: previous.materialVersion + 1 }, meaningfulChange: true };
  return { state: { ...previous, status: incoming }, meaningfulChange: false };
}

export function digestHash(jobIds: string[]): string {
  return createHash('sha256').update([...jobIds].sort().join('|')).digest('hex');
}

export function batchKey(jobIds: string[], timestamp: Date): string {
  const hash = digestHash(jobIds);
  return `${timestamp.toISOString().slice(0, 13)}:${hash.slice(0, 24)}`;
}
