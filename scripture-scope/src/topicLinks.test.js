const {
  buildTopicLinks,
  jensenShannonDistance,
  normalizeDistribution,
} = require('../scripts/lib/topic-links');

test('normalizes topic mixtures and calculates bounded Jensen–Shannon distance', () => {
  expect(normalizeDistribution([2, 2])).toEqual([0.5, 0.5]);
  expect(jensenShannonDistance([1, 0], [1, 0])).toBeCloseTo(0, 12);
  expect(jensenShannonDistance([1, 0], [0, 1])).toBeCloseTo(1, 12);
});

test('retains only canonical mutual nearest-neighbor topic links', () => {
  const result = buildTopicLinks([
    { id: 'A', text: 'Alpha', topic_distribution: [1, 0] },
    { id: 'B', text: 'Beta', topic_distribution: [0.9, 0.1] },
    { id: 'C', text: 'Gamma', topic_distribution: [0, 1] },
  ], { k: 1 });

  expect(result.links).toEqual([
    expect.objectContaining({
      source: 'A',
      target: 'B',
      relationshipType: 'topic',
      sourceRank: 1,
      targetRank: 1,
    }),
  ]);
  expect(result.links[0].distance).toBeGreaterThan(0);
  expect(result.stats).toMatchObject({
    modeledNodeCount: 3,
    comparedPairCount: 3,
    mutualLinkCount: 1,
    componentCount: 2,
    largestComponentNodeCount: 2,
    isolatedNodeCount: 1,
  });
  expect(result.stats.distance.minimum).toBe(result.links[0].distance);
});

test('rejects malformed passages and applies the maximum-distance cutoff', () => {
  const result = buildTopicLinks([
    { id: '-11:', text: '', topic_distribution: [1, 0] },
    { id: 'A', text: 'Alpha', topic_distribution: [1, 0] },
    { id: 'B', text: 'Beta', topic_distribution: [0, 1] },
  ], { k: 2, maximumDistance: 0.5 });

  expect(result.links).toEqual([]);
  expect(result.rejectedNodes).toEqual([
    { inputIndex: 0, id: '-11:', reason: 'missing-text' },
  ]);
  expect(result.stats).toMatchObject({
    componentCount: 2,
    largestComponentNodeCount: 1,
    isolatedNodeCount: 2,
  });
});
