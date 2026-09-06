import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// OBS Console's producer-spool v1 protocol. No auth tokens are persisted.
// OBS independently drains this directory after restart, even if Pi has exited.
export function spoolEvent(event: any, destination: string): string {
  const root = process.env.OBS_PRODUCER_SPOOL_DIR ?? path.join(process.env.XDG_STATE_HOME || path.join(homedir(), '.local/state'), 'nexus/obs-pending/v1');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const name = createHash('sha256').update(event.event_id).digest('hex');
  const target = path.join(root, `${name}.json`);
  const temporary = path.join(root, `.${name}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ version: 1, destination: destination.replace(/\/+$/, ''), event }));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    try { linkSync(temporary, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const directory = openSync(root, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { unlinkSync(temporary); }
  return target;
}

export function acknowledgeFile(file: string | undefined): void {
  if (!file) return;
  try { unlinkSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
