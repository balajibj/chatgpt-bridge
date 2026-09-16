import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { WORKFLOW_SERVER_BACKEND } from '../server/workflowServerState.js';
import { syncDirectoryBestEffort, syncHandleBestEffort } from '../safeDirectorySync.js';

export const WORKFLOW_MIGRATION_RECEIPT_STORE_VERSION = 1;
export const WORKFLOW_MIGRATION_RECORD_VERSION = 1;

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function requiredText(value, code, message) {
  const normalized = text(value);
  if (!normalized) throw storeError(code, message);
  return normalized;
}

function canonicalValue(value) {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object') return String(value);
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function sameValue(left, right) {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function storeError(code, message, cause = null) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function initialState() {
  return {
    schemaVersion: WORKFLOW_MIGRATION_RECEIPT_STORE_VERSION,
    intents: {},
    receipts: {},
  };
}

export function normalizeWorkflowMigrationIntent(value = {}) {
  const source = record(value);
  const migrationId = requiredText(source.migrationId, 'MIGRATION_ID_REQUIRED', 'Migration ID is required');
  const target = record(source.target);
  const backend = text(target.backend) || WORKFLOW_SERVER_BACKEND;
  if (backend !== WORKFLOW_SERVER_BACKEND) {
    throw storeError('MIGRATION_BACKEND_UNSUPPORTED', `Unsupported migration backend: ${backend}`);
  }
  if (source.confirmation?.explicit !== true) {
    throw storeError('MIGRATION_CONFIRMATION_REQUIRED', 'A migration intent requires explicit confirmation');
  }
  if (!Object.keys(record(target.workflow)).length) {
    throw storeError('MIGRATION_TARGET_DRAFT_REQUIRED', 'A migration intent requires the complete Zipflow workflow draft');
  }
  if (target.expectedRevision == null || target.expectedRevision === '') {
    throw storeError('MIGRATION_TARGET_REVISION_REQUIRED', 'A migration intent requires the target workflow revision');
  }
  return {
    recordVersion: WORKFLOW_MIGRATION_RECORD_VERSION,
    migrationId,
    workflowId: requiredText(source.workflowId, 'WORKFLOW_ID_REQUIRED', 'Workflow ID is required'),
    createdAt: requiredText(source.createdAt, 'MIGRATION_TIMESTAMP_REQUIRED', 'Migration intent timestamp is required'),
    source: {
      schemaVersion: Number(source.source?.schemaVersion),
      revision: Number(source.source?.revision) || 0,
      fingerprint: requiredText(
        source.source?.fingerprint,
        'MIGRATION_SOURCE_FINGERPRINT_REQUIRED',
        'Migration source fingerprint is required',
      ),
    },
    target: {
      backend,
      projectId: requiredText(target.projectId, 'MIGRATION_PROJECT_ID_REQUIRED', 'Zipflow project ID is required'),
      expectedRevision: clone(target.expectedRevision),
      draftFingerprint: requiredText(
        target.draftFingerprint,
        'MIGRATION_DRAFT_FINGERPRINT_REQUIRED',
        'Migration draft fingerprint is required',
      ),
      workflow: clone(target.workflow),
    },
    confirmation: {
      explicit: true,
      id: requiredText(
        source.confirmation?.id,
        'MIGRATION_CONFIRMATION_REQUIRED',
        'Migration confirmation ID is required',
      ),
      confirmedAt: requiredText(
        source.confirmation?.confirmedAt,
        'MIGRATION_CONFIRMATION_REQUIRED',
        'Migration confirmation timestamp is required',
      ),
    },
    idempotencyKey: requiredText(
      source.idempotencyKey,
      'MIGRATION_IDEMPOTENCY_KEY_REQUIRED',
      'Migration idempotency key is required',
    ),
  };
}

export function normalizeWorkflowMigrationReceipt(value = {}) {
  const source = record(value);
  const target = record(source.target);
  const backend = text(target.backend) || WORKFLOW_SERVER_BACKEND;
  if (backend !== WORKFLOW_SERVER_BACKEND) {
    throw storeError('MIGRATION_BACKEND_UNSUPPORTED', `Unsupported migration backend: ${backend}`);
  }
  return {
    recordVersion: WORKFLOW_MIGRATION_RECORD_VERSION,
    receiptId: requiredText(source.receiptId, 'MIGRATION_RECEIPT_ID_REQUIRED', 'Migration receipt ID is required'),
    migrationId: requiredText(source.migrationId, 'MIGRATION_ID_REQUIRED', 'Migration ID is required'),
    workflowId: requiredText(source.workflowId, 'WORKFLOW_ID_REQUIRED', 'Workflow ID is required'),
    completedAt: requiredText(source.completedAt, 'MIGRATION_TIMESTAMP_REQUIRED', 'Migration completion timestamp is required'),
    source: {
      schemaVersion: Number(source.source?.schemaVersion),
      revision: Number(source.source?.revision) || 0,
      fingerprint: requiredText(
        source.source?.fingerprint,
        'MIGRATION_SOURCE_FINGERPRINT_REQUIRED',
        'Migration source fingerprint is required',
      ),
    },
    target: {
      backend,
      projectId: requiredText(target.projectId, 'MIGRATION_PROJECT_ID_REQUIRED', 'Zipflow project ID is required'),
      workflowRevision: clone(target.workflowRevision ?? ''),
      serverReceiptId: text(target.serverReceiptId),
      idempotencyKey: requiredText(
        target.idempotencyKey,
        'MIGRATION_IDEMPOTENCY_KEY_REQUIRED',
        'Migration idempotency key is required',
      ),
    },
    confirmation: {
      explicit: source.confirmation?.explicit === true,
      id: requiredText(
        source.confirmation?.id,
        'MIGRATION_CONFIRMATION_REQUIRED',
        'Migration confirmation ID is required',
      ),
    },
  };
}

function receiptMatchesIntent(receipt, intent) {
  return receipt.migrationId === intent.migrationId
    && receipt.workflowId === intent.workflowId
    && receipt.source.schemaVersion === intent.source.schemaVersion
    && receipt.source.revision === intent.source.revision
    && receipt.source.fingerprint === intent.source.fingerprint
    && receipt.target.backend === intent.target.backend
    && receipt.target.projectId === intent.target.projectId
    && receipt.target.idempotencyKey === intent.idempotencyKey
    && receipt.confirmation.explicit === true
    && receipt.confirmation.id === intent.confirmation.id;
}

export class WorkflowMigrationReceiptStore {
  constructor(rootDir = config.dataDir, { filePath = '' } = {}) {
    this.dir = path.join(path.resolve(rootDir), 'workflows');
    this.file = path.resolve(filePath || path.join(this.dir, 'migration-receipts-v1.json'));
    this.dir = path.dirname(this.file);
    this.state = initialState();
    this.writeChain = Promise.resolve();
    this.sequence = 0;
    this.ready = this.#load();
  }

  async #load() {
    await fs.mkdir(this.dir, { recursive: true });
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        await this.#writeSnapshot(this.state);
        return;
      }
      throw storeError('MIGRATION_RECEIPT_STORE_CORRUPT', `Migration receipt store is unreadable: ${this.file}`, error);
    }
    if (Number(parsed?.schemaVersion) !== WORKFLOW_MIGRATION_RECEIPT_STORE_VERSION) {
      throw storeError(
        'MIGRATION_RECEIPT_STORE_INCOMPATIBLE',
        `Migration receipt store must use schema v${WORKFLOW_MIGRATION_RECEIPT_STORE_VERSION}`,
      );
    }
    const state = initialState();
    for (const [migrationId, value] of Object.entries(record(parsed.intents))) {
      const intent = normalizeWorkflowMigrationIntent(value);
      if (intent.migrationId !== migrationId) {
        throw storeError('MIGRATION_RECEIPT_STORE_CORRUPT', `Migration intent key does not match ${migrationId}`);
      }
      state.intents[migrationId] = intent;
    }
    for (const [migrationId, value] of Object.entries(record(parsed.receipts))) {
      const receipt = normalizeWorkflowMigrationReceipt(value);
      const intent = state.intents[migrationId];
      if (receipt.migrationId !== migrationId || !intent || !receiptMatchesIntent(receipt, intent)) {
        throw storeError('MIGRATION_RECEIPT_STORE_CORRUPT', `Migration receipt does not match intent ${migrationId}`);
      }
      state.receipts[migrationId] = receipt;
    }
    this.state = state;
  }

  async #writeSnapshot(state) {
    const temporary = `${this.file}.tmp-${process.pid}-${++this.sequence}`;
    const handle = await fs.open(temporary, 'w');
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await syncHandleBestEffort(handle);
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temporary, this.file);
      await syncDirectoryBestEffort(fs, this.dir);
    } catch (error) {
      await fs.unlink(temporary).catch(() => null);
      throw error;
    }
  }

  async #barrier() {
    await this.ready;
    await this.writeChain;
  }

  async #mutate(operation) {
    await this.ready;
    const pending = this.writeChain
      .catch(() => {})
      .then(async () => {
        const draft = clone(this.state);
        const result = await operation(draft);
        await this.#writeSnapshot(draft);
        this.state = draft;
        return clone(result);
      });
    this.writeChain = pending.then(() => undefined, () => undefined);
    return await pending;
  }

  async begin(value) {
    const intent = normalizeWorkflowMigrationIntent(value);
    return await this.#mutate((draft) => {
      const existing = draft.intents[intent.migrationId];
      if (existing && !sameValue(existing, intent)) {
        throw storeError(
          'MIGRATION_INTENT_CONFLICT',
          `Migration intent ${intent.migrationId} is immutable`,
        );
      }
      draft.intents[intent.migrationId] = existing || intent;
      return draft.intents[intent.migrationId];
    });
  }

  async commit(value) {
    const receipt = normalizeWorkflowMigrationReceipt(value);
    return await this.#mutate((draft) => {
      const intent = draft.intents[receipt.migrationId];
      if (!intent) {
        throw storeError(
          'MIGRATION_INTENT_NOT_FOUND',
          `Migration intent ${receipt.migrationId} must be durable before its receipt`,
        );
      }
      if (!receiptMatchesIntent(receipt, intent)) {
        throw storeError(
          'MIGRATION_RECEIPT_MISMATCH',
          `Migration receipt ${receipt.migrationId} does not match its intent`,
        );
      }
      const existing = draft.receipts[receipt.migrationId];
      if (existing && !sameValue(existing, receipt)) {
        throw storeError(
          'MIGRATION_RECEIPT_CONFLICT',
          `Migration receipt ${receipt.migrationId} is immutable`,
        );
      }
      draft.receipts[receipt.migrationId] = existing || receipt;
      return draft.receipts[receipt.migrationId];
    });
  }

  async getIntent(migrationId) {
    await this.#barrier();
    return clone(this.state.intents[text(migrationId)] || null);
  }

  async getReceipt(migrationId) {
    await this.#barrier();
    return clone(this.state.receipts[text(migrationId)] || null);
  }

  async getReceiptForWorkflow(workflowId) {
    await this.#barrier();
    const id = text(workflowId);
    const receipts = Object.values(this.state.receipts)
      .filter((receipt) => receipt.workflowId === id)
      .sort((left, right) => left.completedAt.localeCompare(right.completedAt));
    return clone(receipts.at(-1) || null);
  }

  async listPending() {
    await this.#barrier();
    return Object.values(this.state.intents)
      .filter((intent) => !this.state.receipts[intent.migrationId])
      .map(clone);
  }

  async close() {
    await this.#barrier();
  }
}
