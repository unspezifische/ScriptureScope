// scripture-scope/src/loadWasm.js
export async function loadWasm() {
  const wasmModule = await import('./visualization.js');
  const wasmInstance = await wasmModule.default();
  return wasmInstance;
}