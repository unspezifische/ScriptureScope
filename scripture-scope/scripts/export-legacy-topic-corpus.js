const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { initializeApp, deleteApp } = require('firebase/app');
const {
  collection,
  getCountFromServer,
  getDocsFromServer,
  getFirestore,
} = require('firebase/firestore');
const { normalizeDistribution } = require('./lib/topic-links');

const usage = `Export the live legacy LDA corpus with controlled DrL coordinates.

Usage:
  npm run data:export-legacy-topic-corpus -- --output <nodes.json> [options]

Options:
  --allow-rejected <number>  Expected maximum malformed records (default: 0)
  --report <path>            Export diagnostics path (default: export-report.json beside output)
  --force                    Replace existing output and report files
  --help                     Show this message
`;

const readArguments = (argumentsList) => {
  const options = { allowRejected: 0, force: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--help') options.help = true;
    else if (argument === '--force') options.force = true;
    else if (argument === '--output') options.output = argumentsList[++index];
    else if (argument === '--report') options.report = argumentsList[++index];
    else if (argument === '--allow-rejected') options.allowRejected = Number(argumentsList[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
};

const requireEnvironment = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in scripture-scope/.env.`);
  return value;
};

const writeJsonAtomically = (filePath, value, force) => {
  if (fs.existsSync(filePath) && !force) {
    throw new Error(`Output already exists: ${filePath}. Pass --force to replace it.`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
};

const fetchCollection = async (database, collectionName) => {
  const reference = collection(database, collectionName);
  const [countSnapshot, documentSnapshot] = await Promise.all([
    getCountFromServer(reference),
    getDocsFromServer(reference),
  ]);
  const expectedCount = countSnapshot.data().count;
  if (expectedCount !== documentSnapshot.size) {
    throw new Error(
      `${collectionName} changed during export: count reported ${expectedCount}, fetched ${documentSnapshot.size}.`,
    );
  }
  return documentSnapshot.docs.map((document) => {
    const data = document.data();
    return { ...data, id: data.id ?? document.id, firestoreDocumentId: document.id };
  });
};

const compareIds = (first, second) => (
  first.id < second.id ? -1 : first.id > second.id ? 1 : 0
);

const main = async () => {
  const options = readArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  if (!options.output) throw new Error('--output is required.');
  if (!Number.isInteger(options.allowRejected) || options.allowRejected < 0) {
    throw new Error('--allow-rejected must be a nonnegative integer.');
  }

  const outputPath = path.resolve(options.output);
  const reportPath = path.resolve(
    options.report || path.join(path.dirname(outputPath), 'export-report.json'),
  );
  for (const candidatePath of [outputPath, reportPath]) {
    if (fs.existsSync(candidatePath) && !options.force) {
      throw new Error(`Output already exists: ${candidatePath}. Pass --force to replace it.`);
    }
  }

  dotenv.config({ path: path.resolve(__dirname, '../.env') });
  const firebaseApp = initializeApp({
    apiKey: requireEnvironment('REACT_APP_FIREBASE_API_KEY'),
    authDomain: requireEnvironment('REACT_APP_FIREBASE_AUTH_DOMAIN'),
    projectId: requireEnvironment('REACT_APP_FIREBASE_PROJECT_ID'),
  }, `scripturescope-export-${Date.now()}`);

  try {
    const database = getFirestore(firebaseApp);
    const [topicRecords, layoutRecords] = await Promise.all([
      fetchCollection(database, 'nodes_Gensim'),
      fetchCollection(database, 'nodes_DrL'),
    ]);
    const layoutById = new Map(layoutRecords.map((record) => [String(record.id).trim(), record]));
    const nodes = [];
    const rejectedRecords = [];

    topicRecords.forEach((record) => {
      const id = record.id === null || record.id === undefined ? '' : String(record.id).trim();
      const text = typeof record.text === 'string' ? record.text.trim() : '';
      const topicDistribution = normalizeDistribution(record.topic_distribution);
      const layout = layoutById.get(id);
      let reason = '';

      if (!id) reason = 'missing-id';
      else if (!text) reason = 'missing-text';
      else if (!topicDistribution || topicDistribution.length !== 10) reason = 'invalid-ten-topic-distribution';
      else if (!layout) reason = 'missing-layout-record';
      else if (!Number.isFinite(Number(layout.x)) || !Number.isFinite(Number(layout.y))) {
        reason = 'invalid-layout-coordinates';
      }

      if (reason) {
        rejectedRecords.push({
          firestoreDocumentId: record.firestoreDocumentId,
          id,
          reason,
        });
        return;
      }

      const dominantTopic = topicDistribution.reduce(
        (bestIndex, value, index) => (value > topicDistribution[bestIndex] ? index : bestIndex),
        0,
      );
      nodes.push({
        id,
        text,
        group: String(layout.group ?? `Topic ${dominantTopic + 1}`),
        x: Number(layout.x),
        y: Number(layout.y),
        topic_distribution: topicDistribution.map((value) => Number(value.toPrecision(15))),
        topic_words: typeof record.topic_words === 'string' ? record.topic_words.trim() : '',
      });
    });

    if (rejectedRecords.length > options.allowRejected) {
      throw new Error(
        `Rejected ${rejectedRecords.length} records, exceeding --allow-rejected ${options.allowRejected}.`,
      );
    }

    nodes.sort(compareIds);
    const generatedAt = new Date().toISOString();
    const report = {
      generatedAt,
      projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
      sources: {
        representation: 'nodes_Gensim',
        controlledLayout: 'nodes_DrL',
      },
      inputTopicNodeCount: topicRecords.length,
      inputLayoutNodeCount: layoutRecords.length,
      exportedNodeCount: nodes.length,
      rejectedNodeCount: rejectedRecords.length,
      rejectedRecords,
      topicDimensions: 10,
      layoutHeldConstantForComparison: true,
    };

    writeJsonAtomically(outputPath, nodes, options.force);
    writeJsonAtomically(reportPath, report, options.force);
    console.log(`Exported ${nodes.length.toLocaleString()} nodes to ${outputPath}`);
    console.log(`Wrote export diagnostics to ${reportPath}`);
    if (rejectedRecords.length > 0) {
      console.warn(`Rejected ${rejectedRecords.length.toLocaleString()} malformed record(s).`);
    }
  } finally {
    await deleteApp(firebaseApp);
  }
};

main().catch((error) => {
  console.error(error.message);
  console.error(usage);
  process.exitCode = 1;
});

