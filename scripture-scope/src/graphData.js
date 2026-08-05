export const normalizeGraphId = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

export const getLinkEndpointId = (endpoint) => {
  if (endpoint && typeof endpoint === 'object') {
    return normalizeGraphId(endpoint.id ?? endpoint.name ?? endpoint.reference);
  }
  return normalizeGraphId(endpoint);
};

export const parseTopicVector = (value) => {
  if (Array.isArray(value)) {
    const values = value.map(Number);
    return values.length >= 2 && values.every(Number.isFinite) ? values : null;
  }

  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return null;
    const values = parsed.map(Number);
    return values.length >= 2 && values.every(Number.isFinite) ? values : null;
  } catch (error) {
    // Legacy Firestore imports sometimes contain Python-style tuples or
    // whitespace-separated vectors instead of JSON arrays.
    if (!/^[[(].*[\])]$/.test(trimmed)) return null;
    const values = trimmed
      .slice(1, -1)
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    return values.length >= 2 && values.every(Number.isFinite) ? values : null;
  }
};

const isFiniteCoordinate = (value) => (
  value !== null && value !== '' && Number.isFinite(Number(value))
);

const hasFiniteCoordinates = (node) => (
  isFiniteCoordinate(node?.x) && isFiniteCoordinate(node?.y)
);

const isRenderableNode = (node) => (
  hasFiniteCoordinates(node) || parseTopicVector(node?.topic_distribution) !== null
);

const canonicalPair = (source, target) => (
  source <= target ? [source, target] : [target, source]
);

const pairKey = (source, target) => `${source.length}:${source}${target.length}:${target}`;

const getFiniteDistance = (link, legacyValueKind) => {
  const rawValue = link?.distance ?? (legacyValueKind === 'distance' ? link?.value : undefined);
  if (rawValue === '' || rawValue === null || rawValue === undefined) return null;
  const numericValue = Number(rawValue);
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : null;
};

const getFiniteSimilarity = (link, legacyValueKind) => {
  const rawValue = link?.similarity ?? (legacyValueKind === 'similarity' ? link?.value : undefined);
  if (rawValue === '' || rawValue === null || rawValue === undefined) return null;
  const numericValue = Number(rawValue);
  return Number.isFinite(numericValue) ? numericValue : null;
};

/**
 * Converts legacy Firestore snapshots into the undirected graph that the
 * canvas actually renders. Invalid records are dropped and each node pair is
 * retained once, even when the source contains reciprocal or repeated imports.
 */
export const normalizeGraphData = (rawNodes, rawLinks, options = {}) => {
  const nodes = [];
  const nodeIds = new Set();
  let invalidNodeCount = 0;
  let duplicateNodeCount = 0;

  for (const rawNode of Array.isArray(rawNodes) ? rawNodes : []) {
    const id = normalizeGraphId(rawNode?.id);
    const text = typeof rawNode?.text === 'string' ? rawNode.text.trim() : '';

    if (!id || !text || !isRenderableNode(rawNode)) {
      invalidNodeCount += 1;
      continue;
    }
    if (nodeIds.has(id)) {
      duplicateNodeCount += 1;
      continue;
    }

    nodeIds.add(id);
    nodes.push({ ...rawNode, id, text });
  }

  const linkByPair = new Map();
  let invalidLinkCount = 0;
  let duplicateLinkCount = 0;

  for (const rawLink of Array.isArray(rawLinks) ? rawLinks : []) {
    const rawSource = getLinkEndpointId(rawLink?.source);
    const rawTarget = getLinkEndpointId(rawLink?.target);

    if (
      !rawSource
      || !rawTarget
      || rawSource === rawTarget
      || !nodeIds.has(rawSource)
      || !nodeIds.has(rawTarget)
    ) {
      invalidLinkCount += 1;
      continue;
    }

    const [source, target] = canonicalPair(rawSource, rawTarget);
    const key = pairKey(source, target);
    const distance = getFiniteDistance(rawLink, options.legacyValueKind);
    const similarity = getFiniteSimilarity(rawLink, options.legacyValueKind);
    const existing = linkByPair.get(key);

    if (existing) {
      duplicateLinkCount += 1;
      existing.observationCount += 1;
      if (rawSource !== source) existing.hasReverseObservation = true;

      if (distance !== null) {
        existing.distance = existing.distance === null
          ? distance
          : Math.min(existing.distance, distance);
        existing.value = existing.distance;
        existing.distanceMin = existing.distanceMin === null
          ? distance
          : Math.min(existing.distanceMin, distance);
        existing.distanceMax = existing.distanceMax === null
          ? distance
          : Math.max(existing.distanceMax, distance);
      }
      if (similarity !== null) {
        existing.similarity = existing.similarity === null
          ? similarity
          : Math.max(existing.similarity, similarity);
        existing.similarityMin = existing.similarityMin === null
          ? similarity
          : Math.min(existing.similarityMin, similarity);
        existing.similarityMax = existing.similarityMax === null
          ? similarity
          : Math.max(existing.similarityMax, similarity);
      }
      continue;
    }

    linkByPair.set(key, {
      ...rawLink,
      source,
      target,
      value: distance,
      distance,
      distanceMin: distance,
      distanceMax: distance,
      similarity,
      similarityMin: similarity,
      similarityMax: similarity,
      metric: rawLink?.metric || options.metric || 'unspecified',
      observationCount: 1,
      hasReverseObservation: rawSource !== source,
    });
  }

  return {
    nodes,
    links: [...linkByPair.values()],
    stats: {
      inputNodeCount: Array.isArray(rawNodes) ? rawNodes.length : 0,
      renderedNodeCount: nodes.length,
      invalidNodeCount,
      duplicateNodeCount,
      inputLinkCount: Array.isArray(rawLinks) ? rawLinks.length : 0,
      renderedLinkCount: linkByPair.size,
      invalidLinkCount,
      duplicateLinkCount,
    },
  };
};

export const formatRelationshipDistance = (link, distanceLabel = 'Distance') => {
  if (!Number.isFinite(link?.distance)) {
    if (!Number.isFinite(link?.similarity)) return 'Score unavailable';
    const similarity = Math.abs(link.similarity) < 0.001
      ? link.similarity.toExponential(2)
      : link.similarity.toFixed(4);
    return `Similarity ${similarity}`;
  }
  const formatted = link.distance < 0.001
    ? link.distance.toExponential(2)
    : link.distance.toFixed(4);
  return `${distanceLabel} ${formatted}`;
};
