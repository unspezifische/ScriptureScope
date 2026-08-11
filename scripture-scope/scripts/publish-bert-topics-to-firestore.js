#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const APP_ROOT = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.join(PROJECT_ROOT, 'datasets', 'bertopic_bsb_v1', 'nodes.json');
const PROJECT_ID = 'scripturescope-71f88';
const DATABASE_ID = '(default)';
const COLLECTION_NAME = 'nodes_BERT';
const BATCH_SIZE = 200;
const PLACEHOLDER_TOPIC = /^topic\s+\d+$/i;
const LOWERCASE_SHA256 = /^[a-f0-9]{64}$/;

const usage = `Safely publish named BERT topics to Firestore.

Usage:
  node scripts/publish-bert-topics-to-firestore.js [options]

Options:
  --input <path>       Node dataset (default: ../datasets/bertopic_bsb_v1/nodes.json)
  --apply              Apply the displayed plan; otherwise this is a production read-only dry run
  --backup <path>      New backup file to create before applying (required with --apply)
  --delete-stale       Delete live documents absent from the dataset (required when stale docs exist)
  --help               Show this message

The project, database, and collection are intentionally fixed to:
  ${PROJECT_ID} / ${DATABASE_ID} / ${COLLECTION_NAME}
`;

const readArguments = (argumentsList, cwd = process.cwd()) => {
  const options = {
    apply: false,
    deleteStale: false,
    input: DEFAULT_INPUT,
    backup: null,
    help: false,
  };

  const readValue = (argument, index) => {
    const value = argumentsList[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path.`);
    return value;
  };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--help') options.help = true;
    else if (argument === '--apply') options.apply = true;
    else if (argument === '--delete-stale') options.deleteStale = true;
    else if (argument === '--input') options.input = path.resolve(cwd, readValue(argument, index++));
    else if (argument === '--backup') options.backup = path.resolve(cwd, readValue(argument, index++));
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (options.apply && !options.backup) {
    throw new Error('--backup <path> is required with --apply. Existing production data must be backed up first.');
  }
  return options;
};

const stableSortValue = (value) => {
  if (Array.isArray(value)) return value.map(stableSortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableSortValue(value[key])]),
  );
};

const stableStringify = (value, indentation = 0) => (
  JSON.stringify(stableSortValue(value), null, indentation)
);

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const firestoreValue = (value) => {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Cannot publish non-finite number: ${value}`);
    return Number.isSafeInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(firestoreValue) } };
  }
  if (value && typeof value === 'object') {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(value).map(([key, nested]) => [key, firestoreValue(nested)]),
        ),
      },
    };
  }
  throw new Error(`Unsupported Firestore value type: ${typeof value}`);
};

const toFields = (document) => Object.fromEntries(
  Object.entries(document).map(([key, value]) => [key, firestoreValue(value)]),
);

const normalizeFirestoreValue = (value) => {
  if (Object.prototype.hasOwnProperty.call(value, 'arrayValue')) {
    const values = value.arrayValue?.values || [];
    return { arrayValue: { values: values.map(normalizeFirestoreValue) } };
  }
  if (Object.prototype.hasOwnProperty.call(value, 'mapValue')) {
    return { mapValue: { fields: normalizeFirestoreFields(value.mapValue?.fields || {}) } };
  }
  if (Object.prototype.hasOwnProperty.call(value, 'integerValue')) {
    return { integerValue: String(value.integerValue) };
  }
  if (Object.prototype.hasOwnProperty.call(value, 'nullValue')) {
    return { nullValue: null };
  }
  return value;
};

function normalizeFirestoreFields(fields) {
  return Object.fromEntries(
    Object.entries(fields || {}).map(([key, value]) => [key, normalizeFirestoreValue(value)]),
  );
}

const fieldsContentHash = (fields) => sha256(stableStringify(normalizeFirestoreFields(fields)));

