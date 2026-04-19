import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWeixinOfficialTransport } from '../../../../src/platforms/weixin/official/transport.js';

interface FetchMockStep {
  body?: unknown;
  status?: number;
  error?: Error;
}

function createFetchMock(sequence: FetchMockStep[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string, init: RequestInit = {}): Promise<Response> => {
    calls.push({ url, init });
    const next = sequence.shift();
    if (!next) {
      throw new Error(`Unexpected fetch call: ${url}`);
    }
    if (next.error) {
      throw next.error;
    }
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

test('WeixinOfficialTransport.getUpdates posts iLink payload with authorization', async () => {
  const { fetchImpl, calls } = createFetchMock([{
    body: {
      ret: 0,
      msgs: [],
      get_updates_buf: 'next-cursor',
    },
  }]);
  const transport = createWeixinOfficialTransport({
    baseUrl: 'https://ilink.example.com',
    token: 'bot-token',
    fetchImpl,
  });

  const response = await transport.getUpdates({ syncCursor: 'cursor-1', timeoutMs: 1234 });

  assert.equal(response.get_updates_buf, 'next-cursor');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ilink.example.com/ilink/bot/getupdates');
  assert.equal(calls[0].init.method, 'POST');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.match(headers.Authorization, /^Bearer bot-token$/);
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.get_updates_buf, 'cursor-1');
  assert.equal(body.base_info.channel_version, '2.2.0');
});

test('WeixinOfficialTransport.sendMessage and getConfig use Hermes-compatible payload fields', async () => {
  const { fetchImpl, calls } = createFetchMock([
    { body: { ret: 0 } },
    { body: { typing_ticket: 'typing-1' } },
  ]);
  const transport = createWeixinOfficialTransport({
    baseUrl: 'https://ilink.example.com',
    token: 'bot-token',
    fetchImpl,
  });

  await transport.sendMessage({
    toUserId: 'wxid_sender',
    text: 'hello',
    contextToken: 'ctx-1',
    clientId: 'client-1',
  });
  const config = await transport.getConfig({
    userId: 'wxid_sender',
    contextToken: 'ctx-1',
  });

  assert.equal((config as { typing_ticket?: string }).typing_ticket, 'typing-1');
  const sendBody = JSON.parse(String(calls[0].init.body));
  assert.equal(sendBody.msg.to_user_id, 'wxid_sender');
  assert.equal(sendBody.msg.context_token, 'ctx-1');
  assert.equal(sendBody.msg.item_list[0].text_item.text, 'hello');

  const configBody = JSON.parse(String(calls[1].init.body));
  assert.equal(configBody.ilink_user_id, 'wxid_sender');
  assert.equal(configBody.context_token, 'ctx-1');
});

test('WeixinOfficialTransport.sendMediaFile uploads image media and sends the image item downstream', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-media-'));
  const imagePath = path.join(tempDir, 'sample.png');
  fs.writeFileSync(imagePath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnH0KsAAAAASUVORK5CYII=',
    'base64',
  ));

  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body?: string | Uint8Array | null }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof Uint8Array
          ? init.body
          : null,
    });

    if (url.includes('/ilink/bot/getuploadurl')) {
      return new Response(JSON.stringify({
        upload_param: 'upload-param',
        thumb_upload_param: 'thumb-upload-param',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/upload?')) {
      return new Response('', {
        status: 200,
        headers: { 'x-encrypted-param': 'download-param' },
      });
    }

    if (url.includes('/ilink/bot/sendmessage')) {
      return new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`unexpected fetch url: ${url}`);
  }) as typeof globalThis.fetch;

  try {
    const transport = createWeixinOfficialTransport({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'token',
    });

    const result = await transport.sendMediaFile({
      filePath: imagePath,
      toUserId: 'wxid_sender',
      text: '',
      contextToken: 'ctx-1',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
    });

    assert.ok(result.messageId);

    const uploadCall = requests.find((entry) => entry.url.includes('/ilink/bot/getuploadurl'));
    assert.ok(uploadCall);
    const uploadPayload = JSON.parse(String(uploadCall?.body ?? '{}'));
    assert.ok(Number(uploadPayload.thumb_rawsize) > 0);
    assert.ok(typeof uploadPayload.thumb_rawfilemd5 === 'string' && uploadPayload.thumb_rawfilemd5.length > 0);
    assert.ok(Number(uploadPayload.thumb_filesize) > 0);

    const cdnUploads = requests.filter((entry) => entry.url.includes('/upload?'));
    assert.equal(cdnUploads.length, 2);

    const sendCall = requests.find((entry) => entry.url.includes('/ilink/bot/sendmessage'));
    assert.ok(sendCall);

    const payload = JSON.parse(String(sendCall?.body ?? '{}'));
    assert.equal(payload.msg.to_user_id, 'wxid_sender');
    assert.equal(payload.msg.context_token, 'ctx-1');
    assert.equal(payload.msg.item_list?.[0]?.type, 2);
    assert.equal(payload.msg.item_list?.[0]?.image_item?.media?.encrypt_query_param, 'download-param');
    assert.equal(payload.msg.item_list?.[0]?.image_item?.thumb_media?.encrypt_query_param, 'download-param');
    assert.ok(Number(payload.msg.item_list?.[0]?.image_item?.thumb_size) > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WeixinOfficialTransport.sendMediaFile accepts remote image URLs by downloading them first', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body?: string | Uint8Array | null }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof Uint8Array
          ? init.body
          : null,
    });

    if (url === 'https://cdn.example.com/image.png') {
      return new Response(Buffer.from('remote-image-content'), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    }

    if (url.includes('/ilink/bot/getuploadurl')) {
      return new Response(JSON.stringify({
        upload_param: 'upload-param',
        thumb_upload_param: 'thumb-upload-param',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/upload?')) {
      return new Response('', {
        status: 200,
        headers: { 'x-encrypted-param': 'download-param' },
      });
    }

    if (url.includes('/ilink/bot/sendmessage')) {
      return new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`unexpected fetch url: ${url}`);
  }) as typeof globalThis.fetch;

  try {
    const transport = createWeixinOfficialTransport({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'token',
    });

    const result = await transport.sendMediaFile({
      filePath: 'https://cdn.example.com/image.png',
      toUserId: 'wxid_sender',
      text: '远程图片',
      contextToken: 'ctx-1',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
    });

    assert.ok(result.messageId);
    assert.ok(requests.some((entry) => entry.url === 'https://cdn.example.com/image.png'));
    const sendCalls = requests.filter((entry) => entry.url.includes('/ilink/bot/sendmessage'));
    assert.equal(sendCalls.length, 2);
    const textPayload = JSON.parse(String(sendCalls[0]?.body ?? '{}'));
    const mediaPayload = JSON.parse(String(sendCalls[1]?.body ?? '{}'));
    assert.equal(textPayload.msg.item_list?.[0]?.type, 1);
    assert.equal(textPayload.msg.item_list?.[0]?.text_item?.text, '远程图片');
    assert.equal(mediaPayload.msg.item_list?.[0]?.type, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WeixinOfficialTransport.sendMediaFile uploads video media with thumbnail metadata', async (t) => {
  if (!hasFfmpeg()) {
    t.skip('ffmpeg/ffprobe not available');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-video-'));
  const videoPath = path.join(tempDir, 'sample.mp4');
  const ffmpeg = spawnSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=320x240:d=1',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=44100:cl=mono',
    '-shortest',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    videoPath,
  ], { encoding: 'utf8' });
  assert.equal(ffmpeg.status, 0, ffmpeg.stderr || ffmpeg.stdout);

  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body?: string | Uint8Array | null }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof Uint8Array
          ? init.body
          : null,
    });

    if (url.includes('/ilink/bot/getuploadurl')) {
      return new Response(JSON.stringify({
        upload_param: 'upload-param',
        thumb_upload_param: 'thumb-upload-param',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/upload?')) {
      return new Response('', {
        status: 200,
        headers: { 'x-encrypted-param': url.includes('thumb-upload-param') ? 'thumb-download-param' : 'video-download-param' },
      });
    }

    if (url.includes('/ilink/bot/sendmessage')) {
      return new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`unexpected fetch url: ${url}`);
  }) as typeof globalThis.fetch;

  try {
    const transport = createWeixinOfficialTransport({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'token',
    });

    const result = await transport.sendMediaFile({
      filePath: videoPath,
      toUserId: 'wxid_sender',
      text: '视频说明',
      contextToken: 'ctx-1',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
    });

    assert.ok(result.messageId);

    const uploadCall = requests.find((entry) => entry.url.includes('/ilink/bot/getuploadurl'));
    assert.ok(uploadCall);
    const uploadPayload = JSON.parse(String(uploadCall?.body ?? '{}'));
    assert.ok(Number(uploadPayload.thumb_rawsize) > 0);
    assert.ok(typeof uploadPayload.thumb_rawfilemd5 === 'string' && uploadPayload.thumb_rawfilemd5.length > 0);
    assert.ok(Number(uploadPayload.thumb_filesize) > 0);

    const cdnUploads = requests.filter((entry) => entry.url.includes('/upload?'));
    assert.equal(cdnUploads.length, 2);
    assert.ok(cdnUploads.some((entry) => entry.url.includes('upload-param')));
    assert.ok(cdnUploads.some((entry) => entry.url.includes('thumb-upload-param')));

    const sendCalls = requests.filter((entry) => entry.url.includes('/ilink/bot/sendmessage'));
    assert.equal(sendCalls.length, 2);
    const mediaPayload = JSON.parse(String(sendCalls[1]?.body ?? '{}'));
    assert.equal(mediaPayload.msg.item_list?.[0]?.type, 5);
    assert.equal(mediaPayload.msg.item_list?.[0]?.video_item?.media?.encrypt_query_param, 'video-download-param');
    assert.equal(mediaPayload.msg.item_list?.[0]?.video_item?.thumb_media?.encrypt_query_param, 'thumb-download-param');
    assert.ok(Number(mediaPayload.msg.item_list?.[0]?.video_item?.thumb_size) > 0);
    assert.ok(Number(mediaPayload.msg.item_list?.[0]?.video_item?.play_length) > 0);
    assert.ok(typeof mediaPayload.msg.item_list?.[0]?.video_item?.video_md5 === 'string');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function hasFfmpeg() {
  return spawnSync('bash', ['-lc', 'command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1']).status === 0;
}
