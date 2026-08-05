# ScriptureScope
A website visualization tool for the Bible

This project allows people to view Bible passages, grouped visually by topic, similar to the data visualizations for LLMs and vector databases. It uses the Gensim library for Python to analyize parsed USX (Unified Scripture XML) files, which can be found at the Digital Bible Library: https://thedigitalbiblelibrary.org. There is a bit of a process to get a library card, but if you have one, there are many Bible versions (in many languages) that are freely available without any licensing arangements required. The actual site itself can be found a the https://scripturescope-71f88.web.app

Check out the Gensim Documentation [here]([https://radimrehurek.com/gensim/](https://radimrehurek.com/gensim/auto_examples/index.html##documentation))!

There is a limit to how much information can be gleaned simply from attempting to identify all the topics in a set of text passages. Therefore, I am working to implement a transformer-based analysis method that will work alongside the topic modeling. The hope is that using both can provide a blend of thematic categorization (from topic modeling) and deep semantic relationships (from the transformer model).

## Release Workflow (WASM + Firebase Hosting)

The Docker build is used to compile the C++ visualization code into `visualization.js` and `visualization.wasm`. Those files are part of what gets deployed to Firebase Hosting as part of the React app.

Use this full sequence when releasing from source changes:

```bash
# From repo root
docker build -t cpp-wasm-builder .
mkdir -p output
docker run --rm -v "$(pwd)/output:/output" cpp-wasm-builder

# Copy fresh WASM assets into React public folder
cp output/visualization.js scripture-scope/public/visualization.js
cp output/visualization.wasm scripture-scope/public/visualization.wasm

# Build and deploy frontend from the repository root
npm install
npm run build
firebase login
firebase use scripturescope-71f88
npm run deploy:hosting
```

If this is a new machine and Firebase Hosting has not been initialized in this repo yet, run this once from the repository root before deploying:

```bash
firebase init hosting
```

If you are just rebuilding the visualization WASM, use `docker build -t cpp-wasm-builder . && docker run --rm -v "$(pwd)/output:/output" cpp-wasm-builder`

When prompted during `firebase init hosting`, use:
- Public directory: `build`
- Single-page app rewrites: `Yes`

Notes:
- If only React code changed and `visualization.cpp` did not change, you can usually skip the Docker/WASM steps.
- Deployment requires a Firebase account with access to this project; other users will not be able to publish without project permissions.
- If Hosting is set to `public` instead of `build`, Firebase will deploy the raw React template and you may see a blank page with the default "React App" title.

## Publishing New Data (Firestore)

Deploying Hosting only updates the frontend bundle. The graph data itself is loaded live from Firestore.

The frontend expects collections named with this pattern:
- `nodes_<method>`
- `links_<method>`

Example: for a method called `gensim_lda_v2`, write to:
- `nodes_gensim_lda_v2`
- `links_gensim_lda_v2`

Expected document shapes:

```json
// nodes_<method>
{
	"id": "JHN 3:16",
	"text": "For God so loved the world...",
	"group": "Grace",
	"x": 0.124,
	"y": -0.338,
	"z": 0.0
}
```

```json
// links_<method>
{
	"source": "JHN 3:16",
	"target": "ROM 5:8",
	"distance": 0.1274
}
```

Important:
- `source` and `target` must match node `id` values.
- Store each undirected passage pair once. Do not import reciprocal copies, duplicate links, or self-links.
- Use an explicit `distance` (lower is closer) or `similarity` (higher is closer) field and document its metric in `metadata.json`; do not use the ambiguous legacy `value` field for new data.
- `x`, `y`, and `z` should be numeric.
- The method must appear in the frontend method selector (currently managed by backend services, not by this repo alone).

### How New Data Is Published

This repository currently contains the frontend and WASM renderer, but not the full data-ingestion writer pipeline. In practice, publishing new data means:
1. Generate node/link JSON from your parser/model pipeline.
2. Write those documents into `nodes_<method>` and `links_<method>` in Firestore.
3. Ensure the method name is available in the method selector API.
4. Reload the app and select that method.

## Contributor PR Path for New Data Packets

Because contributors do not have direct write access to production Firestore, use a PR-based handoff.

Recommended PR contents:
1. Add a dataset folder such as `datasets/<method>/` with:
	 - `nodes.json`
	 - `links.json`
	 - `metadata.json` with the required method ID, display name, Bible version, generation date, method type, description, and calculation details
2. The `description` must explain what the method represents in plain language. The `calculation` must document preprocessing, parameters, similarity/link rules, and layout or projection steps. Missing or blank fields fail CI validation.
3. Open a PR.

Use the template and complete field contract in [`datasets/README.md`](datasets/README.md). Before opening a PR, run:

```bash
npm run validate:datasets
```

Maintainer workflow after merge:
1. Validate JSON structure.
2. Import into Firestore collections `nodes_<method>` and `links_<method>`.
3. Ensure method-selector backend includes the method.
4. Verify in production by selecting the new method in the UI.

## Blank Page Troubleshooting

If Hosting shows a blank page with title "React App", check these in order:
1. Root `firebase.json` has `"public": "scripture-scope/build"`.
2. Build with environment variables available in `scripture-scope/.env` (the workspace build runs inside the React package).
3. `scripture-scope/public/visualization.js` and `scripture-scope/public/visualization.wasm` exist before `npm run build`.
4. Rebuild and redeploy:

```bash
npm run build
npm run deploy:hosting
```
