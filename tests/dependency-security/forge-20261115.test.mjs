import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const root = process.env.BALANCEFRAME_FORGE_TEST_ROOT || resolve(import.meta.dirname, '../..');
const web = createRequire(join(root, 'apps/web/package.json'));
const nuxt = createRequire(web.resolve('nuxt/package.json'));
const server = createRequire(nuxt.resolve('@nuxt/nitro-server/package.json'));
const nitro = createRequire(server.resolve('nitropack/package.json'));
const listhen = createRequire(nitro.resolve('listhen'));
const packagePath =
  process.env.BALANCEFRAME_FORGE_TEST_PACKAGE ||
  dirname(listhen.resolve('node-forge/package.json'));
const require = createRequire(join(packagePath, 'package.json'));
const f = require('./lib/index.js');
const a = f.asn1;
const seq = (values) => a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, values);
function bounded(code) {
  const prelude = `const assert=require('node:assert/strict');const requireForge=require('node:module').createRequire(${JSON.stringify(join(packagePath, 'package.json'))});const f=requireForge('./lib/index.js');`;
  const child = spawnSync(process.execPath, ['--input-type=commonjs', '-e', prelude + code], {
    timeout: 3000,
    encoding: 'utf8',
    maxBuffer: 65536,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
}

// Protocol vectors follow the upstream Forge v1.4.3 security regressions.
test('RSA rejects noncanonical long-form and indefinite DigestInfo lengths', () => {
  const key = f.pki.rsa.setPublicKey(
    new f.jsbn.BigInteger('f'.repeat(256), 16),
    new f.jsbn.BigInteger('1'),
  );
  const md = f.md.sha256.create();
  md.update('fictional message');
  const digest = md.digest().getBytes();
  const body = f.util.hexToBytes('300d060960864801650304020105000420') + digest;
  for (const der of [
    f.util.hexToBytes('3081') + String.fromCharCode(body.length) + body,
    f.util.hexToBytes('3080') + body + '\x00\x00',
  ]) {
    const signature = '\x00\x01' + '\xff'.repeat(128 - der.length - 3) + '\x00' + der;
    assert.throws(() => key.verify(digest, signature), /DigestInfo/);
  }
});
test('ASN1 BIT STRING recursion respects the requested decoding depth', () => {
  const der = f.util.hexToBytes('030a00300702020100020103');
  const limited = a.fromDer(der, { maxDepth: 2 });
  assert.equal(typeof limited.value, 'string');
  assert.equal(a.toDer(limited).getBytes(), der);
  const decoded = a.fromDer(der, { maxDepth: 3 });
  assert.equal(decoded.value[0].type, a.Type.SEQUENCE);
  assert.equal(decoded.value[0].value[1].value, '\x03');
});
test('PEM rejects unmatched delimiters without polynomial work', () => {
  bounded(
    "assert.throws(()=>f.pem.decode(' -----BEGIN I-----G-----END B'.repeat(2000)+'\\x00'),/PEM/);",
  );
});
test('PEM decoding preserves Buffer, ordinary body and encapsulated headers', () => {
  const pem = '-----BEGIN A-----\nQUJD\n-----END A-----\n';
  assert.equal(f.pem.decode(Buffer.from(pem))[0].body, 'ABC');
  assert.equal(f.pem.decode(pem)[0].type, 'A');
  const withHeader =
    '-----BEGIN A-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: DES-CBC,F8143EDE5960C597\nX-Header: x\n\nQUJD\n-----END A-----\n';
  assert.deepEqual(f.pem.decode(withHeader)[0].headers, [{ name: 'X-Header', values: ['x'] }]);
});
test('PKCS12 PBE refuses zero and negative iteration counts', () => {
  for (const count of [0, -1])
    assert.throws(
      () => f.pki.pbe.generatePkcs12Key('pw', f.util.createBuffer('salt'), 1, count, 16),
      /iteration/i,
    );
  const derive = (pw) =>
    f.pki.pbe.generatePkcs12Key(pw, f.util.createBuffer('salt'), 1, 2, 16).getBytes();
  assert.notEqual(derive('first'), derive('second'));
});

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const key = f.pki.privateKeyFromPem(privateKey);
const publicKey = f.pki.rsa.setPublicKey(key.n, key.e);
test('RSA certificate fixtures use at least 2048-bit keys', () => {
  assert.ok(key.n.bitLength() >= 2048);
});
let serial = 1;
function cert(name, issuer, extensions) {
  const c = f.pki.createCertificate();
  c.publicKey = publicKey;
  c.serialNumber = (serial++).toString(16).padStart(2, '0');
  c.validity.notBefore = new Date('2020-01-01T00:00:00Z');
  c.validity.notAfter = new Date('2050-01-01T00:00:00Z');
  c.setSubject([{ name: 'commonName', value: name }]);
  c.setIssuer(issuer ? issuer.subject.attributes : c.subject.attributes);
  c.setExtensions(extensions);
  c.sign(key, f.md.sha256.create());
  return f.pki.certificateFromPem(f.pki.certificateToPem(c));
}
const ca = () => ({ name: 'basicConstraints', cA: true });
const rootCert = cert('root', null, [ca()]);
const verify = (chain) =>
  f.pki.verifyCertificateChain(f.pki.createCaStore([rootCert]), chain, {
    validityCheckDate: new Date('2026-11-15T12:00:00Z'),
  });
test('PKCS12 rejects a zero-iteration MAC even when its constant-key MAC matches', () => {
  const pfx = f.pkcs12.toPkcs12Asn1(null, [rootCert], 'pw', { count: 2 });
  const mac = pfx.value[2];
  mac.value[2].value = '\x00';
  const h = f.hmac.create();
  h.start('sha1', '\x00'.repeat(20));
  h.update(pfx.value[1].value[1].value[0].value);
  mac.value[0].value[1].value = h.digest().getBytes();
  assert.throws(() => f.pkcs12.pkcs12FromAsn1(pfx, 'any password'), /iteration/i);
});
test('ordinary PEM certificate, private key and password-protected PFX remain readable', () => {
  assert.equal(f.pki.privateKeyFromPem(privateKey).n.toString(), key.n.toString());
  const pfx = f.pkcs12.toPkcs12Asn1(key, [rootCert], 'fixture password', {
    algorithm: '3des',
    count: 2,
  });
  const decoded = f.pkcs12.pkcs12FromAsn1(a.fromDer(a.toDer(pfx).getBytes()), 'fixture password');
  assert.ok(decoded.safeContents.length);
  assert.throws(() => f.pkcs12.pkcs12FromAsn1(pfx, 'wrong password'));
});
test('X509 does not treat deprecated basicConstraints OIDs as CA authority', () => {
  for (const id of ['2.5.29.10', '2.5.29.13']) {
    const value = a
      .toDer(seq([a.create(a.Class.UNIVERSAL, a.Type.BOOLEAN, false, '\xff')]))
      .getBytes();
    const intermediate = cert('intermediate', rootCert, [{ id, value }]);
    assert.throws(() => verify([cert('leaf', intermediate, []), intermediate]));
  }
});
test('X509 pathLenConstraint applies without a keyUsage extension', () => {
  const first = cert('first', rootCert, [
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0 },
  ]);
  const second = cert('second', first, [ca()]);
  assert.throws(() => verify([cert('leaf', second, []), second, first]));
});
test('X509 nameConstraints rejects a disallowed DNS name and preserves allowed chains', () => {
  const dns = a.create(a.Class.CONTEXT_SPECIFIC, 2, false, '.allowed.example');
  const value = a
    .toDer(seq([a.create(a.Class.CONTEXT_SPECIFIC, 0, true, [seq([dns])])]))
    .getBytes();
  const intermediate = cert('intermediate', rootCert, [ca(), { id: '2.5.29.30', value }]);
  const leaf = (name) =>
    cert('leaf', intermediate, [{ name: 'subjectAltName', altNames: [{ type: 2, value: name }] }]);
  assert.equal(verify([leaf('ok.allowed.example'), intermediate]), true);
  assert.throws(() => verify([leaf('blocked.example'), intermediate]));
});
test('X509 chain verification preserves same-subject trusted certificates', () => {
  const other = cert('root', null, [ca()]);
  const store = f.pki.createCaStore([rootCert, other]);
  const leaf = cert('leaf', rootCert, []);
  const before = store.listAllCertificates().length;
  assert.equal(
    f.pki.verifyCertificateChain(store, [leaf], {
      validityCheckDate: new Date('2026-11-15T12:00:00Z'),
    }),
    true,
  );
  assert.equal(store.listAllCertificates().length, before);
});
test('X509 certificate verification uses the child signature scheme', () => {
  const leaf = cert('leaf', rootCert, []);
  const issuer = f.pki.certificateFromPem(f.pki.certificateToPem(rootCert));
  issuer.signatureOid = f.pki.oids['RSASSA-PSS'];
  assert.equal(issuer.verify(leaf), true);
});
function record(type, body) {
  return String.fromCharCode(type, 3, 1) + f.util.int32ToBytes(body.length).slice(2) + body;
}
function connection(server = false) {
  const errors = [];
  let sent = '';
  const c = f.tls.createConnection({
    server,
    verify: () => true,
    tlsDataReady: (x) => {
      sent += x.tlsData.getBytes();
    },
    dataReady: (x) => x.data.getBytes(),
    closed: () => {},
    error: (_c, e) => errors.push(e.message),
  });
  return {
    c,
    errors,
    get sent() {
      return sent;
    },
  };
}
const hello = (compression) =>
  '\x02\x00\x00\x26\x03\x01' +
  '\x00'.repeat(32) +
  '\x00\x00\x2f' +
  String.fromCharCode(compression);
test('TLS rejects an interleaved non-handshake record without throwing or dispatching data', () => {
  for (const [type, body] of [
    [20, '\x01'],
    [21, '\x02\x28'],
    [23, 'data'],
    [24, '\x01\x00\x00'],
  ]) {
    const { c, errors } = connection(true);
    assert.doesNotThrow(() =>
      c.process(record(22, '\x01\x00\x00\x10\x03\x01') + record(type, body)),
    );
    assert.deepEqual(errors, ['Invalid fragmented record.']);
    assert.equal(c.fail, true);
  }
  const { c, errors } = connection(true);
  c.process(record(22, '\x01\x00\x00\x10\x03\x01') + record(22, '\x00'));
  assert.deepEqual(errors, []);
  assert.equal(c.fail, false);
});
test('TLS processes many records without recursive stack exhaustion', () => {
  bounded(
    "const c=f.tls.createConnection({server:true,verify:()=>true,tlsDataReady:c=>c.tlsData.getBytes(),dataReady:c=>c.data.getBytes(),closed:()=>{},error:()=>{}});assert.doesNotThrow(()=>c.process(f.util.hexToBytes('1803010003020000').repeat(12000)));",
  );
});
test('TLS reports unsupported ServerHello compression without throwing', () => {
  for (const method of [1, 255]) {
    const { c, errors } = connection();
    c.handshake();
    assert.doesNotThrow(() => c.process(record(22, hello(method))));
    assert.deepEqual(errors, ['Unsupported compression method.']);
  }
  const { c, errors } = connection();
  c.handshake();
  c.process(record(22, hello(0)));
  assert.deepEqual(errors, []);
});
test('TLS ignores ServerHello records without a live session', () => {
  for (const closed of [false, true]) {
    const { c, errors } = connection();
    if (closed) {
      c.handshake();
      c.close();
    }
    assert.doesNotThrow(() => c.process(record(22, '\x02\x00\x00\x00')));
    assert.deepEqual(errors, []);
  }
});
test('TLS rejects a missing server certificate through its error channel', () => {
  const { c, errors } = connection();
  c.handshake();
  assert.doesNotThrow(() => c.process(record(22, hello(0) + '\x0e\x00\x00\x00')));
  assert.ok(errors.some((e) => /certificate/i.test(e)));
});
test('HTTP cookie names cannot write through Object.prototype', () => {
  const http = require('./lib/http.js');
  const client = http.createClient({
    url: 'http://fictional.invalid',
    persistCookies: false,
    socketPool: { createSocket: () => ({}) },
  });
  const path = '/__balanceframe_cookie_probe__';
  try {
    assert.equal(
      client.setCookie({ name: '__proto__', value: 'marker', path, secure: false }),
      false,
    );
    assert.equal(Object.prototype[path], undefined);
  } finally {
    delete Object.prototype[path];
  }
  assert.equal(
    client.setCookie({ name: 'ordinary', value: 'value', path: '/', secure: false }),
    true,
  );
  assert.equal(client.getCookie('ordinary', '/').value, 'value');
});
test('HTTP header and cookie whitespace trimming bounds parser work', () => {
  bounded(
    "const http=requireForge('./lib/http.js');const response=http.createResponse();response.setField('X-Probe','a'+' '.repeat(131072)+'b');assert.equal(response.getField('X-Probe').length,131074);response.setField('Set-Cookie','probe=a'+' '.repeat(131072)+'b; Path=/');assert.equal(response.getCookies()[0].name,'probe');",
  );
});
test('Ed25519 refuses small-order public keys and preserves ordinary signatures', () => {
  const e = f.pki.ed25519;
  const identity = Buffer.alloc(32);
  identity[0] = 1;
  const signature = Buffer.alloc(64);
  signature[0] = 1;
  assert.equal(
    e.verify({ message: Buffer.from('fictional message'), publicKey: identity, signature }),
    false,
  );
  const pair = e.generateKeyPair({ seed: Buffer.alloc(32, 7) });
  const message = Buffer.from('ordinary');
  assert.equal(
    e.verify({
      message,
      signature: e.sign({ message, privateKey: pair.privateKey }),
      publicKey: pair.publicKey,
    }),
    true,
  );
});
test('AES-GCM rejects unsupported short tag lengths', () => {
  for (const bits of ['0', 16, 24])
    assert.throws(() =>
      f.cipher
        .createDecipher('AES-GCM', '\x00'.repeat(16))
        .start({ iv: '\x00'.repeat(12), tagLength: bits, tag: '\x00'.repeat(Number(bits) / 8) }),
    );
  const key = 'k'.repeat(16),
    iv = 'i'.repeat(12);
  const cipher = f.cipher.createCipher('AES-GCM', key);
  cipher.start({ iv });
  cipher.update(f.util.createBuffer('ordinary'));
  assert.equal(cipher.finish(), true);
  const reader = f.cipher.createDecipher('AES-GCM', key);
  reader.start({ iv, tag: cipher.mode.tag.bytes(), tagLength: 128 });
  reader.update(cipher.output);
  assert.equal(reader.finish(), true);
  assert.equal(reader.output.getBytes(), 'ordinary');
});
test('AES and DES block modes reject inconsistent PKCS7 padding bytes', () => {
  for (const name of ['AES-CBC', 'AES-ECB', 'DES-CBC', 'DES-ECB']) {
    const size = name.startsWith('AES') ? 16 : 8,
      key = 'k'.repeat(size),
      iv = 'i'.repeat(size);
    const cipher = f.cipher.createCipher(name, key);
    cipher.start({ iv });
    cipher.update(f.util.createBuffer('a'.repeat(size - 2) + '\x03\x02'));
    assert.equal(
      cipher.finish(() => true),
      true,
    );
    const decipher = f.cipher.createDecipher(name, key);
    decipher.start({ iv });
    decipher.update(cipher.output);
    assert.equal(decipher.finish(), false, name);
    const ordinary = f.cipher.createCipher(name, key);
    ordinary.start({ iv });
    ordinary.update(f.util.createBuffer('ordinary'));
    ordinary.finish();
    const read = f.cipher.createDecipher(name, key);
    read.start({ iv });
    read.update(ordinary.output);
    assert.equal(read.finish(), true);
    assert.equal(read.output.getBytes(), 'ordinary');
  }
});
test('ASN1 object identifier encoding preserves a large second arc', () => {
  assert.equal(a.derToOid(a.oidToDer('2.999.3')), '2.999.3');
  assert.equal(a.derToOid(a.oidToDer('1.2.840.113549')), '1.2.840.113549');
});
test('BigInteger inverse terminates for negative input without losing ordinary arithmetic', () => {
  bounded(
    "const B=f.jsbn.BigInteger;assert.equal(new B('-1').modInverse(new B('7')).toString(),'0');assert.equal(new B('3').modInverse(new B('7')).toString(),'5');",
  );
});
