// codec-c.test.js — round-trip tests for the new kaios codebook-c browser codec
// Runs in Node.js by shimming the browser globals the codec needs.
// Run: node test/codec-c.test.js

'use strict';

var fflate = require('../js/lib/fflate.js');
var fs     = require('fs');

// ── browser shims ─────────────────────────────────────────────────────────────

var window = {
  fflate: fflate
};

// Node.js has TextEncoder/TextDecoder built-in since v11
if (typeof TextEncoder !== 'undefined') {
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;
} else {
  var util = require('util');
  window.TextEncoder = util.TextEncoder;
  window.TextDecoder = util.TextDecoder;
}

// btoa/atob: Node.js has them natively since v16; polyfill for older
if (typeof btoa !== 'undefined') {
  window.btoa = btoa;
  window.atob = atob;
} else {
  window.btoa = function(s) { return Buffer.from(s, 'binary').toString('base64'); };
  window.atob = function(s) { return Buffer.from(s, 'base64').toString('binary'); };
}

// Inject the codec into our fake window
var src = fs.readFileSync(__dirname + '/../js/lib/codec.js', 'utf8');
/* jshint ignore:start */
(new Function('window', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', src + '\n//# sourceURL=codec.js'))(
  window,
  window.btoa, window.atob,
  window.TextEncoder, window.TextDecoder
);
/* jshint ignore:end */

var codec = window.WPCodec;

// ── helpers ───────────────────────────────────────────────────────────────────

var pass = 0, fail = 0;

function assert(label, cond, extra) {
  if (cond) {
    console.log('  [PASS]  ' + label);
    pass++;
  } else {
    console.log('  [FAIL]  ' + label + (extra ? ' — ' + extra : ''));
    fail++;
  }
}

function roundTrip(record, opts) {
  var url = codec.encode(record, opts);
  var dec = codec.decode(url);
  return { url: url, decoded: dec };
}

// ── validate ──────────────────────────────────────────────────────────────────

console.log('\nvalidate');
(function() {
  assert('empty record invalid',       !codec.validate({}).valid);
  assert('job-only valid',              codec.validate({ job: 'Fix boiler' }).valid);
  assert('oversized job invalid',      !codec.validate({ job: 'X'.repeat(200) }).valid);
  assert('non-array actions invalid',  !codec.validate({ job: 'T', actions: 'nope' }).valid);
})();

// ── URL format ────────────────────────────────────────────────────────────────

console.log('\nURL format');
(function() {
  var url = codec.encode({ job: 'Test' });
  assert('contains workpads.me/p#',   url.indexOf('workpads.me/p#') !== -1);
  assert('scheme tag is 1eg/',         url.indexOf('workpads.me/p#1eg/') !== -1);
  assert('no legacy alg= param',       url.indexOf('alg=') === -1);
})();

// ── minimal record ────────────────────────────────────────────────────────────

console.log('\nminimal record');
(function() {
  var result = roundTrip({ job: 'Fix boiler' });
  assert('job round-trips',            result.decoded.job === 'Fix boiler');
  assert('URL under 200 chars',        result.url.length < 200);
})();

// ── full PADS record ──────────────────────────────────────────────────────────

console.log('\nfull PADS record');
(function() {
  var rec = {
    job:            'Annual boiler service',
    customer:       'Alice Smith',
    date:           '2026-04-27',
    location:       'Client warehouse, 123 High St',
    customer_phone: '+44 7700 900123',
    start_time:     '09:00',
    end_time:       '11:30',
    meeting_time:   '08:45',
    worker:         'Bob Field',
    details:        'Pressure checked, filters replaced, no issues found.',
    story:          'Routine annual service completed on schedule.',
    actions:        [
      { title: 'Check pressure', notes: 'Reading: 1.2 bar' },
      { title: 'Replace filter', notes: '' },
      { title: 'Test thermostat', notes: 'All good' }
    ]
  };

  var result = roundTrip(rec);

  var fields = ['job', 'customer', 'date', 'location', 'customer_phone',
                'start_time', 'end_time', 'meeting_time', 'worker', 'details', 'story'];
  for (var i = 0; i < fields.length; i++) {
    assert(fields[i] + ' round-trips', result.decoded[fields[i]] === rec[fields[i]]);
  }
  assert('actions count round-trips',   result.decoded.actions.length === 3);
  assert('action[0] title',             result.decoded.actions[0].title === 'Check pressure');
  assert('action[0] notes',             result.decoded.actions[0].notes === 'Reading: 1.2 bar');
  assert('action[1] empty notes',       result.decoded.actions[1].notes === '');
  assert('action[2] title',             result.decoded.actions[2].title === 'Test thermostat');
})();

// ── financial block ───────────────────────────────────────────────────────────

console.log('\nfinancial block');
(function() {
  var rec = {
    job:         'Plumbing repair',
    record_type: 'invoice',
    currency:    'GBP',
    vat:         '20',
    amount:      '250.00'
  };
  var result = roundTrip(rec);

  assert('record_type round-trips',  result.decoded.record_type === 'invoice');
  assert('currency round-trips',     result.decoded.currency    === 'GBP');
  assert('vat round-trips',          result.decoded.vat         === '20');
  assert('amount round-trips',       result.decoded.amount      === '250');

  // Custom currency
  var rec2 = { job: 'Delivery', currency: 'NGN', amount: '15000' };
  var r2 = roundTrip(rec2);
  assert('custom currency round-trips', r2.decoded.currency === 'NGN');
})();

// ── expenses and payments ─────────────────────────────────────────────────────

console.log('\nexpenses and payments');
(function() {
  var rec    = { job: 'Site visit', amount: '500.00', currency: 'GBP' };
  var exps   = [
    { amount: '45.00', job: 'Site visit', expense_billing: 'cogs' },
    { amount: '12.50', date: '2026-05-01', expense_billing: 'billable' }
  ];
  var pays   = [
    { amount: '250.00', job: 'Site visit', date: '2026-05-10' }
  ];

  var result = roundTrip(rec, { expenses: exps, payments: pays });

  assert('expenses decoded',              Array.isArray(result.decoded._expenses) && result.decoded._expenses.length === 2);
  assert('expense[0] amount',             result.decoded._expenses[0].amount === '45');
  assert('expense[0] billing',            result.decoded._expenses[0].expense_billing === 'cogs');
  assert('expense[1] amount',             result.decoded._expenses[1].amount === '12.50');
  assert('expense[1] date',               result.decoded._expenses[1].date === '2026-05-01');
  assert('payments decoded',              Array.isArray(result.decoded._payments) && result.decoded._payments.length === 1);
  assert('payment[0] amount',             result.decoded._payments[0].amount === '250');
  assert('payment[0] date',              result.decoded._payments[0].date === '2026-05-10');
})();

// ── extended fields (bits 16–23) ──────────────────────────────────────────────

console.log('\nextended fields (bits 16-23)');
(function() {
  var rec = { job: 'Delivery run' };
  var opts = {
    recordSubtype:   'delivery-note',
    templateLocale:  'ng-v1',
    chainRef:        'AAECBA',    // base64url of 4 bytes; first 3 used
    participants:    [
      { name: 'Ali Musa', role: 'driver' },
      { name: 'Customer Co', role: 'recipient' }
    ],
    geo:             's9m1y',
    serviceRef:      'simba-weather-v1',
    expiry:          120,
    verification:    1
  };

  var result = roundTrip(rec, opts);
  var d = result.decoded;

  assert('record_subtype',      d.record_subtype  === 'delivery-note');
  assert('template_locale',     d.template_locale === 'ng-v1');
  assert('chainRef present',    typeof d._chainRef === 'string' && d._chainRef.length > 0);
  assert('participants count',  Array.isArray(d._participants) && d._participants.length === 2);
  assert('participant[0] name', d._participants[0].name === 'Ali Musa');
  assert('participant[0] role', d._participants[0].role === 'driver');
  assert('participant[1] name', d._participants[1].name === 'Customer Co');
  assert('geo',                 d.geo === 's9m1y');
  assert('service_ref',         d.service_ref === 'simba-weather-v1');
  assert('expiry',              d.expiry === 120);
  assert('verification',        d.verification === 1);
})();

// ── legacy decode: alg=bitpad-v1 (kaios v0.1 format) ─────────────────────────

console.log('\nlegacy decode: alg=bitpad-v1 (kaios v0.1)');
(function() {
  // Re-create a v0.1 URL using the old encoding logic inline
  var fflateLib = window.fflate;
  var enc = new window.TextEncoder();
  function toB64u(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return window.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  // Build a minimal v0.1 frame: 0x01 + uint16 flags + job field
  var jobBytes = enc.encode('Legacy job');
  var frame = new Uint8Array(1 + 2 + 2 + jobBytes.length);
  frame[0] = 0x01;
  frame[1] = 0x00; frame[2] = 0x01; // flags bit 0 = job
  frame[3] = 0x00; frame[4] = jobBytes.length;
  for (var j = 0; j < jobBytes.length; j++) frame[5 + j] = jobBytes[j];

  var compressed = fflateLib.deflateSync(frame, { level: 9 });
  var legacyUrl = 'workpads.me/p#v=1&alg=bitpad-v1&d=' + toB64u(compressed);

  var dec = codec.decode(legacyUrl);
  assert('legacy job decoded', dec.job === 'Legacy job');
})();

// ── legacy decode: 1dg/ (dotme format) ───────────────────────────────────────

console.log('\nlegacy decode: 1dg/ (dotme codebook-c/d)');
(function() {
  var fflateLib = window.fflate;
  var enc = new window.TextEncoder();
  function toB64u(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return window.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  // Build a 1cg-frame: template 0x01, 16-bit flags, binary date at bit 2
  // Fields: job(0), customer(1), date(2 — uint16)
  var jobB = enc.encode('Dotme job');
  var cusB = enc.encode('Dotme customer');
  // date: 2026-04-27 → days since 2020-01-01
  var days = Math.round((Date.UTC(2026, 3, 27) - Date.UTC(2020, 0, 1)) / 86400000);
  var flags = 0x01 | 0x02 | 0x04; // bits 0, 1, 2

  var size = 3 + (2 + jobB.length) + (2 + cusB.length) + 2;
  var frame = new Uint8Array(size);
  var pos = 0;
  frame[pos++] = 0x01;
  frame[pos++] = (flags >>> 8) & 0xff; frame[pos++] = flags & 0xff;
  frame[pos++] = 0x00; frame[pos++] = jobB.length;
  for (var ji = 0; ji < jobB.length; ji++) frame[pos++] = jobB[ji];
  frame[pos++] = 0x00; frame[pos++] = cusB.length;
  for (var ci = 0; ci < cusB.length; ci++) frame[pos++] = cusB[ci];
  frame[pos++] = (days >>> 8) & 0xff; frame[pos++] = days & 0xff;

  var compressed = fflateLib.deflateSync(frame, { level: 9 });
  var dotmeUrl = 'workpads.me/p#1dg/' + toB64u(compressed);

  var dec = codec.decode(dotmeUrl);
  assert('dotme job decoded',      dec.job === 'Dotme job');
  assert('dotme customer decoded', dec.customer === 'Dotme customer');
  assert('dotme date decoded',     dec.date === '2026-04-27');
})();

// ── summary ───────────────────────────────────────────────────────────────────

console.log('\n' + (pass + fail) + ' tests: ' + pass + ' pass  ' + fail + ' fail\n');
if (fail > 0) process.exit(1);
