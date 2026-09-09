import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landingWorkspaceUrl } from './landingLinks';

test('workspace links preserve local preview scheme and port', () => {
  assert.equal(
    landingWorkspaceUrl(' My-Work ', 'localhost', 'http://localhost:3042'),
    'http://my-work.localhost:3042/',
  );
  assert.equal(
    landingWorkspaceUrl('work.custom.test', 'custom.test', 'https://custom.test:8443'),
    'https://work.custom.test:8443/',
  );
  assert.equal(
    landingWorkspaceUrl('work', 'carbon.etx.sx', 'https://carbon.etx.sx'),
    'https://work.carbon.etx.sx/',
  );
});
test('workspace input cannot redirect outside the deployment', () => {
  for (const value of [
    'evil.test',
    '//evil.test',
    'https://evil.test',
    'user@evil.test',
    '-bad',
    'bad-',
    'a'.repeat(64),
    'a/b',
    'a?x',
    '<script>',
  ]) {
    assert.equal(landingWorkspaceUrl(value, 'carbon.etx.sx', 'https://carbon.etx.sx'), null, value);
  }
});
