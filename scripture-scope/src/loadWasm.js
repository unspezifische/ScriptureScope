// scripture-scope/src/loadWasm.js
export async function loadWasm(moduleOverrides = {}) {
  if (typeof window === 'undefined') {
    throw new Error('WASM runtime requires a browser environment');
  }

  if (window.__scriptureScopeWasmPromise) {
    return window.__scriptureScopeWasmPromise;
  }

  window.__scriptureScopeWasmPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector('script[src="/visualization.js"]');

    const finalize = () => {
      if (typeof window.Module === 'function') {
        try {
          const modulePromise = window.Module(moduleOverrides);
          if (modulePromise && typeof modulePromise.then === 'function') {
            modulePromise.then(resolve, reject);
          } else {
            resolve(modulePromise);
          }
        } catch (error) {
          reject(error);
        }
      } else {
        reject(new Error('The visualization module did not initialize'));
      }
    };

    if (existingScript && window.Module) {
      finalize();
      return;
    }

    const script = document.createElement('script');
    script.src = '/visualization.js';
    script.async = true;

    script.onload = finalize;

    script.onerror = () => {
      reject(new Error('Unable to load /visualization.js'));
    };

    document.body.appendChild(script);
  });

  return window.__scriptureScopeWasmPromise;
}