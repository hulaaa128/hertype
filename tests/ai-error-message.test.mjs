import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadAiWithFetch(fetchImpl) {
  const code = await readFile(new URL('../ai.js', import.meta.url), 'utf8');
  const storage = new Map();
  const context = {
    window: {},
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
    },
    fetch: fetchImpl,
    AbortController,
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    Error,
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context.window.HERTYPE_AI;
}

const ai = await loadAiWithFetch(async () => {
  throw new TypeError('Failed to fetch');
});

assert.equal(ai.DEFAULT_BASE, 'https://hulaai.online/hertype-ai');

await assert.rejects(
  () => ai.analyze('女生就该顾家'),
  (error) => {
    assert.match(error.message, /公共中转/);
    assert.match(error.message, /右上角「设置」/);
    return true;
  },
);

const customAi = await loadAiWithFetch(async () => {
  throw new TypeError('Failed to fetch');
});
customAi.saveConfig({
  key: 'test-key',
  baseUrl: 'https://api.example.com/v1',
  model: 'test-model',
});

await assert.rejects(
  () => customAi.analyze('女生就该顾家'),
  (error) => {
    assert.match(error.message, /请求发送失败:Failed to fetch/);
    assert.doesNotMatch(error.message, /公共中转/);
    return true;
  },
);
