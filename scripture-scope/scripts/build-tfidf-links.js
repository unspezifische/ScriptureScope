const fs = require('fs');
const path = require('path');
const { buildTfidfLinks } = require('./lib/tfidf-links');

const usage = `Generate canonical mutual-kNN TF-IDF lexical links.

Usage:
  npm run model:tfidf-links -- --input <nodes.json> --output <links.json> [options]

Options:
  --k <number>              Nearest neighbors considered per passage (default: 10)
  --min-df <number>         Minimum document frequency for a term (default: 2)
  --max-df-ratio <number>   Maximum document-frequency ratio (default: 0.8)
  --report <path>           Write generation statistics and rejected-node details
  --force                   Replace existing output and report files
  --help                    Show this message
`;

const readArguments = (argumentsList) => {
  const options = { force: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--help') options.help = true;
    else if (argument === '--force') options.force = true;
    else if (argument === '--input') options.input = argumentsList[++index];
    else if (argument === '--output') options.output = argumentsList[++index];
    else if (argument === '--report') options.report = argumentsList[++index];
    else if (argument === '--k') options.k = Number(argumentsList[++index]);
    else if (argument === '--min-df') options.minimumDocumentFrequency = Number(argumentsList[++index]);
    else if (argument === '--max-df-ratio') options.maximumDocumentFrequencyRatio = Number(argumentsList[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
};

const writeJson = (filePath, value, force) => {
  if (fs.existsSync(filePath) && !force) {
    throw new Error(`Output already exists: ${filePath}. Pass --force to replace it.`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const main = () => {
  const options = readArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  if (!options.input || !options.output) throw new Error('--input and --output are required.');
  const inputPath = path.resolve(options.input);
  const outputPath = path.resolve(options.output);
  const reportPath = options.report ? path.resolve(options.report) : null;
  if (!fs.existsSync(inputPath)) throw new Error(`Input file does not exist: ${inputPath}`);
  if (reportPath && fs.existsSync(reportPath) && !options.force) {
    throw new Error(`Report file already exists: ${reportPath}. Pass --force to replace it.`);
  }

  const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const nodes = Array.isArray(payload) ? payload : payload.nodes;
  const result = buildTfidfLinks(nodes, options);
  writeJson(outputPath, result.links, options.force);
  if (reportPath) {
    writeJson(reportPath, {
      generatedAt: new Date().toISOString(),
      representation: 'sublinear-tf-idf-l2',
      metric: 'cosine-similarity',
      linkRule: 'mutual-knn',
      stats: result.stats,
      rejectedNodes: result.rejectedNodes,
    }, options.force);
  }

  console.log(`Wrote ${result.stats.mutualLinkCount.toLocaleString()} links to ${outputPath}`);
  if (reportPath) console.log(`Wrote generation report to ${reportPath}`);
  console.log(JSON.stringify(result.stats, null, 2));
};

try {
  main();
} catch (error) {
  console.error(error.message);
  console.error(usage);
  process.exitCode = 1;
}

