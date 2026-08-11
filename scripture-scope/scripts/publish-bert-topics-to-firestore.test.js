const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_INPUT,
  applyWrites,
  buildWrites,
  collectionContentHash,
  createBackupPayload,
  documentName,
  fetchCurrentDocuments,
  fieldsContentHash,
  loadDesiredDocuments,
  planChanges,
  readArguments,
  stableStringify,
  toFields,
  validateTopicFields,
  validateTopicIdentityConsistency,
  verifyPublishedCollection,
  writeBackupExclusively,
} = require('./publish-bert-topics-to-firestore');

const node = (id, overrides = {}) => ({
  id,
  text: `Passage ${id}`,
  group: 'Grace and Redemption',
  topicName: 'Grace and Redemption',
  topicId: 7,
  topic_distribution: [0.1, 0.9],
  ...overrides,
});

const sha256Bytes = (value) => crypto.createHash('sha256').update(value).digest('hex');

const writeDatasetFixture = (
  root,
  name,
  nodes,
  { metadataOverrides = {}, writeMetadata = true } = {},
) => {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  const nodesPath = path.join(directory, 'nodes.json');
  const nodesBytes = Buffer.from(JSON.stringify(nodes));
  fs.writeFileSync(nodesPath, nodesBytes);

  const baseMetadata = {
    topicModel: {
      labelStatus: 'reviewed',
      labelOverridesSha256: 'a'.repeat(64),
    },
    artifacts: {
      nodesSha256: sha256Bytes(nodesBytes),
    },
  };
  const metadata = {
    ...baseMetadata,
    ...metadataOverrides,
    topicModel: {
      ...baseMetadata.topicModel,
      ...(metadataOverrides.topicModel || {}),
    },
    artifacts: {
      ...baseMetadata.artifacts,
      ...(metadataOverrides.artifacts || {}),
    },
  };
  const metadataPath = path.join(directory, 'metadata.json');
  if (writeMetadata) fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  return { metadataPath, nodesPath };
};

const desiredEntry = (data) => {
  const fields = toFields(data);
  return { id: data.id, data, fields, contentHash: fieldsContentHash(fields) };
};

const existingEntry = (data, updateTime = '2026-08-06T12:00:00.000000Z') => {
  const fields = toFields(data);
  return {
    id: data.id,
    fields,
    contentHash: fieldsContentHash(fields),
    updateTime,
    rawDocument: {
      name: documentName(data.id),
      fields,
      createTime: '2026-08-05T12:00:00.000000Z',
      updateTime,
    },
  };
};

test('arguments default to a dry run and require an explicit backup for apply', () => {
  const defaults = readArguments([]);
  assert.equal(defaults.apply, false);
  assert.equal(defaults.deleteStale, false);
  assert.equal(defaults.input, DEFAULT_INPUT);
  assert.equal(defaults.backup, null);

  assert.throws(
    () => readArguments(['--apply']),
    /--backup <path> is required/,
  );

  const options = readArguments(
    ['--apply', '--delete-stale', '--backup', 'backups/bert.json', '--input', 'nodes.json'],
    '/workspace',
  );
  assert.equal(options.apply, true);
  assert.equal(options.deleteStale, true);
  assert.equal(options.backup, '/workspace/backups/bert.json');
  assert.equal(options.input, '/workspace/nodes.json');
});

test('topic fields require matching real names and a topic id', () => {
  assert.doesNotThrow(() => validateTopicFields(node('John 3:16'), 'node'));
  assert.throws(
    () => validateTopicFields(node('John 3:16', { group: 'Topic 3', topicName: 'Topic 3' }), 'node'),
    /placeholder/,
  );
  assert.throws(
    () => validateTopicFields(node('John 3:16', { group: 'topic   3', topicName: 'topic   3' }), 'node'),
    /placeholder/,
  );
  assert.throws(
    () => validateTopicFields(node('John 3:16', { topicName: 'Redemption' }), 'node'),
    /must be identical/,
  );
  assert.throws(
    () => validateTopicFields(node('John 3:16', { topicId: '' }), 'node'),
    /topicId/,
  );
});

