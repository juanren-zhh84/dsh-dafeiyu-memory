import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const FIELDS = ['source', 'sourceKey', 'conversationKind', 'conversationKey', 'actorKey', 'actorName', 'direction', 'contentText', 'occurredAt', 'visibility'];
const validText = (value, max, empty = false) => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0);

/** Copies only the public core DTO. No raw event, attachments or caller object survives. */
export function freezeEvent(value) {
  const dto = {};
  for (const field of FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor && !Object.hasOwn(descriptor, 'value')) throw new Error('MEMORY_INVALID_EVENT');
    if (descriptor) dto[field] = descriptor.value;
  }
  if (dto.source !== 'qq' || !['private', 'group', 'system'].includes(dto.conversationKind)
    || !['incoming', 'outgoing'].includes(dto.direction)
    || !['owner-private', 'conversation', 'group'].includes(dto.visibility)
    || !validText(dto.conversationKey, 512) || !validText(dto.actorKey, 512)
    || !validText(dto.actorName, 200, true) || !validText(dto.contentText, 16000)
    || !Number.isSafeInteger(dto.occurredAt) || dto.occurredAt < 0
    || (Object.hasOwn(dto, 'sourceKey') && !validText(dto.sourceKey, 512))) throw new Error('MEMORY_INVALID_EVENT');
  return Object.freeze(dto);
}

/** Called exclusively by the connector's serial queue. Failed/new rows never overwrite old rows. */
export class ModuleSpool {
  constructor(directory, { active, warn }) {
    this.directory = directory;
    this.path = join(directory, 'events.jsonl');
    this.active = active;
    this.warn = warn;
  }

  read() {
    try {
      if (statSync(this.path).size > MAX_BYTES) { this.warn('MEMORY_SPOOL_FULL'); return undefined; }
      return readFileSync(this.path, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  }

  append(input) {
    if (!this.active()) return;
    const line = JSON.stringify(freezeEvent(input)) + '\n';
    const current = this.read();
    const separator = current && !current.endsWith('\n') ? '\n' : '';
    if (current === undefined || current.split('\n').filter(Boolean).length >= MAX_ENTRIES
      || Buffer.byteLength(current) + Buffer.byteLength(separator + line) > MAX_BYTES) {
      this.warn('MEMORY_SPOOL_FULL'); return;
    }
    mkdirSync(this.directory, { recursive: true });
    const fd = openSync(this.path, 'a', 0o600);
    try { writeSync(fd, separator + line); fsyncSync(fd); }
    finally { closeSync(fd); }
  }

  replace(contents) {
    if (!this.active()) return;
    const temp = this.path + '.tmp';
    writeFileSync(temp, contents, { mode: 0o600 });
    const fd = openSync(temp, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, this.path);
  }

  async drain(service) {
    if (!this.active() || !service || typeof service.recordEvent !== 'function') return;
    const contents = this.read();
    if (!contents) return;
    const lines = contents.split('\n');
    if (lines.at(-1) === '') lines.pop();
    let consumed = 0;
    for (const [index, line] of lines.entries()) {
      if (!this.active()) return;
      let dto;
      try { dto = freezeEvent(JSON.parse(line)); }
      catch { this.warn('MEMORY_SPOOL_INVALID_ROW', index + 1); consumed++; continue; }
      try { await service.recordEvent(dto); consumed++; }
      catch { this.warn('MEMORY_RECORD_FAILED'); break; }
    }
    // Disposal during an outstanding record leaves its durable row for deduplicated replay.
    if (consumed && this.active()) this.replace(lines.slice(consumed).map((line) => line + '\n').join(''));
  }
}
