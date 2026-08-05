import { prepareNodeForGraph } from './App';
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
