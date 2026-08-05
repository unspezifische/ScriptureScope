const fs = require('fs');
const path = require('path');
const { buildTopicLinks } = require('./lib/topic-links');

const usage = `Generate canonical mutual-kNN topic links.

Usage:
  npm run model:topic-links -- --input <nodes.json> --output <links.json> [options]

Options:
  --k <number>               Nearest neighbors considered per passage (default: 10)
  --max-distance <number>    Maximum Jensen–Shannon distance from 0 to 1 (default: 1)
  --report <path>            Write generation statistics and rejected-node details
  --force                    Replace an existing output file
  --help                     Show this message
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
    else if (argument === '--max-distance') options.maximumDistance = Number(argumentsList[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
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
  if (fs.existsSync(outputPath) && !options.force) {
    throw new Error(`Output file already exists: ${outputPath}. Pass --force to replace it.`);
  }
  if (reportPath && fs.existsSync(reportPath) && !options.force) {
    throw new Error(`Report file already exists: ${reportPath}. Pass --force to replace it.`);
  }

  const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const nodes = Array.isArray(payload) ? payload : payload.nodes;
  const result = buildTopicLinks(nodes, {
    k: options.k,
    maximumDistance: options.maximumDistance,
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result.links, null, 2)}\n`, 'utf8');
  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      metric: 'jensen-shannon-distance-base2-sqrt',
      linkRule: 'mutual-knn',
      stats: result.stats,
      rejectedNodes: result.rejectedNodes,
    }, null, 2)}\n`, 'utf8');
  }

  console.log(`Wrote ${result.stats.mutualLinkCount.toLocaleString()} links to ${outputPath}`);
  if (reportPath) console.log(`Wrote generation report to ${reportPath}`);
  console.log(JSON.stringify(result.stats, null, 2));
  if (result.rejectedNodes.length > 0) {
    console.warn(`Rejected ${result.rejectedNodes.length.toLocaleString()} malformed node record(s).`);
  }
};

try {
  main();
} catch (error) {
  console.error(error.message);
  console.error(usage);
  process.exitCode = 1;
}
