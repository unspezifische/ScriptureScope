jest.mock('./Graph3DViewer', () => () => null);

import { clampLegendHeight, findPassageNode, prepareNodeForGraph } from './App';
import {
  METHOD_CATALOG,
  RELATIONSHIP_MODEL_CATALOG,
  getMethodMetadata,
} from './methodCatalog';

test('every built-in method explains what it is and how it is calculated', () => {
  Object.values(METHOD_CATALOG).forEach((method) => {
    expect(method.description.trim().length).toBeGreaterThan(39);
    expect(method.calculation.trim().length).toBeGreaterThan(39);
  });
});

test('unknown contributed methods receive an explicit missing-metadata explanation', () => {
  const method = getMethodMetadata('New_Method');
  expect(method.description).toMatch(/no description/i);
  expect(method.calculation).toMatch(/must include/i);
  expect(method.collectionKey).toBe('New_Method');
});

test('legacy graph views separate one relationship model from four layouts', () => {
  const graphMethods = ['DrL', 'Kamada_Kawai', 'Large_Graph_Layout', 'MDS']
    .map(getMethodMetadata);

  expect(new Set(graphMethods.map((method) => method.relationshipModelId))).toEqual(
    new Set(['lda_squared_euclidean_knn_legacy']),
  );
  expect(new Set(graphMethods.map((method) => method.layoutId)).size).toBe(4);
  expect(graphMethods.map((method) => method.collectionKey)).toEqual([
    'DrL',
    'Kamada_Kawai',
    'Large_Graph_Layout',
    'MDS',
  ]);
  expect(RELATIONSHIP_MODEL_CATALOG.lda_squared_euclidean_knn_legacy.scoreDirection)
    .toBe('lower-is-closer');
});

test('analysis previews explicitly contain no relationships', () => {
  expect(getMethodMetadata('BERT').hasRelationships).toBe(false);
  expect(getMethodMetadata('Gensim').hasRelationships).toBe(false);
});

test('generated comparison datasets declare opposite score directions correctly', () => {
  const topicView = getMethodMetadata('lda_jsd_mutual_knn_v1');
  const lexicalView = getMethodMetadata('tfidf_cosine_mutual_knn_v1');

  expect(topicView.relationshipModel.scoreDirection).toBe('lower-is-closer');
  expect(topicView.collectionKey).toBe('lda_jsd_mutual_knn_v1');
  expect(lexicalView.relationshipModel.scoreDirection).toBe('higher-is-closer');
  expect(lexicalView.collectionKey).toBe('tfidf_cosine_mutual_knn_v1');
});

test('active graph datasets declare expected incremental-loading totals', () => {
  expect(METHOD_CATALOG['bsb-bertopic-linked-v1'].expectedCounts).toEqual({ nodes: 20872, links: 61164 });
  expect(METHOD_CATALOG['bsb-lda-aligned-v1'].expectedCounts).toEqual({ nodes: 20872, links: 46789 });
  expect(METHOD_CATALOG['bsb-bertopic-lda-hybrid-v1'].expectedCounts).toEqual({ nodes: 20872, links: 48570 });
});

test('Color Key drawer height stays within usable viewport bounds', () => {
  expect(clampLegendHeight(50, 800)).toBe(180);
  expect(clampLegendHeight(360, 800)).toBe(360);
  expect(clampLegendHeight(1000, 800)).toBe(600);
  expect(clampLegendHeight(1000, 400)).toBe(260);
});

test('topic distributions receive plottable fallback coordinates', () => {
  const node = prepareNodeForGraph({
    id: 'JHN 3:16',
    text: 'For God so loved the world',
    topic_distribution: '[0.1, 0.8, 0.3]',
  });

  expect(node.x).toEqual(expect.any(Number));
  expect(node.y).toEqual(expect.any(Number));
  expect(node.group).toBe('Topic 2');
  expect(node.usesProjectedTopicLayout).toBe(true);
});

describe('passage search', () => {
  const nodes = [
    { id: 'John 2:12-3:25' },
    { id: 'John 3:1-3:21' },
    { id: 'John 3:22-4:3' },
    { id: 'John 21:20-:25' },
    { id: '1 John 3:1-3:10' },
    { id: '1 John 4:1-4:10' },
    { id: 'Philippians 4:1-4:9' },
    { id: 'Isaiah 53:1-53:12' },
    { id: 'Psalms 23:1-23:6' },
  ];

  test('finds the smallest passage range containing a verse', () => {
    expect(findPassageNode(nodes, 'John 3:16')?.id).toBe('John 3:1-3:21');
    expect(findPassageNode(nodes, 'John 3')?.id).toBe('John 3:1-3:21');
  });

  test('prefers an exact range match over overlapping ranges', () => {
    expect(findPassageNode(nodes, 'John 2:12–3:25')?.id).toBe('John 2:12-3:25');
  });

  test('accepts common book aliases without confusing numbered books', () => {
    expect(findPassageNode(nodes, 'Jn 3:16')?.id).toBe('John 3:1-3:21');
    expect(findPassageNode(nodes, 'Psalm 23:4')?.id).toBe('Psalms 23:1-23:6');
    expect(findPassageNode(nodes, '1 John 3:4')?.id).toBe('1 John 3:1-3:10');
    expect(findPassageNode(nodes, 'I Jn 4:8')?.id).toBe('1 John 4:1-4:10');
    expect(findPassageNode(nodes, 'Php 4:6')?.id).toBe('Philippians 4:1-4:9');
    expect(findPassageNode(nodes, 'Philippians 4:6')?.id).toBe('Philippians 4:1-4:9');
    expect(findPassageNode(nodes, 'ISA 53:5')?.id).toBe('Isaiah 53:1-53:12');
  });

  test('handles legacy ranges with an omitted ending chapter', () => {
    expect(findPassageNode(nodes, 'John 21:24')?.id).toBe('John 21:20-:25');
  });

  test('returns null when the graph does not contain the reference', () => {
    expect(findPassageNode(nodes, 'Romans 8:28')).toBeNull();
    expect(findPassageNode(nodes, 'John 4:8')).toBeNull();
  });
});
