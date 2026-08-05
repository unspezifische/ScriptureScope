import {
  formatRelationshipDistance,
  normalizeGraphData,
  parseTopicVector,
} from './graphData';

const nodes = [
  { id: 'A', text: 'Alpha', x: 0, y: 0 },
  { id: 'B', text: 'Beta', x: 1, y: 1 },
  { id: 'C', text: 'Gamma', topic_distribution: '[0.2, 0.8]' },
];

test('parses JSON and legacy topic vectors', () => {
  expect(parseTopicVector('[0.1, 0.9]')).toEqual([0.1, 0.9]);
  expect(parseTopicVector('(0.1, 0.9)')).toEqual([0.1, 0.9]);
  expect(parseTopicVector('[0.1 0.9]')).toEqual([0.1, 0.9]);
  expect(parseTopicVector('[not-a-number, 0.9]')).toBeNull();
});

test('drops malformed nodes, duplicate ids, orphan links, and self-links', () => {
  const graph = normalizeGraphData(
    [
      ...nodes,
      { id: 'A', text: 'Duplicate', x: 2, y: 2 },
      { id: '-11:', text: '', x: 3, y: 3 },
      { id: 'D', text: 'No plottable data' },
    ],
    [
      { source: 'A', target: 'B', value: 0.2 },
      { source: 'A', target: 'missing', value: 0.1 },
      { source: 'B', target: 'B', value: 0 },
    ],
  );

  expect(graph.nodes.map((node) => node.id)).toEqual(['A', 'B', 'C']);
  expect(graph.links).toHaveLength(1);
  expect(graph.stats).toMatchObject({
    renderedNodeCount: 3,
    invalidNodeCount: 2,
    duplicateNodeCount: 1,
    invalidLinkCount: 2,
  });
});

test('canonicalizes reciprocal and repeated links into one undirected edge', () => {
  const graph = normalizeGraphData(nodes, [
    { source: 'B', target: 'A', value: 0.25 },
    { source: 'A', target: 'B', value: 0.25 },
    { source: { id: 'A' }, target: { id: 'B' }, value: 0.2 },
  ], {
    metric: 'squared-euclidean-topic-distribution',
    legacyValueKind: 'distance',
  });

  expect(graph.links).toEqual([
    expect.objectContaining({
      source: 'A',
      target: 'B',
      distance: 0.2,
      distanceMin: 0.2,
      distanceMax: 0.25,
      metric: 'squared-euclidean-topic-distribution',
      observationCount: 3,
      hasReverseObservation: true,
    }),
  ]);
  expect(graph.stats.duplicateLinkCount).toBe(2);
});

test('formats small topic distances without rounding them to zero', () => {
  expect(formatRelationshipDistance({ distance: 0.000001268081 }, 'Topic distance')).toBe('Topic distance 1.27e-6');
  expect(formatRelationshipDistance({ distance: 0.0319867842 }, 'Topic distance')).toBe('Topic distance 0.0320');
});

test('keeps explicit similarity scores separate from legacy values', () => {
  const graph = normalizeGraphData(nodes, [
    { source: 'A', target: 'B', similarity: 0.8, value: 99 },
    { source: 'B', target: 'A', similarity: 0.9, value: 1 },
  ]);

  expect(graph.links[0]).toMatchObject({
    distance: null,
    similarity: 0.9,
    similarityMin: 0.8,
    similarityMax: 0.9,
  });
  expect(formatRelationshipDistance(graph.links[0])).toBe('Similarity 0.9000');
});
