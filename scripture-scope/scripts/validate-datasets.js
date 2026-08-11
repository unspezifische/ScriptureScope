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

const isNonblankString = (value) => typeof value === 'string' && Boolean(value.trim());

const isPlaceholderTopicName = (value) => (
  isNonblankString(value) && /^Topic\s+\d+$/i.test(value.trim())
);

const isFiniteNumberArray = (value) => (
  Array.isArray(value)
  && value.length > 0
  && value.every((item) => typeof item === 'number' && Number.isFinite(item))
);

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
  const topicLabelsPath = path.join(directory, 'topic-labels.json');
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

  const declaresTopicModel = Object.prototype.hasOwnProperty.call(metadata, 'topicModel');
  let topicLabels = null;
  if (declaresTopicModel) {
    if (!fs.existsSync(topicLabelsPath)) {
      errors.push(`${label}: missing required file topic-labels.json for metadata.topicModel`);
    } else {
      topicLabels = readJson(topicLabelsPath, `${label}/topic-labels.json`);
    }
  }

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

  let topicModelIsValid = false;
  if (declaresTopicModel) {
    topicModelIsValid = requireObjectText(metadata.topicModel, 'topicModel', [
      'id',
      'version',
      'embeddingModel',
      'embeddingModelRevision',
      'clusteringAlgorithm',
      'labelingMethod',
      'labelStatus',
      'outlierPolicy',
    ]);

    if (topicModelIsValid) {
      if (metadata.topicModel.labelStatus !== 'reviewed') {
        errors.push(`${label}/metadata.json: topicModel.labelStatus must be "reviewed" before publication`);
        topicModelIsValid = false;
      }
      if (!/^[a-f0-9]{64}$/.test(metadata.topicModel.labelOverridesSha256 ?? '')) {
        errors.push(`${label}/metadata.json: topicModel.labelOverridesSha256 must be a lowercase SHA-256 digest`);
        topicModelIsValid = false;
      }
      const integerFields = [
        ['seed', 0],
        ['topicCount', 1],
        ['topicDistributionDimensions', 1],
      ];
      integerFields.forEach(([field, minimum]) => {
        const value = metadata.topicModel[field];
        if (!Number.isInteger(value) || value < minimum) {
          errors.push(
            `${label}/metadata.json: topicModel.${field} must be an integer greater than or equal to ${minimum}`,
          );
          topicModelIsValid = false;
        }
      });

      if (
        Object.prototype.hasOwnProperty.call(metadata.topicModel, 'parameters')
        && (
          !metadata.topicModel.parameters
          || typeof metadata.topicModel.parameters !== 'object'
          || Array.isArray(metadata.topicModel.parameters)
        )
      ) {
        errors.push(`${label}/metadata.json: topicModel.parameters must be an object when provided`);
        topicModelIsValid = false;
      }
    }
  }

  if (!metadata.artifacts || typeof metadata.artifacts !== 'object' || Array.isArray(metadata.artifacts)) {
    errors.push(`${label}/metadata.json: artifacts is required and must contain dataset checksums`);
  } else {
    const artifactChecks = [
      ['nodesSha256', nodesPath],
      ['linksSha256', linksPath],
    ];
    if (declaresTopicModel) artifactChecks.push(['topicLabelsSha256', topicLabelsPath]);
    artifactChecks.forEach(([field, filePath]) => {
      const expected = metadata.artifacts[field];
      if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
        errors.push(`${label}/metadata.json: artifacts.${field} must be a lowercase SHA-256 digest`);
      } else if (fs.existsSync(filePath)) {
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

  const topicLabelById = new Map();
  if (declaresTopicModel) {
    if (!Array.isArray(topicLabels) || topicLabels.length === 0) {
      if (fs.existsSync(topicLabelsPath)) {
        errors.push(`${label}/topic-labels.json: must be a nonempty JSON array`);
      }
    } else {
      const topicLabelNames = new Set();
      const modelTopics = new Set();
      const distributionIndexes = new Set();

      topicLabels.forEach((topicLabel, index) => {
        const topicLabelName = `${label}/topic-labels.json[${index}]`;
        if (!topicLabel || typeof topicLabel !== 'object' || Array.isArray(topicLabel)) {
          errors.push(`${topicLabelName}: must be an object`);
          return;
        }

        if (!isNonblankString(topicLabel.id)) {
          errors.push(`${topicLabelName}: id is required and must be nonblank`);
        } else if (isPlaceholderTopicName(topicLabel.id)) {
          errors.push(`${topicLabelName}: placeholder topic id ${JSON.stringify(topicLabel.id.trim())} is not allowed`);
        } else if (topicLabelById.has(topicLabel.id)) {
          errors.push(`${topicLabelName}: duplicate topic id ${JSON.stringify(topicLabel.id)}`);
        } else {
          topicLabelById.set(topicLabel.id, topicLabel);
        }

        if (!Number.isInteger(topicLabel.modelTopic) || topicLabel.modelTopic < 0) {
          errors.push(`${topicLabelName}: modelTopic must be a nonnegative integer`);
        } else if (modelTopics.has(topicLabel.modelTopic)) {
          errors.push(`${topicLabelName}: duplicate modelTopic ${topicLabel.modelTopic}`);
        } else {
          modelTopics.add(topicLabel.modelTopic);
        }

        if (!Number.isInteger(topicLabel.distributionIndex) || topicLabel.distributionIndex < 0) {
          errors.push(`${topicLabelName}: distributionIndex must be a nonnegative integer`);
        } else if (distributionIndexes.has(topicLabel.distributionIndex)) {
          errors.push(`${topicLabelName}: duplicate distributionIndex ${topicLabel.distributionIndex}`);
        } else {
          distributionIndexes.add(topicLabel.distributionIndex);
        }

        if (!isNonblankString(topicLabel.name)) {
          errors.push(`${topicLabelName}: name is required and must be nonblank`);
        } else {
          const normalizedName = topicLabel.name.trim();
          if (isPlaceholderTopicName(normalizedName)) {
            errors.push(`${topicLabelName}: placeholder topic name ${JSON.stringify(normalizedName)} is not allowed`);
          }
          if (topicLabelNames.has(normalizedName)) {
            errors.push(`${topicLabelName}: duplicate topic name ${JSON.stringify(normalizedName)}`);
          } else {
            topicLabelNames.add(normalizedName);
          }
        }

        if (!Number.isInteger(topicLabel.count) || topicLabel.count < 0) {
          errors.push(`${topicLabelName}: count must be a nonnegative integer`);
        }

        for (const field of ['terms', 'representativePassages']) {
          const values = topicLabel[field];
          if (
            !Array.isArray(values)
            || values.length === 0
            || !values.every(isNonblankString)
          ) {
            errors.push(`${topicLabelName}: ${field} must be a nonempty array of nonblank strings`);
          }
        }
      });

      if (topicModelIsValid && metadata.topicModel.topicCount !== topicLabels.length) {
        errors.push(
          `${label}/metadata.json: topicModel.topicCount ${metadata.topicModel.topicCount} does not match ${topicLabels.length} topic labels`,
        );
      }
      if (
        topicModelIsValid
        && metadata.topicModel.topicDistributionDimensions !== topicLabels.length
      ) {
        errors.push(
          `${label}/metadata.json: topicModel.topicDistributionDimensions ${metadata.topicModel.topicDistributionDimensions} does not match ${topicLabels.length} topic labels`,
        );
      }
      if (
        distributionIndexes.size === topicLabels.length
        && [...distributionIndexes].some((value) => value >= topicLabels.length)
      ) {
        errors.push(`${label}/topic-labels.json: distributionIndex values must cover 0 through ${topicLabels.length - 1}`);
      }
    }
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
  const nodeTopicIds = new Map();
  const topicNodeCounts = new Map();
  let topicDistributionDimensions = null;
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
    if (!declaresTopicModel && !hasCoordinates && !parseTopicVector(node.topic_distribution)) {
      errors.push(`${nodeLabel}: provide finite numeric x/y coordinates or a numeric topic_distribution with at least two values`);
    }

    if (declaresTopicModel) {
      if (!isNonblankString(node.topicId)) {
        errors.push(`${nodeLabel}: topicId is required and must be nonblank`);
      } else {
        if (isPlaceholderTopicName(node.topicId)) {
          errors.push(`${nodeLabel}: placeholder topicId ${JSON.stringify(node.topicId.trim())} is not allowed`);
        }
        topicNodeCounts.set(node.topicId, (topicNodeCounts.get(node.topicId) ?? 0) + 1);
        nodeTopicIds.set(node.id, node.topicId);
      }

      for (const field of ['topicName', 'group']) {
        if (!isNonblankString(node[field])) {
          errors.push(`${nodeLabel}: ${field} is required and must be nonblank`);
        } else if (isPlaceholderTopicName(node[field])) {
          errors.push(`${nodeLabel}: placeholder ${field} ${JSON.stringify(node[field].trim())} is not allowed`);
        }
      }

      if (
        isNonblankString(node.topicName)
        && isNonblankString(node.group)
        && node.group !== node.topicName
      ) {
        errors.push(`${nodeLabel}: group must exactly equal topicName`);
      }

      if (!hasCoordinates) {
        errors.push(`${nodeLabel}: finite numeric x and y coordinates are required for topic-model datasets`);
      }

      if (Object.prototype.hasOwnProperty.call(node, 'topicProbability')) {
        if (
          typeof node.topicProbability !== 'number'
          || !Number.isFinite(node.topicProbability)
          || node.topicProbability < 0
          || node.topicProbability > 1
        ) {
          errors.push(`${nodeLabel}: topicProbability must be a finite number from 0 to 1`);
        }
      }

      if (!isFiniteNumberArray(node.topicDistribution)) {
        errors.push(`${nodeLabel}: topicDistribution must be a nonempty array of finite numbers`);
      } else {
        if (node.topicDistribution.some((value) => value < 0 || value > 1)) {
          errors.push(`${nodeLabel}: topicDistribution values must be from 0 to 1`);
        }
        const probabilityTotal = node.topicDistribution.reduce((sum, value) => sum + value, 0);
        if (Math.abs(probabilityTotal - 1) > 1e-6) {
          errors.push(`${nodeLabel}: topicDistribution values must sum to 1 (received ${probabilityTotal})`);
        }
        if (topicDistributionDimensions === null) {
          topicDistributionDimensions = node.topicDistribution.length;
        } else if (node.topicDistribution.length !== topicDistributionDimensions) {
          errors.push(
            `${nodeLabel}: topicDistribution length ${node.topicDistribution.length} does not match prior node dimension ${topicDistributionDimensions}`,
          );
        }

        if (
          topicModelIsValid
          && node.topicDistribution.length !== metadata.topicModel.topicDistributionDimensions
        ) {
          errors.push(
            `${nodeLabel}: topicDistribution length ${node.topicDistribution.length} does not match metadata.topicModel.topicDistributionDimensions ${metadata.topicModel.topicDistributionDimensions}`,
          );
        }
        if (Array.isArray(topicLabels) && node.topicDistribution.length !== topicLabels.length) {
          errors.push(
            `${nodeLabel}: topicDistribution length ${node.topicDistribution.length} does not match ${topicLabels.length} topic labels`,
          );
        }
      }

      if (isNonblankString(node.topicId) && topicLabelById.size > 0) {
        const matchingLabel = topicLabelById.get(node.topicId);
        if (!matchingLabel) {
          errors.push(`${nodeLabel}: topicId ${JSON.stringify(node.topicId)} does not match a topic label`);
        } else {
          if (
            isNonblankString(node.topicName)
            && node.topicName !== matchingLabel.name
          ) {
            errors.push(
              `${nodeLabel}: topicName ${JSON.stringify(node.topicName)} does not match topic label name ${JSON.stringify(matchingLabel.name)}`,
            );
          }
          if (
            isFiniteNumberArray(node.topicDistribution)
            && Number.isInteger(matchingLabel.distributionIndex)
            && matchingLabel.distributionIndex < node.topicDistribution.length
          ) {
            const assignedProbability = node.topicDistribution[matchingLabel.distributionIndex];
            if (
              typeof node.topicProbability === 'number'
              && Number.isFinite(node.topicProbability)
              && Math.abs(node.topicProbability - assignedProbability) > 1e-9
            ) {
              errors.push(`${nodeLabel}: topicProbability must match the assigned topicDistribution component`);
            }
          }
        }
      }
    }
  });

  if (declaresTopicModel && Array.isArray(topicLabels)) {
    topicLabels.forEach((topicLabel, index) => {
      if (!topicLabel || typeof topicLabel !== 'object' || Array.isArray(topicLabel)) return;
      if (!isNonblankString(topicLabel.id) || !Number.isInteger(topicLabel.count)) return;
      const actualCount = topicNodeCounts.get(topicLabel.id) ?? 0;
      if (topicLabel.count !== actualCount) {
        errors.push(
          `${label}/topic-labels.json[${index}]: count ${topicLabel.count} does not match ${actualCount} nodes with topicId ${JSON.stringify(topicLabel.id)}`,
        );
      }
      if (Array.isArray(topicLabel.representativePassages)) {
        topicLabel.representativePassages.forEach((passageId) => {
          if (isNonblankString(passageId) && !nodeIds.has(passageId)) {
            errors.push(
              `${label}/topic-labels.json[${index}]: representative passage ${JSON.stringify(passageId)} does not match a node id`,
            );
          } else if (
            isNonblankString(passageId)
            && isNonblankString(topicLabel.id)
            && nodeTopicIds.get(passageId) !== topicLabel.id
          ) {
            errors.push(
              `${label}/topic-labels.json[${index}]: representative passage ${JSON.stringify(passageId)} is assigned to ${JSON.stringify(nodeTopicIds.get(passageId))}, not ${JSON.stringify(topicLabel.id)}`,
            );
          }
        });
      }
    });
  }

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
