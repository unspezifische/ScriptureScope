import unittest

import numpy as np

from bible_books import canonical_book_name, canonicalize_reference
from topic_model_fusion import assert_aligned_nodes, jensen_shannon_distance, mutual_knn_links


class TopicModelFusionTests(unittest.TestCase):
    def test_usfm_codes_become_canonical_book_names(self):
        self.assertEqual(canonicalize_reference("ISA 53:5"), "Isaiah 53:5")
        self.assertEqual(canonicalize_reference("1CH 10:1"), "1 Chronicles 10:1")
        self.assertEqual(canonicalize_reference("Isaiah 53:5"), "Isaiah 53:5")
        self.assertEqual(canonical_book_name("PHP"), "Philippians")

    def test_jensen_shannon_distance_bounds(self):
        self.assertAlmostEqual(jensen_shannon_distance(np.array([1.0, 0.0]), np.array([1.0, 0.0])), 0.0)
        self.assertAlmostEqual(jensen_shannon_distance(np.array([1.0, 0.0]), np.array([0.0, 1.0])), 1.0)

    def test_mutual_links_retain_component_distances(self):
        node_ids = ["A", "B", "C", "D"]
        semantic = np.array([[0.9, 0.1], [0.8, 0.2], [0.1, 0.9], [0.2, 0.8]])
        lexical = np.array([[0.8, 0.2], [0.7, 0.3], [0.2, 0.8], [0.3, 0.7]])
        links, report = mutual_knn_links(
            node_ids, [semantic, lexical], [3, 1], k=1, candidate_k=3,
            seed=42, model_names=["bertopic", "lda"],
        )
        self.assertEqual([(link["source"], link["target"]) for link in links], [("A", "B"), ("C", "D")])
        self.assertEqual(report["weights"], {"bertopic": 0.75, "lda": 0.25})
        self.assertIn("bertopicDistance", links[0])
        self.assertIn("ldaDistance", links[0])
        self.assertAlmostEqual(
            links[0]["combinedDistance"],
            0.75 * links[0]["bertopicDistance"] + 0.25 * links[0]["ldaDistance"],
            places=10,
        )

    def test_alignment_reorders_but_rejects_text_changes(self):
        canonical = [{"id": "A", "text": "alpha"}, {"id": "B", "text": "beta"}]
        ordered = assert_aligned_nodes(canonical, list(reversed(canonical)))
        self.assertEqual([node["id"] for node in ordered], ["A", "B"])
        with self.assertRaisesRegex(ValueError, "text differs"):
            assert_aligned_nodes(canonical, [{"id": "A", "text": "changed"}, canonical[1]])


if __name__ == "__main__":
    unittest.main()
