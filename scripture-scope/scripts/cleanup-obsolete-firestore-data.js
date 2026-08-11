#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP_ROOT = path.resolve(__dirname, '..');
const PROJECT_ID = 'scripturescope-71f88';
const DATABASE_ID = '(default)';
const BATCH_SIZE = 500;
const CONCURRENT_BATCHES = 4;
const apply = process.argv.includes('--apply');
const requestedCollections = [];

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === '--apply') continue;
  if (argument === '--collection') {
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--collection requires a collection name');
    requestedCollections.push(value);
    index += 1;
    continue;
  }
  throw new Error(`Unknown argument: ${argument}`);
}

const loadFirebaseTools = () => {
  const globalModules = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  const firebaseExecutable = execFileSync('which', ['firebase'], { encoding: 'utf8' }).trim();
  const executableTarget = fs.realpathSync(firebaseExecutable);
  const candidates = [
    path.join(globalModules, 'firebase-tools'),
    path.resolve(path.dirname(executableTarget), '..', '..'),
  ];
  const toolsRoot = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'lib', 'auth.js')));
  if (!toolsRoot) throw new Error('Firebase CLI is not installed globally.');
  return {
    auth: require(path.join(toolsRoot, 'lib', 'auth.js')),
    apiv2: require(path.join(toolsRoot, 'lib', 'apiv2.js')),
  };
};

const getAccessToken = async () => {
  const { auth, apiv2 } = loadFirebaseTools();
  const account = auth.getProjectDefaultAccount(APP_ROOT) || auth.getGlobalDefaultAccount();
  if (!account) throw new Error('Firebase CLI is not signed in.');
  auth.setActiveAccount({ project: PROJECT_ID }, account);
  return apiv2.getAccessToken();
};

const documentsRoot = (
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}`
  + `/databases/${encodeURIComponent(DATABASE_ID)}/documents`
);

const listRootCollections = async (accessToken) => {
  const collectionIds = [];
  let pageToken = '';
  do {
    const response = await fetch(`${documentsRoot}:listCollectionIds`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageSize: 1000, ...(pageToken ? { pageToken } : {}) }),
    });
    if (!response.ok) throw new Error(`Unable to list collections: ${response.status} ${await response.text()}`);
    const payload = await response.json();
    collectionIds.push(...(payload.collectionIds || []));
    pageToken = payload.nextPageToken || '';
  } while (pageToken);
  return collectionIds.sort();
};

const listDocumentNames = async (collectionName, accessToken) => {
  const names = [];
  let pageToken = '';
  do {
    const url = new URL(`${documentsRoot}/${encodeURIComponent(collectionName)}`);
    url.searchParams.set('pageSize', '1000');
    url.searchParams.set('mask.fieldPaths', '__name__');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error(`Unable to inspect ${collectionName}: ${response.status} ${await response.text()}`);
    const payload = await response.json();
    names.push(...(payload.documents || []).map((document) => document.name));
    pageToken = payload.nextPageToken || '';
  } while (pageToken);
  return names;
};

const deleteBatch = async (names, accessToken) => {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${encodeURIComponent(DATABASE_ID)}/documents:batchWrite`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes: names.map((name) => ({ delete: name, currentDocument: { exists: true } })) }),
    },
  );
  if (!response.ok) throw new Error(`Delete batch failed: ${response.status} ${await response.text()}`);
  const payload = await response.json();
  const failures = (payload.status || []).filter((status) => status.code && status.code !== 0);
  if (failures.length) throw new Error(`Firestore rejected ${failures.length} deletes: ${JSON.stringify(failures.slice(0, 3))}`);
};

const deleteCollectionDocuments = async (collectionName, names, accessToken) => {
  const waveSize = BATCH_SIZE * CONCURRENT_BATCHES;
  for (let offset = 0; offset < names.length; offset += waveSize) {
    const wave = [];
    for (let batchOffset = offset; batchOffset < Math.min(offset + waveSize, names.length); batchOffset += BATCH_SIZE) {
      wave.push(deleteBatch(names.slice(batchOffset, batchOffset + BATCH_SIZE), accessToken));
    }
    await Promise.all(wave);
    console.log(`${collectionName}: deleted ${Math.min(offset + waveSize, names.length)}/${names.length}`);
  }
};

const main = async () => {
  const accessToken = await getAccessToken();
  const liveCollections = await listRootCollections(accessToken);
  if (requestedCollections.length === 0) {
    console.log(`Root collection inventory for ${PROJECT_ID}:`);
    for (const collectionName of liveCollections) {
      const names = await listDocumentNames(collectionName, accessToken);
      console.log(`${collectionName}: ${names.length} documents`);
    }
    console.log('Inventory only. Pass one or more exact --collection names to create a deletion plan.');
    return;
  }

  const uniqueTargets = [...new Set(requestedCollections)];
  const missing = uniqueTargets.filter((collectionName) => !liveCollections.includes(collectionName));
  for (const collectionName of missing) {
    console.log(`${collectionName}: already absent (treated as empty)`);
  }
  const plans = [];
  for (const collectionName of uniqueTargets.filter((name) => liveCollections.includes(name))) {
    if (!/^(nodes|links)(_|$)/.test(collectionName)) {
      throw new Error(`Refusing non-graph collection: ${collectionName}`);
    }
    const names = await listDocumentNames(collectionName, accessToken);
    plans.push({ collectionName, names });
    console.log(`${collectionName}: ${names.length} documents to delete`);
  }
  if (!apply) {
    console.log('Dry run complete; pass --apply with the same exact collection names to delete them.');
    return;
  }
  for (const plan of plans) {
    await deleteCollectionDocuments(plan.collectionName, plan.names, accessToken);
    const remaining = await listDocumentNames(plan.collectionName, accessToken);
    if (remaining.length) throw new Error(`${plan.collectionName}: ${remaining.length} documents remain`);
    console.log(`${plan.collectionName}: verified empty`);
  }
  console.log('Obsolete graph data cleanup complete.');
};

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