const collectionContentHash = (entries) => sha256(stableStringify(
  [...entries]
    .sort((first, second) => (first.id < second.id ? -1 : first.id > second.id ? 1 : 0))
    .map((entry) => ({ id: entry.id, contentHash: entry.contentHash })),
));

const validateDocumentId = (id, label) => {
  if (typeof id !== 'string' || !id.trim()) throw new Error(`${label}: id must be a nonblank string.`);
  if (id !== id.trim()) throw new Error(`${label}: id may not start or end with whitespace.`);
  if (id.includes('/')) throw new Error(`${label}: id may not contain "/".`);
  if (id === '.' || id === '..' || /^__.*__$/.test(id)) {
    throw new Error(`${label}: id is not a valid Firestore document ID.`);
  }
  if (Buffer.byteLength(id, 'utf8') > 1500) throw new Error(`${label}: id exceeds 1,500 UTF-8 bytes.`);
};

const validateTopicFields = (document, label) => {
  const group = document?.group;
  const topicName = document?.topicName;
  const topicId = document?.topicId;

  if (typeof group !== 'string' || !group.trim()) throw new Error(`${label}: group must be nonblank.`);
  if (typeof topicName !== 'string' || !topicName.trim()) {
    throw new Error(`${label}: topicName must be nonblank.`);
  }
  if (group !== group.trim() || topicName !== topicName.trim()) {
    throw new Error(`${label}: group and topicName may not start or end with whitespace.`);
  }
  if (PLACEHOLDER_TOPIC.test(group) || PLACEHOLDER_TOPIC.test(topicName)) {
    throw new Error(`${label}: group/topicName may not use a placeholder such as "Topic 1".`);
  }
  if (group !== topicName) throw new Error(`${label}: group and topicName must be identical.`);

  const topicIdIsValid = (
    (typeof topicId === 'string' && Boolean(topicId.trim()))
    || (typeof topicId === 'number' && Number.isFinite(topicId))
  );
  if (!topicIdIsValid) throw new Error(`${label}: topicId must be a nonblank string or finite number.`);
  if (typeof topicId === 'string' && topicId !== topicId.trim()) {
    throw new Error(`${label}: topicId may not start or end with whitespace.`);
  }
};

const validateTopicIdentityConsistency = (documents, label) => {
  const nameByTopicId = new Map();
  const topicIdByName = new Map();
  for (const document of documents) {
    validateTopicFields(document, `${label}/${document.id ?? 'unknown'}`);
    const topicId = String(document.topicId);
    const existingName = nameByTopicId.get(topicId);
    if (existingName !== undefined && existingName !== document.topicName) {
      throw new Error(
        `${label}: topicId ${JSON.stringify(topicId)} maps to both ${JSON.stringify(existingName)} and ${JSON.stringify(document.topicName)}.`,
      );
    }
    const existingTopicId = topicIdByName.get(document.topicName);
    if (existingTopicId !== undefined && existingTopicId !== topicId) {
      throw new Error(
        `${label}: topicName ${JSON.stringify(document.topicName)} maps to both topicId ${JSON.stringify(existingTopicId)} and ${JSON.stringify(topicId)}.`,
      );
    }
    nameByTopicId.set(topicId, document.topicName);
    topicIdByName.set(document.topicName, topicId);
  }
};

