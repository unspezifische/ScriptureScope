const DEFAULT_STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'also', 'am', 'an', 'and',
  'any', 'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below',
  'between', 'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'doing', 'down',
  'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having',
  'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'i', 'if',
  'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'more', 'most', 'my',
  'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or',
  'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she', 'should',
  'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves',
  'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under',
  'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which',
  'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'you', 'your', 'yours',
  'yourself', 'yourselves', 'shall', 'thee', 'thou', 'thy', 'thine', 'ye', 'unto',
]);

const tokenize = (text, stopWords = DEFAULT_STOP_WORDS) => {
  const normalized = String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const matches = normalized.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu) || [];
  return matches
    .map((token) => token.replace(/['’]s$/u, ''))
    .filter((token) => token.length > 1 && !stopWords.has(token));
};

const compareSimilarityNeighbors = (first, second) => (
  second.similarity - first.similarity
  || (first.id < second.id ? -1 : first.id > second.id ? 1 : 0)
);

const insertNearest = (neighbors, candidate, k) => {
  const insertAt = neighbors.findIndex(
    (neighbor) => compareSimilarityNeighbors(candidate, neighbor) < 0,
  );
  if (insertAt === -1) neighbors.push(candidate);
  else neighbors.splice(insertAt, 0, candidate);
  if (neighbors.length > k) neighbors.pop();
};

const pairIndex = (firstIndex, secondIndex, nodeCount) => (
  (firstIndex * (2 * nodeCount - firstIndex - 1)) / 2 + (secondIndex - firstIndex - 1)
);

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
  const similarities = [];
  links.forEach((link) => {
    const sourceIndex = nodeIndexById.get(link.source);
    const targetIndex = nodeIndexById.get(link.target);
    adjacency[sourceIndex].push(targetIndex);
    adjacency[targetIndex].push(sourceIndex);
    similarities.push(link.similarity);
  });

  const visited = new Uint8Array(records.length);
  const componentSizes = [];
  for (let startIndex = 0; startIndex < records.length; startIndex += 1) {
    if (visited[startIndex]) continue;
    visited[startIndex] = 1;
    let size = 0;
    const stack = [startIndex];
    while (stack.length > 0) {
      const currentIndex = stack.pop();
      size += 1;
      adjacency[currentIndex].forEach((neighborIndex) => {
        if (visited[neighborIndex]) return;
        visited[neighborIndex] = 1;
        stack.push(neighborIndex);
      });
    }
    componentSizes.push(size);
  }

  componentSizes.sort((first, second) => second - first);
  similarities.sort((first, second) => first - second);
  const degrees = adjacency.map((neighbors) => neighbors.length).sort((first, second) => first - second);
  return {
    componentCount: componentSizes.length,
    largestComponentNodeCount: componentSizes[0] ?? 0,
    isolatedNodeCount: degrees.filter((degree) => degree === 0).length,
    similarity: {
      minimum: similarities[0] ?? null,
      p25: quantile(similarities, 0.25),
      median: quantile(similarities, 0.5),
      p75: quantile(similarities, 0.75),
      p95: quantile(similarities, 0.95),
      maximum: similarities[similarities.length - 1] ?? null,
      mean: similarities.length > 0
        ? similarities.reduce((sum, value) => sum + value, 0) / similarities.length
        : null,
    },
    degree: {
      minimum: degrees[0] ?? null,
      median: quantile(degrees, 0.5),
      maximum: degrees[degrees.length - 1] ?? null,
      mean: degrees.length > 0
        ? degrees.reduce((sum, value) => sum + value, 0) / degrees.length
        : null,
    },
  };
};

const roundScore = (value) => Number(value.toPrecision(15));

const buildTfidfLinks = (nodes, options = {}) => {
  if (!Array.isArray(nodes)) throw new Error('nodes must be an array.');
  const k = options.k ?? 10;
  const minimumDocumentFrequency = options.minimumDocumentFrequency ?? 2;
  const maximumDocumentFrequencyRatio = options.maximumDocumentFrequencyRatio ?? 0.8;
  const evidenceTermCount = options.evidenceTermCount ?? 5;
  if (!Number.isInteger(k) || k < 1) throw new Error('k must be a positive integer.');
  if (!Number.isInteger(minimumDocumentFrequency) || minimumDocumentFrequency < 1) {
    throw new Error('minimumDocumentFrequency must be a positive integer.');
  }
  if (!(maximumDocumentFrequencyRatio > 0 && maximumDocumentFrequencyRatio <= 1)) {
    throw new Error('maximumDocumentFrequencyRatio must be greater than 0 and at most 1.');
  }

  const records = [];
  const rejectedNodes = [];
  const seenIds = new Set();
  nodes.forEach((node, inputIndex) => {
    const id = node?.id === null || node?.id === undefined ? '' : String(node.id).trim();
    const text = typeof node?.text === 'string' ? node.text.trim() : '';
    let reason = '';
    if (!id) reason = 'missing-id';
    else if (!text) reason = 'missing-text';
    else if (seenIds.has(id)) reason = 'duplicate-id';
    if (reason) {
      rejectedNodes.push({ inputIndex, id, reason });
      return;
    }
    seenIds.add(id);
    const termCounts = new Map();
    tokenize(text).forEach((term) => termCounts.set(term, (termCounts.get(term) ?? 0) + 1));
    records.push({ id, termCounts, vector: new Map() });
  });

  const documentFrequency = new Map();
  records.forEach((record) => {
    record.termCounts.forEach((value, term) => {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    });
  });

  const vocabulary = new Set();
  documentFrequency.forEach((frequency, term) => {
    const ratio = frequency / records.length;
    if (frequency >= minimumDocumentFrequency && ratio <= maximumDocumentFrequencyRatio) {
      vocabulary.add(term);
    }
  });

  const postings = new Map();
  records.forEach((record, recordIndex) => {
    let squaredMagnitude = 0;
    record.termCounts.forEach((count, term) => {
      if (!vocabulary.has(term)) return;
      const inverseDocumentFrequency = Math.log(
        (1 + records.length) / (1 + documentFrequency.get(term)),
      ) + 1;
      const weight = (1 + Math.log(count)) * inverseDocumentFrequency;
      record.vector.set(term, weight);
      squaredMagnitude += weight * weight;
    });
    const magnitude = Math.sqrt(squaredMagnitude);
    if (magnitude === 0) return;
    record.vector.forEach((weight, term) => {
      const normalizedWeight = weight / magnitude;
      record.vector.set(term, normalizedWeight);
      if (!postings.has(term)) postings.set(term, []);
      postings.get(term).push({ index: recordIndex, weight: normalizedWeight });
    });
  });

  const comparedPairCount = (records.length * (records.length - 1)) / 2;
  const similarities = new Float64Array(comparedPairCount);
  postings.forEach((termPostings) => {
    for (let firstPosition = 0; firstPosition < termPostings.length; firstPosition += 1) {
      const first = termPostings[firstPosition];
      for (let secondPosition = firstPosition + 1; secondPosition < termPostings.length; secondPosition += 1) {
        const second = termPostings[secondPosition];
        const firstIndex = Math.min(first.index, second.index);
        const secondIndex = Math.max(first.index, second.index);
        similarities[pairIndex(firstIndex, secondIndex, records.length)] += first.weight * second.weight;
      }
    }
  });

  const nearest = records.map(() => []);
  let nonzeroPairCount = 0;
  for (let firstIndex = 0; firstIndex < records.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < records.length; secondIndex += 1) {
      const similarity = similarities[pairIndex(firstIndex, secondIndex, records.length)];
      if (!(similarity > 0)) continue;
      nonzeroPairCount += 1;
      insertNearest(nearest[firstIndex], {
        index: secondIndex,
        id: records[secondIndex].id,
        similarity,
      }, k);
      insertNearest(nearest[secondIndex], {
        index: firstIndex,
        id: records[firstIndex].id,
        similarity,
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
      const smallerVector = firstRecord.vector.size <= secondRecord.vector.size
        ? firstRecord.vector
        : secondRecord.vector;
      const largerVector = smallerVector === firstRecord.vector
        ? secondRecord.vector
        : firstRecord.vector;
      const sharedTerms = [];
      smallerVector.forEach((weight, term) => {
        const otherWeight = largerVector.get(term);
        if (otherWeight !== undefined) sharedTerms.push({ term, contribution: weight * otherWeight });
      });
      sharedTerms.sort((first, second) => (
        second.contribution - first.contribution
        || (first.term < second.term ? -1 : first.term > second.term ? 1 : 0)
      ));

      links.push({
        source: firstIsSource ? firstRecord.id : secondRecord.id,
        target: firstIsSource ? secondRecord.id : firstRecord.id,
        relationshipType: 'lexical',
        similarity: roundScore(candidate.similarity),
        sourceRank: firstIsSource ? firstRankIndex + 1 : reverseRankIndex + 1,
        targetRank: firstIsSource ? reverseRankIndex + 1 : firstRankIndex + 1,
        sharedTerms: sharedTerms
          .slice(0, evidenceTermCount)
          .map(({ term }) => term),
      });
    });
  }

  links.sort((first, second) => (
    first.source < second.source ? -1
      : first.source > second.source ? 1
        : first.target < second.target ? -1
          : first.target > second.target ? 1
            : 0
  ));
  const graphSummary = summarizeGraph(records, links);
  const modeledTermCounts = records.map((record) => record.vector.size);

  return {
    links,
    rejectedNodes,
    stats: {
      inputNodeCount: nodes.length,
      modeledNodeCount: records.length,
      rejectedNodeCount: rejectedNodes.length,
      vocabularySize: vocabulary.size,
      zeroFeatureNodeCount: modeledTermCounts.filter((count) => count === 0).length,
      meanTermsPerNode: modeledTermCounts.length > 0
        ? modeledTermCounts.reduce((sum, count) => sum + count, 0) / modeledTermCounts.length
        : 0,
      k,
      minimumDocumentFrequency,
      maximumDocumentFrequencyRatio,
      comparedPairCount,
      nonzeroPairCount,
      mutualLinkCount: links.length,
      ...graphSummary,
    },
  };
};

module.exports = {
  DEFAULT_STOP_WORDS,
  buildTfidfLinks,
  tokenize,
};

