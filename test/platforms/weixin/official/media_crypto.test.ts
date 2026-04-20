import assert from 'node:assert/strict';
import test from 'node:test';
import { encryptAesEcb } from '../../../../src/platforms/weixin/official/cdn/aes_ecb.js';
import { downloadAndDecryptBuffer } from '../../../../src/platforms/weixin/official/cdn/pic_decrypt.js';

test('downloadAndDecryptBuffer accepts aes_key encoded from raw 16-byte key', async () => {
  const plaintext = Buffer.from('codexbridge-weixin-image');
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const ciphertext = encryptAesEcb(plaintext, key);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(ciphertext, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' },
  })) as typeof globalThis.fetch;

  try {
    const result = await downloadAndDecryptBuffer(
      'unused',
      key.toString('base64'),
      'https://novac2c.cdn.weixin.qq.com/c2c',
      'raw-key-test',
      'https://cdn.example.com/file',
    );
    assert.deepEqual(result, plaintext);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('downloadAndDecryptBuffer accepts aes_key encoded from hex string wire format', async () => {
  const plaintext = Buffer.from('codexbridge-weixin-image');
  const keyHex = '00112233445566778899aabbccddeeff';
  const key = Buffer.from(keyHex, 'hex');
  const ciphertext = encryptAesEcb(plaintext, key);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(ciphertext, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' },
  })) as typeof globalThis.fetch;

  try {
    const result = await downloadAndDecryptBuffer(
      'unused',
      Buffer.from(keyHex).toString('base64'),
      'https://novac2c.cdn.weixin.qq.com/c2c',
      'hex-string-test',
      'https://cdn.example.com/file',
    );
    assert.deepEqual(result, plaintext);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
