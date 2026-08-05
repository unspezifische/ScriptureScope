const parseDistribution = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    return null;
  }
};

const normalizeDistribution = (value) => {
  const parsed = parseDistribution(value);
  if (!parsed || parsed.length < 2) return null;

  const distribution = parsed.map(Number);
  if (!distribution.every((entry) => Number.isFinite(entry) && entry >= 0)) return null;
  const total = distribution.reduce((sum, entry) => sum + entry, 0);
  if (!(total > 0)) return null;
  return distribution.map((entry) => entry / total);
};

const jensenShannonDistanceNormalized = (first, second) => {
  let divergence = 0;
  for (let index = 0; index < first.length; index += 1) {
    const firstProbability = first[index];
    const secondProbability = second[index];
    const midpoint = (firstProbability + secondProbability) / 2;
    if (firstProbability > 0) {
      divergence += 0.5 * firstProbability * Math.log2(firstProbability / midpoint);
    }
    if (secondProbability > 0) {
      divergence += 0.5 * secondProbability * Math.log2(secondProbability / midpoint);
    }
  }
  return Math.sqrt(Math.max(0, divergence));
};

const jensenShannonDistance = (firstValue, secondValue) => {
  const first = normalizeDistribution(firstValue);
  const second = normalizeDistribution(secondValue);
  if (!first || !second || first.length !== second.length) {
    throw new Error('Jensen–Shannon distance requires equal-length, nonnegative probability vectors.');
  }

  return jensenShannonDistanceNormalized(first, second);
};

const compareNeighbors = (first, second) => (
  first.distance - second.distance || first.id.localeCompare(second.id)
);

const insertNearest = (neighbors, candidate, k) => {
  const insertAt = neighbors.findIndex((neighbor) => compareNeighbors(candidate, neighbor) < 0);
  if (insertAt === -1) neighbors.push(candidate);
  else neighbors.splice(insertAt, 0, candidate);
  if (neighbors.length > k) neighbors.pop();
};

const roundDistance = (distance) => Number(distance.toPrecision(15));

const quantile = (sortedValues, probability) => {
  if (sortedValues.length === 0) return null;
  const position = (sortedValues.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) return sortedValues[lowerIndex];
  const fraction = position - lowerIndex;
  return sortedValues[lowerIndex] * (1 - fraction) + sortedValues[upperIndex] * fraction;
};

const summarizeGraph = (records, links) => {
  const nodeIndexById = new Map(records.map((record, index) => [record.id, index]));
  const adjacency = records.map(() => []);
  const distances = [];

  links.forEach((link) => {
    const sourceIndex = nodeIndexById.get(link.source);
    const targetIndex = nodeIndexById.get(link.target);
    adjacency[sourceIndex].push(targetIndex);
    adjacency[targetIndex].push(sourceIndex);
    distances.push(link.distance);
  });

  const componentSizes = [];
  const visited = new Uint8Array(records.length);
  for (let startIndex = 0; startIndex < records.length; startIndex += 1) {
    if (visited[startIndex]) continue;
    visited[startIndex] = 1;
    let componentSize = 0;
    const stack = [startIndex];
    while (stack.length > 0) {
      const currentIndex = stack.pop();
      componentSize += 1;
      adjacency[currentIndex].forEach((neighborIndex) => {
        if (visited[neighborIndex]) return;
        visited[neighborIndex] = 1;
        stack.push(neighborIndex);
      });
    }
    componentSizes.push(componentSize);
  }

  componentSizes.sort((first, second) => second - first);
  distances.sort((first, second) => first - second);
  const degrees = adjacency.map((neighbors) => neighbors.length).sort((first, second) => first - second);
  const distanceMean = distances.length > 0
    ? distances.reduce((sum, value) => sum + value, 0) / distances.length
    : null;
  const degreeMean = degrees.length > 0
    ? degrees.reduce((sum, value) => sum + value, 0) / degrees.length
    : null;

  return {
    componentCount: componentSizes.length,
    largestComponentNodeCount: componentSizes[0] ?? 0,
    isolatedNodeCount: degrees.filter((degree) => degree === 0).length,
    distance: {
      minimum: distances[0] ?? null,
      p25: quantile(distances, 0.25),
      median: quantile(distances, 0.5),
      p75: quantile(distances, 0.75),
      p95: quantile(distances, 0.95),
      maximum: distances[distances.length - 1] ?? null,
      mean: distanceMean,
    },
    degree: {
      minimum: degrees[0] ?? null,
      median: quantile(degrees, 0.5),
      maximum: degrees[degrees.length - 1] ?? null,
      mean: degreeMean,
    },
  };
};

