import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { syncHandleBestEffort } from '../safeDirectorySync.js';

function safeId(value) {
  return String(value || 'workflow').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 160);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertMatchingArchive(existing, payload) {
  if (existing.workflowId !== payload.workflowId
    || existing.sourceFingerprint !== payload.sourceFingerprint
    || !sameValue(existing.receipt, payload.receipt)) {
    throw Object.assign(new Error('Legacy workflow archive receipt correlation mismatch'), {
      code: 'LEGACY_ARCHIVE_CONFLICT',
    });
  }
}

export class LegacyWorkflowArchiveStore {
  constructor(rootDir = config.dataDir) {
    this.root = path.join(path.resolve(rootDir), 'workflows', 'legacy-archive');
  }

  async archive({
    workflowId,
    sourceFingerprint,
    receipt,
    legacyWorkflow,
    legacyConfig,
  } = {}) {
    const directory = path.join(this.root, safeId(workflowId));
    const file = path.join(directory, `${safeId(sourceFingerprint)}.json`);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const payload = {
      archiveVersion: 1,
      readOnly: true,
      workflowId: String(workflowId || ''),
      sourceFingerprint: String(sourceFingerprint || ''),
      receipt: structuredClone(receipt),
      workflow: structuredClone(legacyWorkflow),
      config: structuredClone(legacyConfig),
    };
    try {
      const existing = JSON.parse(await fs.readFile(file, 'utf8'));
      assertMatchingArchive(existing, payload);
      return { file, existed: true };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await syncHandleBestEffort(handle);
    } finally {
      await handle.close();
    }
    try {
      await fs.link(temporary, file);
      await fs.unlink(temporary);
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      if (error.code === 'EEXIST') {
        const existing = JSON.parse(await fs.readFile(file, 'utf8'));
        assertMatchingArchive(existing, payload);
        return { file, existed: true };
      }
      throw error;
    }
    await fs.chmod(file, 0o400);
    return { file, existed: false };
  }
}