test('topic ids and names form a one-to-one mapping across documents', () => {
  assert.doesNotThrow(() => validateTopicIdentityConsistency([
    node('A', { topicId: 1, group: 'Creation', topicName: 'Creation' }),
    node('B', { topicId: 2, group: 'Covenant', topicName: 'Covenant' }),
  ], 'nodes'));
  assert.throws(() => validateTopicIdentityConsistency([
    node('A', { topicId: 1, group: 'Creation', topicName: 'Creation' }),
    node('B', { topicId: 1, group: 'Covenant', topicName: 'Covenant' }),
  ], 'nodes'), /topicId.*maps to both/);
  assert.throws(() => validateTopicIdentityConsistency([
    node('A', { topicId: 1, group: 'Creation', topicName: 'Creation' }),
    node('B', { topicId: 2, group: 'Creation', topicName: 'Creation' }),
  ], 'nodes'), /topicName.*maps to both/);
});

test('dataset loading rejects duplicate ids and generic topic names', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'bert-publisher-test-'));
  try {
    const duplicate = writeDatasetFixture(temporaryDirectory, 'duplicates', [node('A'), node('A')]);
    assert.throws(() => loadDesiredDocuments(duplicate.nodesPath), /duplicate id/);

    const generic = writeDatasetFixture(
      temporaryDirectory,
      'generic',
      [node('A', { group: 'Topic 1', topicName: 'Topic 1' })],
    );
    assert.throws(() => loadDesiredDocuments(generic.nodesPath), /placeholder/);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true });
  }
});

test('dataset loading requires reviewed metadata and exact nodes bytes', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'bert-metadata-test-'));
  try {
    const valid = writeDatasetFixture(temporaryDirectory, 'valid', [node('A')]);
    assert.equal(loadDesiredDocuments(valid.nodesPath).length, 1);

    const missing = writeDatasetFixture(
      temporaryDirectory,
      'missing',
      [node('A')],
      { writeMetadata: false },
    );
    assert.throws(() => loadDesiredDocuments(missing.nodesPath), /required sibling metadata/);

    const draft = writeDatasetFixture(
      temporaryDirectory,
      'draft',
      [node('A')],
      { metadataOverrides: { topicModel: { labelStatus: 'draft' } } },
    );
    assert.throws(() => loadDesiredDocuments(draft.nodesPath), /labelStatus must be "reviewed"/);

    const invalidOverrides = writeDatasetFixture(
      temporaryDirectory,
      'invalid-overrides',
      [node('A')],
      { metadataOverrides: { topicModel: { labelOverridesSha256: 'A'.repeat(64) } } },
    );
    assert.throws(
      () => loadDesiredDocuments(invalidOverrides.nodesPath),
      /labelOverridesSha256 must be a lowercase SHA-256/,
    );

    const tampered = writeDatasetFixture(temporaryDirectory, 'tampered', [node('A')]);
    fs.appendFileSync(tampered.nodesPath, '\n');
    assert.throws(
      () => loadDesiredDocuments(tampered.nodesPath),
      /nodesSha256 does not match the exact bytes/,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true });
  }
});

test('change planning separates create, update, unchanged, and stale documents', () => {
  const unchanged = node('A');
  const changed = node('B');
  const desired = [
    desiredEntry(unchanged),
    desiredEntry(changed),
    desiredEntry(node('C')),
  ];
  const existing = [
    existingEntry(unchanged),
    existingEntry({ ...changed, topicId: 2 }),
    existingEntry(node('D')),
  ];

  const plan = planChanges(desired, existing);
  assert.deepEqual(plan.create.map((item) => item.desired.id), ['C']);
  assert.deepEqual(plan.update.map((item) => item.desired.id), ['B']);
  assert.deepEqual(plan.unchanged.map((item) => item.desired.id), ['A']);
  assert.deepEqual(plan.stale.map((item) => item.existing.id), ['D']);
});

test('paginated reads use one read-only transaction and return a sorted snapshot', async () => {
  const calls = [];
  const first = existingEntry(node('A')).rawDocument;
  const second = existingEntry(node('B')).rawDocument;
  const fetchImplementation = async (url, options = {}) => {
    const urlString = String(url);
    calls.push({ url: urlString, options });
    if (urlString.endsWith(':beginTransaction')) {
      return { ok: true, json: async () => ({ transaction: 'snapshot-token' }) };
    }
    if (urlString.endsWith(':rollback')) {
      assert.deepEqual(JSON.parse(options.body), { transaction: 'snapshot-token' });
      return { ok: true };
    }

    const parsedUrl = new URL(urlString);
    assert.equal(parsedUrl.searchParams.get('transaction'), 'snapshot-token');
    if (!parsedUrl.searchParams.has('pageToken')) {
      return { ok: true, json: async () => ({ documents: [second], nextPageToken: 'next' }) };
    }
    assert.equal(parsedUrl.searchParams.get('pageToken'), 'next');
    return { ok: true, json: async () => ({ documents: [first] }) };
  };

  const entries = await fetchCurrentDocuments('test-token', fetchImplementation);
  assert.deepEqual(entries.map((entry) => entry.id), ['A', 'B']);
  assert.equal(calls.length, 4);
  assert.match(calls[0].url, /:beginTransaction$/);
  assert.match(calls[3].url, /:rollback$/);
});

