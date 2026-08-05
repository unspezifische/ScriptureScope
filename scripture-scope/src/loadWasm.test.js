import { loadWasm } from './loadWasm';

describe('loadWasm', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    delete window.__scriptureScopeWasmPromise;
    delete window.Module;
  });

  it('loads the visualization script and resolves the module', async () => {
    const promise = loadWasm();
    const script = document.querySelector('script[src="/visualization.js"]');

    expect(script).not.toBeNull();

    window.Module = jest.fn().mockReturnValue(Promise.resolve({ _initialize: jest.fn() }));
    script.onload();

    await expect(promise).resolves.toEqual({ _initialize: expect.any(Function) });
  });
});
