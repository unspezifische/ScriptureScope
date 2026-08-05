const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const datasetRoot = path.resolve(__dirname, '../../datasets');
const errors = [];

const readJson = (filePath, label) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    errors.push(`${label}: ${error.message}`);
    return null;
  }
};

const parseTopicVector = (value) => {
  return Array.isArray(value)
    && value.length >= 2
    && value.every((item) => typeof item === 'number' && Number.isFinite(item));
};

const sha256File = (filePath) => crypto
  .createHash('sha256')
  .update(fs.readFileSync(filePath))
  .digest('hex');

if (!fs.existsSync(datasetRoot)) {
  console.log('No datasets directory found; nothing to validate.');
  process.exit(0);
}

const datasetDirectories = fs.readdirSync(datasetRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

for (const directoryName of datasetDirectories) {
  const directory = path.join(datasetRoot, directoryName);
  const metadataPath = path.join(directory, 'metadata.json');
  const nodesPath = path.join(directory, 'nodes.json');
  const linksPath = path.join(directory, 'links.json');
  const label = `datasets/${directoryName}`;

  for (const requiredPath of [metadataPath, nodesPath, linksPath]) {
    if (!fs.existsSync(requiredPath)) {
      errors.push(`${label}: missing required file ${path.basename(requiredPath)}`);
    }
  }

  if (![metadataPath, nodesPath, linksPath].every(fs.existsSync)) continue;

  const metadata = readJson(metadataPath, `${label}/metadata.json`);
  const nodes = readJson(nodesPath, `${label}/nodes.json`);
  const links = readJson(linksPath, `${label}/links.json`);
  if (!metadata || !nodes || !links) continue;

  const requiredTextFields = [
    'id',
    'displayName',
    'description',
    'calculation',
    'methodType',
    'bibleVersion',
    'corpusVersion',
    'generatedAt',
  ];
  for (const field of requiredTextFields) {
    if (typeof metadata[field] !== 'string' || !metadata[field].trim()) {
      errors.push(`${label}/metadata.json: ${field} is required and must be nonblank`);
    }
  }

  if (typeof metadata.id === 'string') {
    if (!/^[A-Za-z0-9_-]+$/.test(metadata.id)) {
      errors.push(`${label}/metadata.json: id may contain only letters, numbers, underscores, and hyphens`);
    }
    if (metadata.id !== directoryName) {
      errors.push(`${label}/metadata.json: id must exactly match its dataset directory name`);
    }
  }

  if (typeof metadata.description === 'string' && metadata.description.trim().length < 40) {
    errors.push(`${label}/metadata.json: description must contain at least 40 characters`);
  }
  if (typeof metadata.calculation === 'string' && metadata.calculation.trim().length < 40) {
    errors.push(`${label}/metadata.json: calculation must contain at least 40 characters`);
  }
  if (typeof metadata.generatedAt === 'string' && Number.isNaN(Date.parse(metadata.generatedAt))) {
    errors.push(`${label}/metadata.json: generatedAt must be an ISO-8601 date`);
  }

  const requireObjectText = (object, objectName, fields) => {
    if (!object || typeof object !== 'object' || Array.isArray(object)) {
      errors.push(`${label}/metadata.json: ${objectName} is required and must be an object`);
      return false;
    }
    fields.forEach((field) => {
      if (typeof object[field] !== 'string' || !object[field].trim()) {
        errors.push(`${label}/metadata.json: ${objectName}.${field} is required and must be nonblank`);
      }
    });
    return true;
  };

  requireObjectText(metadata.representation, 'representation', ['id', 'version', 'description']);
  requireObjectText(metadata.layout, 'layout', ['id', 'version', 'distanceMeaning']);
  if (!metadata.artifacts || typeof metadata.artifacts !== 'object' || Array.isArray(metadata.artifacts)) {
    errors.push(`${label}/metadata.json: artifacts is required and must contain dataset checksums`);
  } else {
    const artifactChecks = [
      ['nodesSha256', nodesPath],
      ['linksSha256', linksPath],
    ];
    artifactChecks.forEach(([field, filePath]) => {
      const expected = metadata.artifacts[field];
      if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
        errors.push(`${label}/metadata.json: artifacts.${field} must be a lowercase SHA-256 digest`);
      } else {
        const actual = sha256File(filePath);
        if (actual !== expected) {
          errors.push(`${label}/metadata.json: artifacts.${field} does not match ${path.basename(filePath)}`);
        }
      }
    });
  }

  if (!Array.isArray(nodes) || nodes.length === 0) {
    errors.push(`${label}/nodes.json: must be a nonempty JSON array`);
    continue;
  }
  if (!Array.isArray(links)) {
    errors.push(`${label}/links.json: must be a JSON array (an empty array is allowed for analysis-only methods)`);
    continue;
  }


  let relationshipIsValid = true;
  if (links.length > 0) {
    relationshipIsValid = requireObjectText(
      metadata.relationship,
      'relationship',
      ['id', 'version', 'metric', 'scoreKind', 'scoreDirection', 'linkRule'],
    );
    if (relationshipIsValid && !['distance', 'similarity'].includes(metadata.relationship.scoreKind)) {
      errors.push(`${label}/metadata.json: relationship.scoreKind must be "distance" or "similarity"`);
      relationshipIsValid = false;
    }
    if (
      relationshipIsValid
      && !['lower-is-closer', 'higher-is-closer'].includes(metadata.relationship.scoreDirection)
    ) {
      errors.push(`${label}/metadata.json: relationship.scoreDirection must be "lower-is-closer" or "higher-is-closer"`);
      relationshipIsValid = false;
    }
    if (
      relationshipIsValid
      && metadata.relationship.scoreKind === 'distance'
      && metadata.relationship.scoreDirection !== 'lower-is-closer'
    ) {
      errors.push(`${label}/metadata.json: distance relationships must use scoreDirection "lower-is-closer"`);
    }
    if (
      relationshipIsValid
      && metadata.relationship.scoreKind === 'similarity'
      && metadata.relationship.scoreDirection !== 'higher-is-closer'
    ) {
      errors.push(`${label}/metadata.json: similarity relationships must use scoreDirection "higher-is-closer"`);
    }
  } else if (metadata.relationship !== null) {
    errors.push(`${label}/metadata.json: relationship must be null when links.json is empty`);
  }

  const nodeIds = new Set();
  nodes.forEach((node, index) => {
    const nodeLabel = `${label}/nodes.json[${index}]`;
    if (typeof node?.id !== 'string' || !node.id.trim()) {
      errors.push(`${nodeLabel}: id is required and must be nonblank`);
      return;
    }
    if (nodeIds.has(node.id)) errors.push(`${nodeLabel}: duplicate node id ${JSON.stringify(node.id)}`);
    nodeIds.add(node.id);

    if (typeof node.text !== 'string' || !node.text.trim()) {
      errors.push(`${nodeLabel}: text is required and must be nonblank`);
    }

    const hasCoordinates = typeof node.x === 'number'
      && Number.isFinite(node.x)
      && typeof node.y === 'number'
      && Number.isFinite(node.y);
    if (!hasCoordinates && !parseTopicVector(node.topic_distribution)) {
      errors.push(`${nodeLabel}: provide finite numeric x/y coordinates or a numeric topic_distribution with at least two values`);
    }
  });

  const undirectedPairs = new Set();
  links.forEach((link, index) => {
    const linkLabel = `${label}/links.json[${index}]`;
    if (typeof link?.source !== 'string' || typeof link?.target !== 'string') {
      errors.push(`${linkLabel}: source and target must be node-id strings`);
      return;
    }
    if (!nodeIds.has(link.source)) errors.push(`${linkLabel}: source ${JSON.stringify(link.source)} does not match a node id`);
    if (!nodeIds.has(link.target)) errors.push(`${linkLabel}: target ${JSON.stringify(link.target)} does not match a node id`);
    if (link.source === link.target) {
      errors.push(`${linkLabel}: self-links are not allowed`);
    }

    const pair = [link.source, link.target].sort();
    const pairId = JSON.stringify(pair);
    if (undirectedPairs.has(pairId)) {
      errors.push(`${linkLabel}: duplicate or reciprocal undirected link ${pairId}`);
    }
    undirectedPairs.add(pairId);

    if (relationshipIsValid && metadata.relationship) {
      const scoreField = metadata.relationship.scoreKind;
      const score = link[scoreField];
      if (typeof score !== 'number' || !Number.isFinite(score)) {
        errors.push(`${linkLabel}: ${scoreField} is required and must be a finite number`);
      } else if (scoreField === 'distance' && score < 0) {
        errors.push(`${linkLabel}: distance must be zero or greater`);
      }
      if (Object.prototype.hasOwnProperty.call(link, 'value')) {
        errors.push(`${linkLabel}: use an explicit distance or similarity field instead of ambiguous value`);
      }
    }
  });
}

if (errors.length > 0) {
  console.error(`Dataset validation failed with ${errors.length} issue${errors.length === 1 ? '' : 's'}:\n`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log(`Validated ${datasetDirectories.length} dataset${datasetDirectories.length === 1 ? '' : 's'} successfully.`);
