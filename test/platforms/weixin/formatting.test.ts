import assert from 'node:assert/strict';
import test from 'node:test';
import { formatWeixinText } from '../../../src/platforms/weixin/formatting.js';

test('formatWeixinText applies official markdown filtering before local heading rewrite', () => {
  const formatted = formatWeixinText('# 标题\n\n![alt](https://example.com/a.png)\n\n中文*强调*和English *italic*');

  assert.equal(formatted, '【标题】\n\n中文强调和English *italic*');
});

test('formatWeixinText keeps fenced code blocks intact while rewriting headings outside fences', () => {
  const formatted = formatWeixinText('# 外部标题\n\n```md\n# 内部标题\n```\n\n## 次标题');

  assert.equal(formatted, '【外部标题】\n\n```md\n# 内部标题\n```\n\n**次标题**');
});