const buildTopicLinks = (nodes, options = {}) => {
  if (!Array.isArray(nodes)) throw new Error('nodes must be an array.');

  const k = options.k ?? 10;
  const maximumDistance = options.maximumDistance ?? 1;
  if (!Number.isInteger(k) || k < 1) throw new Error('k must be a positive integer.');
  if (!Number.isFinite(maximumDistance) || maximumDistance < 0 || maximumDistance > 1) {
    throw new Error('maximumDistance must be between 0 and 1 for Jensen–Shannon distance.');
  }

  const records = [];
  const rejectedNodes = [];
  const seenIds = new Set();
  let dimensions = null;

  nodes.forEach((node, inputIndex) => {
    const id = node?.id === null || node?.id === undefined ? '' : String(node.id).trim();
    const text = typeof node?.text === 'string' ? node.text.trim() : '';
    const distribution = normalizeDistribution(node?.topic_distribution);
    let reason = '';

    if (!id) reason = 'missing-id';
    else if (!text) reason = 'missing-text';
    else if (seenIds.has(id)) reason = 'duplicate-id';
    else if (!distribution) reason = 'invalid-topic-distribution';
    else if (dimensions !== null && distribution.length !== dimensions) reason = 'inconsistent-topic-dimensions';

    if (reason) {
      rejectedNodes.push({ inputIndex, id, reason });
      return;
    }

    if (dimensions === null) dimensions = distribution.length;
    seenIds.add(id);
    records.push({ id, distribution });
  });

  const nearest = records.map(() => []);
  let comparedPairCount = 0;

  for (let firstIndex = 0; firstIndex < records.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < records.length; secondIndex += 1) {
      comparedPairCount += 1;
      const distance = jensenShannonDistanceNormalized(
        records[firstIndex].distribution,
        records[secondIndex].distribution,
      );
      if (distance > maximumDistance) continue;

      insertNearest(nearest[firstIndex], {
        index: secondIndex,
        id: records[secondIndex].id,
        distance,
      }, k);
      insertNearest(nearest[secondIndex], {
        index: firstIndex,
        id: records[firstIndex].id,
        distance,
      }, k);
    }
  }

  const links = [];
  for (let firstIndex = 0; firstIndex < records.length; firstIndex += 1) {
    nearest[firstIndex].forEach((candidate, firstRankIndex) => {
      if (firstIndex >= candidate.index) return;
      const reverseRankIndex = nearest[candidate.index]
        .findIndex((reverseCandidate) => reverseCandidate.index === firstIndex);
      if (reverseRankIndex === -1) return;

      const firstRecord = records[firstIndex];
      const secondRecord = records[candidate.index];
      const firstIsSource = firstRecord.id <= secondRecord.id;
      links.push({
        source: firstIsSource ? firstRecord.id : secondRecord.id,
        target: firstIsSource ? secondRecord.id : firstRecord.id,
        relationshipType: 'topic',
        distance: roundDistance(candidate.distance),
        sourceRank: firstIsSource ? firstRankIndex + 1 : reverseRankIndex + 1,
        targetRank: firstIsSource ? reverseRankIndex + 1 : firstRankIndex + 1,
      });
    });
  }

  links.sort((first, second) => (
    first.source.localeCompare(second.source) || first.target.localeCompare(second.target)
  ));

  const graphSummary = summarizeGraph(records, links);

  return {
    links,
    rejectedNodes,
    stats: {
      inputNodeCount: nodes.length,
      modeledNodeCount: records.length,
      rejectedNodeCount: rejectedNodes.length,
      dimensions: dimensions ?? 0,
      k,
      maximumDistance,
      comparedPairCount,
      mutualLinkCount: links.length,
      ...graphSummary,
    },
  };
};

module.exports = {
  buildTopicLinks,
  jensenShannonDistance,
  normalizeDistribution,
};
