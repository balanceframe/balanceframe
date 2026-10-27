import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = process.env.BALANCEFRAME_FORGE_TEST_ROOT || resolve(import.meta.dirname, '../..');
const webRequire = createRequire(join(root, 'apps/web/package.json'));
const nuxtRequire = createRequire(webRequire.resolve('nuxt/package.json'));
const serverRequire = createRequire(nuxtRequire.resolve('@nuxt/nitro-server/package.json'));
const nitroRequire = createRequire(serverRequire.resolve('nitropack/package.json'));
const listhenRequire = createRequire(nitroRequire.resolve('listhen'));
// An isolated package copy allows red/green probes without changing installed dependencies.
const forgeRequire = process.env.BALANCEFRAME_FORGE_TEST_PACKAGE
  ? createRequire(join(resolve(process.env.BALANCEFRAME_FORGE_TEST_PACKAGE), 'package.json'))
  : createRequire(listhenRequire.resolve('node-forge/package.json'));
const forge = forgeRequire('./lib/index.js');
const invalidDigestInfo = /^Error: ASN.1 object does not contain a valid RSASSA-PKCS1-v1_5 DigestInfo value\.$/;

// The upstream PR's exponent-one key keeps every parser probe to a 128-byte signature.
const parserKey = forge.pki.rsa.setPublicKey(
  new forge.jsbn.BigInteger('f'.repeat(256), 16),
  new forge.jsbn.BigInteger('1', 10),
);
const md = forge.md.sha256.create();
md.update('nested-digest-algorithm');
const digest = md.digest().getBytes();

function parserSignature(algorithmHex) {
  const algorithm = forge.util.hexToBytes(algorithmHex);
  const digestInfo = forge.util.hexToBytes(
    '30' + (algorithm.length + 34).toString(16).padStart(2, '0'),
  ) + algorithm + forge.util.hexToBytes('0420') + digest;
  return forge.util.hexToBytes('0001' + 'ff'.repeat(128 - digestInfo.length - 3) + '00') + digestInfo;
}

test('Nuxt Nitro/listhen resolves node-forge at the approved unchanged version', () => {
  assert.equal(listhenRequire('node-forge/package.json').version, '1.4.0');
  assert.equal(forgeRequire('./package.json').version, '1.4.0');
});

for (const [name, algorithm] of [
  ['OID, NULL, extra OCTET STRING (upstream regression)', '301006096086480165030402010500040100'],
  ['OID, extra OCTET STRING without NULL', '300e0609608648016503040201040100'],
  ['OID, NULL, extra NULL', '300f060960864801650304020105000500'],
  ['OID and nonempty primitive NULL (one byte)', '300e0609608648016503040201050100'],
  ['OID and nonempty primitive NULL (multiple bytes)', '301006096086480165030402010503616263'],
]) {
  test(`RSA verification rejects malformed DigestAlgorithm: ${name}`, () => {
    const signature = parserSignature(algorithm);
    assert.equal(signature.length, 128);
    assert.throws(() => parserKey.verify(digest, signature), invalidDigestInfo);
  });
}

for (const [name, algorithm] of [
  ['OID only', '300b0609608648016503040201'],
  ['OID and optional NULL', '300d06096086480165030402010500'],
]) {
  test(`RSA verification preserves SHA-256 DigestAlgorithm with ${name}`, () => {
    assert.equal(parserKey.verify(digest, parserSignature(algorithm)), true);
    assert.equal(parserKey.verify('wrong digest', parserSignature(algorithm)), false);
  });
}

// Static public key and signature from digitalbazaar/forge tests/unit/rsa.js at
// approved PR #1158 head f192c67ee5850e44296ef83d6a7b6df6552ba8bf.
const publicKeyPem = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDL0EugUiNGMWscLAVM0VoMdhDZ
EJOqdsUMpx9U0YZI7szokJqQNIwokiQ6EonNnWSMlIvy46AhnlRYn+ezeTeU7eMG
TkP3VF29vXBo+dLq5e+8VyAyQ3FzM1wI4ts4hRACF8w6mqygXQ7i/SDu8/rXqRGt
vnM+z0MYDdKo80efzwIDAQAB
-----END PUBLIC KEY-----`;
const signatureHex =
  '9200ece65cdaed36bcc20b94c65af852e4f88f0b4fe5b249d54665f815992ac4' +
  '3a1399e65d938c6a7f16dd39d971a53ca66523209dbbfbcb67afa579dbb0c220' +
  '672813d9e6f4818f29b9becbb29da2032c5e422da97e0c39bfb7a2e7d568615a' +
  '5073af0337ff215a8e1b2332d668691f4fb731440055420c24ac451dd3c913f4';

test('ordinary RSA signature verification preserves the upstream static fixture', () => {
  const publicKey = forge.pki.publicKeyFromPem(publicKeyPem);
  const sha1 = forge.md.sha1.create();
  sha1.update('0123456789abcdef');
  const signature = forge.util.hexToBytes(signatureHex);
  assert.equal(publicKey.verify(sha1.digest().getBytes(), signature), true);
  assert.equal(publicKey.verify('wrong digest', signature), false);
});
