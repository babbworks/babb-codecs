'use strict';

var fs = require('fs');
var path = require('path');
var codec = require('../src/index');

var fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/1pv-vectors.json'), 'utf8'));
var pass = 0, fail = 0;

function assert(label, cond, extra) {
  if (cond) { console.log('  PASS  ' + label); pass++; }
  else { console.log('  FAIL  ' + label + (extra ? ' — ' + extra : '')); fail++; }
}

assert('vector version', fixtures.version === '1pv-native-2b');
fixtures.vectors.forEach(function(v) {
  var d = codec.decode(v.url);
  assert('fixture ' + v.id + ' job', d.job === v.record.job);
  assert('fixture ' + v.id + ' native', d._nativeGroups === true);
  if (v.record.relationship) assert('fixture ' + v.id + ' rel', d.relationship === v.record.relationship);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