const validateDatasetMetadata = (inputPath, nodesBytes) => {
  const metadataPath = path.join(path.dirname(inputPath), 'metadata.json');
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read required sibling metadata ${metadataPath}: ${error.message}`);
  }

  if (metadata?.topicModel?.labelStatus !== 'reviewed') {
    throw new Error(`${metadataPath}: topicModel.labelStatus must be "reviewed" before publication.`);
  }
  const overridesHash = metadata?.topicModel?.labelOverridesSha256;
  if (typeof overridesHash !== 'string' || !LOWERCASE_SHA256.test(overridesHash)) {
    throw new Error(
      `${metadataPath}: topicModel.labelOverridesSha256 must be a lowercase SHA-256 digest.`,
    );
  }

  const expectedNodesHash = metadata?.artifacts?.nodesSha256;
  if (typeof expectedNodesHash !== 'string' || !LOWERCASE_SHA256.test(expectedNodesHash)) {
    throw new Error(`${metadataPath}: artifacts.nodesSha256 must be a lowercase SHA-256 digest.`);
  }
  const actualNodesHash = sha256(nodesBytes);
  if (actualNodesHash !== expectedNodesHash) {
    throw new Error(
      `${metadataPath}: artifacts.nodesSha256 does not match the exact bytes of ${inputPath}.`,
    );
  }
  return metadata;
};

const loadDesiredDocuments = (inputPath) => {
  let nodesBytes;
  let nodes;
  try {
    nodesBytes = fs.readFileSync(inputPath);
  } catch (error) {
    throw new Error(`Unable to read ${inputPath}: ${error.message}`);
  }
  validateDatasetMetadata(inputPath, nodesBytes);
  try {
    nodes = JSON.parse(nodesBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Unable to parse ${inputPath}: ${error.message}`);
  }
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error(`${inputPath}: expected a nonempty JSON array.`);
  }

  const ids = new Set();
  const entries = nodes.map((data, index) => {
    const label = `${inputPath}[${index}]`;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`${label}: each node must be a JSON object.`);
    }
    validateDocumentId(data.id, label);
    if (ids.has(data.id)) throw new Error(`${label}: duplicate id ${JSON.stringify(data.id)}.`);
    ids.add(data.id);
    validateTopicFields(data, label);
    const fields = toFields(data);
    return { id: data.id, data, fields, contentHash: fieldsContentHash(fields) };
  });

  validateTopicIdentityConsistency(nodes, inputPath);
  return entries.sort((first, second) => (first.id < second.id ? -1 : first.id > second.id ? 1 : 0));
};

const loadFirebaseTools = () => {
  const globalModules = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  const firebaseExecutable = execFileSync('which', ['firebase'], { encoding: 'utf8' }).trim();
  const executableTarget = fs.realpathSync(firebaseExecutable);
  const candidates = [
    path.join(globalModules, 'firebase-tools'),
    path.resolve(path.dirname(executableTarget), '..', '..'),
  ];
  const toolsRoot = candidates.find((candidate) => (
    fs.existsSync(path.join(candidate, 'lib', 'auth.js'))
    && fs.existsSync(path.join(candidate, 'lib', 'apiv2.js'))
  ));
  if (!toolsRoot) {
    throw new Error('Firebase CLI is not installed globally. Install it with `npm install -g firebase-tools`.');
  }
  return {
    auth: require(path.join(toolsRoot, 'lib', 'auth.js')),
    apiv2: require(path.join(toolsRoot, 'lib', 'apiv2.js')),
  };
};

const getAccessToken = async () => {
  const { auth, apiv2 } = loadFirebaseTools();
  const account = auth.getProjectDefaultAccount(APP_ROOT) || auth.getGlobalDefaultAccount();
  if (!account) throw new Error('Firebase CLI is not signed in. Run `firebase login` first.');
  auth.setActiveAccount({ project: PROJECT_ID }, account);
  return apiv2.getAccessToken();
};

const collectionUrl = () => (
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}`
  + `/databases/${DATABASE_ID}/documents/${COLLECTION_NAME}`
);

const documentsApiUrl = (method) => (
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}`
  + `/databases/${DATABASE_ID}/documents:${method}`
);

const documentName = (id) => (
  `projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/${COLLECTION_NAME}/${id}`
);

const documentIdFromName = (name) => {
  const prefix = `${documentName('')}`;
  if (typeof name !== 'string' || !name.startsWith(prefix)) {
    throw new Error(`Unexpected Firestore document name: ${JSON.stringify(name)}`);
  }
  const id = name.slice(prefix.length);
  validateDocumentId(id, name);
  return id;
};

