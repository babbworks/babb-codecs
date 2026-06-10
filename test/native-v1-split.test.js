'use strict';

var fs = require('fs');
var path = require('path');
var fflate = require('fflate');

global.window = global;
global.fflate = fflate;
global.btoa = function(s) { return Buffer.from(s, 'binary').toString('base64'); };
global.atob = function(s) { return Buffer.from(s, 'base64').toString('binary'); };

function load(p) {
  new Function('window', 'global', 'btoa', 'atob', 'TextEncoder', 'TextDecoder',
    fs.readFileSync(p, 'utf8'))(global, global, global.btoa, global.atob, TextEncoder, TextDecoder);
}

var src = path.join(__dirname, '../src');
load(path.join(src, 'native-groups-table.js'));
load(path.join(src, 'native-v1-split.js'));
load(path.join(src, 'pathc-v2.js'));
load(path.join(src, 'pathc-native.js'));
var codec = require('../src/codec');

var pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { console.log('  PASS  ' + label); pass++; }
  else { console.log('  FAIL  ' + label + (extra ? ' — ' + extra : '')); fail++; }
}

var rec = {
  job: 'npm split test',
  customer: 'Acme',
  record_type: 'invoice',
  date: '2026-05-20',
  amount: '99.00',
  details: 'G4 slice'
};
var frame = new Uint8Array(codec.encodeFrame(rec, { domain: 1, customerAmount: 99, decimalPos: 2, currency: 0 }));
var split = global.WPNativeV1Split.splitV1ToNativeGroups(frame);
assert('G2 present', split.groups[2] && split.groups[2].length > 0);
assert('G4 present', split.groups[4] && split.groups[4].length > 0);
var merged = global.WPNativeV1Split.mergeNativeGroupsToV1(split.groups, split.presence, split.headerPrefix);
assert('merge len', merged.length === frame.length);
var dec = codec.decodeFrame(merged);
assert('round-trip job', dec.job === rec.job);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