test('writes replace content and use existence/update-time preconditions', () => {
  const desired = [desiredEntry(node('A')), desiredEntry(node('B'))];
  const existing = [
    existingEntry(node('B', { topicId: 2 }), '2026-08-06T12:01:00.000000Z'),
    existingEntry(node('C'), '2026-08-06T12:02:00.000000Z'),
  ];
  const plan = planChanges(desired, existing);

  const withoutDeletes = buildWrites(plan, false);
  assert.deepEqual(withoutDeletes.map((entry) => entry.operation), ['create', 'update']);
  assert.deepEqual(withoutDeletes[0].write.currentDocument, { exists: false });
  assert.deepEqual(withoutDeletes[1].write.currentDocument, {
    updateTime: '2026-08-06T12:01:00.000000Z',
  });
  assert.equal(Object.hasOwn(withoutDeletes[1].write, 'updateMask'), false);
  assert.equal(Object.hasOwn(withoutDeletes[1].write.update, 'updateMask'), false);

  const withDeletes = buildWrites(plan, true);
  assert.deepEqual(withDeletes.map((entry) => entry.operation), ['create', 'update', 'delete']);
  assert.deepEqual(withDeletes[2].write, {
    delete: documentName('C'),
    currentDocument: { updateTime: '2026-08-06T12:02:00.000000Z' },
  });
});

test('apply splits commits into batches no larger than 200', async () => {
  const entries = Array.from({ length: 401 }, (_, index) => ({
    operation: 'create',
    id: String(index),
    write: { update: { name: documentName(String(index)), fields: {} } },
  }));
  const batchSizes = [];
  const fetchImplementation = async (_url, options) => {
    const body = JSON.parse(options.body);
    batchSizes.push(body.writes.length);
    return {
      ok: true,
      json: async () => ({ writeResults: body.writes.map(() => ({})) }),
    };
  };

  await applyWrites(entries, 'test-token', fetchImplementation);
  assert.deepEqual(batchSizes, [200, 200, 1]);
});

test('backup payload is sorted and preserves raw Firestore documents', () => {
  const first = existingEntry(node('A'));
  const second = existingEntry(node('B'));
  const payload = createBackupPayload([second, first], '2026-08-06T13:00:00.000Z');
  assert.deepEqual(payload.documents.map((document) => document.name), [
    documentName('A'),
    documentName('B'),
  ]);
  assert.match(stableStringify(payload, 2), /"documents"/);
  assert.deepEqual(payload.documents[0], first.rawDocument);
});

test('backup writing is exact and refuses to overwrite an existing backup', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'bert-backup-test-'));
  const backupPath = path.join(temporaryDirectory, 'nested', 'nodes_BERT.json');
  const payload = createBackupPayload([existingEntry(node('B')), existingEntry(node('A'))], 'fixed');
  try {
    writeBackupExclusively(backupPath, payload);
    const expected = `${stableStringify(payload, 2)}\n`;
    assert.equal(fs.readFileSync(backupPath, 'utf8'), expected);
    assert.throws(() => writeBackupExclusively(backupPath, payload), /refusing to overwrite/);
    assert.equal(fs.readFileSync(backupPath, 'utf8'), expected);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true });
  }
});

test('verification requires exact ids, exact content, and valid live names', () => {
  const desired = [desiredEntry(node('A')), desiredEntry(node('B'))];
  const actual = [existingEntry(node('A')), existingEntry(node('B'))];
  const result = verifyPublishedCollection(desired, actual);
  assert.equal(result.documentCount, 2);
  assert.equal(result.contentHash, collectionContentHash(desired));

  assert.throws(
    () => verifyPublishedCollection(desired, [actual[0]]),
    /1 missing/,
  );
  assert.throws(
    () => verifyPublishedCollection(desired, [actual[0], existingEntry(node('B', { topicId: 9 }))]),
    /1 content mismatch/,
  );

  const genericDesired = desiredEntry(node('A', { group: 'Topic 2', topicName: 'Topic 2' }));
  const genericActual = existingEntry(node('A', { group: 'Topic 2', topicName: 'Topic 2' }));
  assert.throws(
    () => verifyPublishedCollection([genericDesired], [genericActual]),
    /placeholder/,
  );
});
