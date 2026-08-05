const { buildTfidfLinks, tokenize } = require('../scripts/lib/tfidf-links');

test('tokenizes passage text with explicit stop-word removal', () => {
  expect(tokenize("The Lord's mercy is with you, and grace remains."))
    .toEqual(['lord', 'mercy', 'grace', 'remains']);
});

test('creates canonical mutual lexical links with shared-term evidence', () => {
  const result = buildTfidfLinks([
    { id: 'A', text: 'Grace mercy covenant hope' },
    { id: 'B', text: 'Grace mercy promise peace' },
    { id: 'C', text: 'Sword battle kingdom army' },
  ], { k: 1, minimumDocumentFrequency: 1 });

  expect(result.links).toEqual([
    expect.objectContaining({
      source: 'A',
      target: 'B',
      relationshipType: 'lexical',
      sourceRank: 1,
      targetRank: 1,
      sharedTerms: ['grace', 'mercy'],
    }),
  ]);
  expect(result.links[0].similarity).toBeGreaterThan(0);
  expect(result.stats).toMatchObject({
    modeledNodeCount: 3,
    mutualLinkCount: 1,
    componentCount: 2,
    isolatedNodeCount: 1,
  });
});

test('rejects malformed records without manufacturing zero-similarity links', () => {
  const result = buildTfidfLinks([
    { id: '-11:', text: '' },
    { id: 'A', text: 'Alpha unique' },
    { id: 'B', text: 'Beta separate' },
  ], { k: 2, minimumDocumentFrequency: 2 });

  expect(result.links).toEqual([]);
  expect(result.rejectedNodes).toEqual([
    { inputIndex: 0, id: '-11:', reason: 'missing-text' },
  ]);
  expect(result.stats.zeroFeatureNodeCount).toBe(2);
});

