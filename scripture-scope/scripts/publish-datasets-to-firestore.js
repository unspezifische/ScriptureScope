#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const APP_ROOT = path.resolve(__dirname, '..');
const PROJECT_ID = 'scripturescope-71f88';
const DATASET_IDS = [
  'lda_jsd_mutual_knn_v1',
  'tfidf_cosine_mutual_knn_v1',
];
const BATCH_SIZE = 200;
const shouldApply = process.argv.includes('--apply');

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const loadFirebaseTools = () => {
  const globalModules = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  const firebaseExecutable = execFileSync('which', ['firebase'], { encoding: 'utf8' }).trim();
  const executableTarget = fs.realpathSync(firebaseExecutable);
  const candidates = [
    path.join(globalModules, 'firebase-tools'),
    path.resolve(path.dirname(executableTarget), '..', '..'),
  ];
  const toolsRoot = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'lib', 'auth.js')));
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
  if (!account) {
    throw new Error('Firebase CLI is not signed in. Run `firebase login` first.');
  }
  auth.setActiveAccount({ project: PROJECT_ID }, account);
  return apiv2.getAccessToken();
};

const firestoreValue = (value) => {
  if (value === null || value === undefined) return { nullValue: null };
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
  if (typeof value === 'object') {
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

const encodeDocumentId = (id) => encodeURIComponent(String(id));

const linkDocumentId = (link) => crypto
  .createHash('sha256')
  .update(JSON.stringify([String(link.source), String(link.target)]))
  .digest('hex');

const collectionUrl = (collectionName) => (
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}`
  + `/databases/(default)/documents/${collectionName}`
);

const getExistingIds = async (collectionName, accessToken) => {
  const ids = new Set();
  let pageToken = '';
  do {
    const url = new URL(collectionUrl(collectionName));
    url.searchParams.set('pageSize', '1000');
    url.searchParams.set('mask.fieldPaths', '__name__');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Unable to inspect ${collectionName}: ${response.status} ${await response.text()}`);
    }
    const payload = await response.json();
    for (const document of payload.documents || []) {
      ids.add(decodeURIComponent(document.name.split('/').pop()));
    }
    pageToken = payload.nextPageToken || '';
  } while (pageToken);
  return ids;
};

const writeBatch = async (collectionName, entries, accessToken) => {
  const writes = entries.map(({ id, data }) => ({
    update: {
      name: `projects/${PROJECT_ID}/databases/(default)/documents/${collectionName}/${encodeDocumentId(id)}`,
      fields: toFields(data),
    },
    currentDocument: { exists: false },
  }));
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:batchWrite`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ writes }),
    },
  );
  if (!response.ok) {
    throw new Error(`Write request failed for ${collectionName}: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json();
  const failures = (payload.status || []).filter((status) => status.code && status.code !== 0);
  if (failures.length > 0) {
    throw new Error(`Firestore rejected ${failures.length} writes in ${collectionName}: ${JSON.stringify(failures.slice(0, 3))}`);
  }
};

const publishCollection = async (collectionName, entries, accessToken) => {
  const existingIds = await getExistingIds(collectionName, accessToken);
  const expectedIds = new Set(entries.map(({ id }) => String(id)));
  const unexpected = [...existingIds].filter((id) => !expectedIds.has(id));
  if (unexpected.length > 0) {
    throw new Error(
      `${collectionName} contains ${unexpected.length} unexpected document(s); refusing to modify it.`,
    );
  }
  const missing = entries.filter(({ id }) => !existingIds.has(String(id)));
  console.log(`${collectionName}: ${existingIds.size} existing, ${missing.length} to create`);
  if (!shouldApply) return;

  for (let offset = 0; offset < missing.length; offset += BATCH_SIZE) {
    await writeBatch(collectionName, missing.slice(offset, offset + BATCH_SIZE), accessToken);
    const completed = Math.min(offset + BATCH_SIZE, missing.length);
    console.log(`${collectionName}: created ${completed}/${missing.length}`);
  }

  const finalIds = await getExistingIds(collectionName, accessToken);
  if (finalIds.size !== entries.length) {
    throw new Error(`${collectionName}: expected ${entries.length} documents, found ${finalIds.size}`);
  }
  console.log(`${collectionName}: verified ${finalIds.size} documents`);
};

const main = async () => {
  const datasets = DATASET_IDS.map((id) => {
    const directory = path.join(PROJECT_ROOT, 'datasets', id);
    const metadata = readJson(path.join(directory, 'metadata.json'));
    if (metadata.id !== id || !metadata.description?.trim() || !metadata.calculation?.trim()) {
      throw new Error(`${id}: metadata must contain a matching id, description, and calculation`);
    }
    return {
      id,
      nodes: readJson(path.join(directory, 'nodes.json')),
      links: readJson(path.join(directory, 'links.json')),
    };
  });

  console.log(`${shouldApply ? 'Publishing' : 'Dry run for'} ${datasets.length} validated datasets to ${PROJECT_ID}`);
  const accessToken = await getAccessToken();
  for (const dataset of datasets) {
    await publishCollection(
      `nodes_${dataset.id}`,
      dataset.nodes.map((node) => ({ id: node.id, data: node })),
      accessToken,
    );
    await publishCollection(
      `links_${dataset.id}`,
      dataset.links.map((link) => ({ id: linkDocumentId(link), data: link })),
      accessToken,
    );
  }
  console.log(shouldApply ? 'Firebase publication complete.' : 'Dry run complete; pass --apply to publish.');
};

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