const beginReadOnlyTransaction = async (accessToken, fetchImplementation) => {
  const response = await fetchImplementation(documentsApiUrl('beginTransaction'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ options: { readOnly: {} } }),
  });
  if (!response.ok) {
    throw new Error(`Unable to start a consistent Firestore read: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json();
  if (typeof payload.transaction !== 'string' || !payload.transaction) {
    throw new Error('Firestore did not return a read-only transaction identifier.');
  }
  return payload.transaction;
};

const rollbackTransaction = async (transaction, accessToken, fetchImplementation) => {
  const response = await fetchImplementation(documentsApiUrl('rollback'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ transaction }),
  });
  if (!response.ok) {
    throw new Error(`Unable to close the Firestore read transaction: ${response.status} ${await response.text()}`);
  }
};

const fetchCurrentDocuments = async (accessToken, fetchImplementation = fetch) => {
  const entries = [];
  const transaction = await beginReadOnlyTransaction(accessToken, fetchImplementation);
  let pageToken = '';
  try {
    do {
      const url = new URL(collectionUrl());
      url.searchParams.set('pageSize', '1000');
      url.searchParams.set('transaction', transaction);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const response = await fetchImplementation(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        throw new Error(`Unable to inspect ${COLLECTION_NAME}: ${response.status} ${await response.text()}`);
      }
      const payload = await response.json();
      for (const rawDocument of payload.documents || []) {
        const id = documentIdFromName(rawDocument.name);
        if (!rawDocument.updateTime) throw new Error(`${rawDocument.name}: missing updateTime.`);
        entries.push({
          id,
          rawDocument,
          fields: rawDocument.fields || {},
          contentHash: fieldsContentHash(rawDocument.fields || {}),
          updateTime: rawDocument.updateTime,
        });
      }
      pageToken = payload.nextPageToken || '';
    } while (pageToken);
  } catch (error) {
    try {
      await rollbackTransaction(transaction, accessToken, fetchImplementation);
    } catch (_rollbackError) {
      // Preserve the read failure, which is the actionable cause and already prevents publication.
    }
    throw error;
  }
  await rollbackTransaction(transaction, accessToken, fetchImplementation);

  entries.sort((first, second) => (first.id < second.id ? -1 : first.id > second.id ? 1 : 0));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].id === entries[index].id) {
      throw new Error(`Firestore returned duplicate document id ${JSON.stringify(entries[index].id)}.`);
    }
  }
  return entries;
};

const planChanges = (desiredEntries, existingEntries) => {
  const desiredById = new Map(desiredEntries.map((entry) => [entry.id, entry]));
  const existingById = new Map(existingEntries.map((entry) => [entry.id, entry]));
  const create = [];
  const update = [];
  const unchanged = [];
  const stale = [];

  for (const desired of desiredEntries) {
    const existing = existingById.get(desired.id);
    if (!existing) create.push({ desired });
    else if (existing.contentHash === desired.contentHash) unchanged.push({ desired, existing });
    else update.push({ desired, existing });
  }
  for (const existing of existingEntries) {
    if (!desiredById.has(existing.id)) stale.push({ existing });
  }
  return { create, update, unchanged, stale };
};

const createBackupPayload = (existingEntries, createdAt = new Date().toISOString()) => {
  const documents = [...existingEntries]
    .sort((first, second) => (first.id < second.id ? -1 : first.id > second.id ? 1 : 0))
    .map((entry) => entry.rawDocument);
  return {
    schemaVersion: 1,
    format: 'firestore-rest-v1-documents',
    createdAt,
    projectId: PROJECT_ID,
    databaseId: DATABASE_ID,
    collection: COLLECTION_NAME,
    documentCount: documents.length,
    documentsSha256: sha256(stableStringify(documents)),
    documents,
  };
};

const writeBackupExclusively = (backupPath, payload) => {
  if (fs.existsSync(backupPath)) throw new Error(`Backup already exists; refusing to overwrite it: ${backupPath}`);
  const directory = path.dirname(backupPath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(backupPath)}.tmp-${process.pid}`);
  let temporaryCreated = false;
  try {
    const descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    temporaryCreated = true;
    try {
      fs.writeFileSync(descriptor, `${stableStringify(payload, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.linkSync(temporaryPath, backupPath);
  } finally {
    if (temporaryCreated && fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
};

const buildWrites = (plan, deleteStale) => {
  const writes = [];
  for (const { desired } of plan.create) {
    writes.push({
      operation: 'create',
      id: desired.id,
      write: {
        update: { name: documentName(desired.id), fields: desired.fields },
        currentDocument: { exists: false },
      },
    });
  }
  for (const { desired, existing } of plan.update) {
    writes.push({
      operation: 'update',
      id: desired.id,
      write: {
        update: { name: documentName(desired.id), fields: desired.fields },
        currentDocument: { updateTime: existing.updateTime },
      },
    });
  }
  if (deleteStale) {
    for (const { existing } of plan.stale) {
      writes.push({
        operation: 'delete',
        id: existing.id,
        write: {
          delete: documentName(existing.id),
          currentDocument: { updateTime: existing.updateTime },
        },
      });
    }
  }
  return writes;
};

const commitBatch = async (entries, accessToken, fetchImplementation = fetch) => {
  if (entries.length === 0 || entries.length > BATCH_SIZE) {
    throw new Error(`Commit batches must contain between 1 and ${BATCH_SIZE} writes.`);
  }
  const response = await fetchImplementation(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}`
      + `/databases/${DATABASE_ID}/documents:commit`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ writes: entries.map((entry) => entry.write) }),
    },
  );
  if (!response.ok) {
    throw new Error(`Commit failed: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload.writeResults) || payload.writeResults.length !== entries.length) {
    throw new Error(`Commit returned ${payload.writeResults?.length ?? 0} results for ${entries.length} writes.`);
  }
};

const applyWrites = async (entries, accessToken, fetchImplementation = fetch) => {
  for (let offset = 0; offset < entries.length; offset += BATCH_SIZE) {
    const batch = entries.slice(offset, offset + BATCH_SIZE);
    await commitBatch(batch, accessToken, fetchImplementation);
    console.log(`Applied ${Math.min(offset + batch.length, entries.length)}/${entries.length} writes.`);
  }
};

const firestoreString = (fields, fieldName) => {
  const value = fields?.[fieldName];
  return value && Object.prototype.hasOwnProperty.call(value, 'stringValue')
    ? value.stringValue
    : undefined;
};

const firestoreTopicId = (fields) => {
  const value = fields?.topicId;
  if (!value) return undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'stringValue')) return value.stringValue;
  if (Object.prototype.hasOwnProperty.call(value, 'integerValue')) return Number(value.integerValue);
  if (Object.prototype.hasOwnProperty.call(value, 'doubleValue')) return Number(value.doubleValue);
  return undefined;
};

const verifyPublishedCollection = (desiredEntries, actualEntries) => {
  const desiredById = new Map(desiredEntries.map((entry) => [entry.id, entry]));
  const actualById = new Map(actualEntries.map((entry) => [entry.id, entry]));
  const missing = desiredEntries.filter((entry) => !actualById.has(entry.id)).map((entry) => entry.id);
  const unexpected = actualEntries.filter((entry) => !desiredById.has(entry.id)).map((entry) => entry.id);
  const changed = desiredEntries
    .filter((entry) => actualById.get(entry.id)?.contentHash !== entry.contentHash)
    .map((entry) => entry.id);

  if (missing.length || unexpected.length || changed.length) {
    throw new Error(
      `Verification failed: ${missing.length} missing, ${unexpected.length} unexpected, ${changed.length} content mismatch.`,
    );
  }

  const liveTopicDocuments = actualEntries.map((entry) => ({
    id: entry.id,
    group: firestoreString(entry.fields, 'group'),
    topicName: firestoreString(entry.fields, 'topicName'),
    topicId: firestoreTopicId(entry.fields),
  }));
  validateTopicIdentityConsistency(liveTopicDocuments, `Firestore ${COLLECTION_NAME}`);

  const desiredHash = collectionContentHash(desiredEntries);
  const actualHash = collectionContentHash(actualEntries);
  if (desiredHash !== actualHash) throw new Error('Verification failed: collection content hash mismatch.');
  return { documentCount: actualEntries.length, contentHash: actualHash };
};

const formatSample = (items) => {
  const ids = items.slice(0, 5).map((item) => item.desired?.id || item.existing?.id);
  return ids.length ? ` (${ids.join(', ')}${items.length > ids.length ? ', …' : ''})` : '';
};

const logPlan = (plan, desiredEntries, existingEntries) => {
  console.log(`Target: ${PROJECT_ID} / ${DATABASE_ID} / ${COLLECTION_NAME}`);
  console.log(`Desired documents: ${desiredEntries.length}; current documents: ${existingEntries.length}`);
  console.log(`Create: ${plan.create.length}${formatSample(plan.create)}`);
  console.log(`Update: ${plan.update.length}${formatSample(plan.update)}`);
  console.log(`Unchanged: ${plan.unchanged.length}`);
  console.log(`Stale: ${plan.stale.length}${formatSample(plan.stale)}`);
  console.log(`Desired content hash: ${collectionContentHash(desiredEntries)}`);
};

const main = async () => {
  const options = readArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }

  const desiredEntries = loadDesiredDocuments(options.input);
  console.log(`Loaded and validated ${desiredEntries.length} named-topic documents from ${options.input}.`);
  const accessToken = await getAccessToken();
  const existingEntries = await fetchCurrentDocuments(accessToken);
  const plan = planChanges(desiredEntries, existingEntries);
  logPlan(plan, desiredEntries, existingEntries);

  if (!options.apply) {
    console.log('Dry run complete; no writes or backup were made.');
    if (plan.stale.length && !options.deleteStale) {
      console.log('A future apply will refuse this plan unless --delete-stale is explicitly supplied.');
    }
    return;
  }

  if (plan.stale.length > 0 && !options.deleteStale) {
    throw new Error(
      `${plan.stale.length} stale document(s) exist. Refusing to apply without --delete-stale.`,
    );
  }

  const backupPayload = createBackupPayload(existingEntries);
  writeBackupExclusively(options.backup, backupPayload);
  console.log(`Backed up ${existingEntries.length} exact Firestore documents to ${options.backup}.`);

  const writes = buildWrites(plan, options.deleteStale);
  if (writes.length > 0) await applyWrites(writes, accessToken);
  else console.log('No document writes were necessary.');

  const verifiedEntries = await fetchCurrentDocuments(accessToken);
  const verification = verifyPublishedCollection(desiredEntries, verifiedEntries);
  console.log(
    `Verified ${verification.documentCount} exact documents with content hash ${verification.contentHash}.`,
  );
  console.log('BERT topic publication complete.');
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    console.error(usage);
    process.exitCode = 1;
  });
}

module.exports = {
  BATCH_SIZE,
  COLLECTION_NAME,
  DATABASE_ID,
  DEFAULT_INPUT,
  LOWERCASE_SHA256,
  PLACEHOLDER_TOPIC,
  PROJECT_ID,
  applyWrites,
  buildWrites,
  collectionContentHash,
  createBackupPayload,
  documentName,
  fetchCurrentDocuments,
  fieldsContentHash,
  firestoreValue,
  loadDesiredDocuments,
  normalizeFirestoreFields,
  planChanges,
  readArguments,
  stableStringify,
  toFields,
  validateTopicFields,
  validateTopicIdentityConsistency,
  validateDatasetMetadata,
  verifyPublishedCollection,
  writeBackupExclusively,
};
