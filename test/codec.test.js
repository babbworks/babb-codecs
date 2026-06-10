// @workpads/codec — test suite
// Tests pads-v1 (#1pa/) encode/decode round-trips.
// Run: node test/codec.test.js

'use strict';

var codec = require('../src/index');

var pass = 0, fail = 0;

function assert(label, condition, detail) {
  if (condition) { console.log('  PASS  ' + label); pass++; }
  else           { console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); fail++; }
}

// ── Test records ──────────────────────────────────────────────────────────────

var T1 = { job: 'Plumbing leak' };

var T2 = {
  job: 'Fix kitchen tap',
  customer: 'Jane Doe',
  date: '2026-04-26',
  details: 'Job completed, no leaks detected.',
};

var T3 = {
  job: 'HVAC service call',
  customer: 'Acme Logistics',
  date: '2026-04-26',
  location: '14 High Street, Unit 3',
  meeting_time: '09:00',
  start_time: '09:15',
  end_time: '11:30',
  worker: 'M. Plumb',
  details: 'Service complete. Recommend quarterly filter replacement.',
};

var T4 = {
  job: 'Annual boiler service — commercial premises',
  customer: 'Riverside Hotel Group',
  date: '2026-04-26',
  location: 'Riverside Hotel, Boiler Room B2',
  meeting_time: '07:30',
  start_time: '07:45',
  end_time: '14:00',
  customer_phone: '+44 7700 900123',
  worker: 'J. Boiler',
  details: 'Annual service complete. No defects found. Certificate issued.',
  story: 'Arrived on time. Access required key from reception. Left site clean.',
};

// Actions are stored as \n-joined titles in pads-v1 wire format (notes not encoded)
var T5_INPUT = {
  job: 'Multi-step job',
  customer: 'Client',
  date: '2026-05-18',
  actions: [
    { title: 'Inspect site', notes: 'Looks good' },
    { title: 'Do work',      notes: 'Done' },
  ],
};

// ── URL encode/decode round-trips ─────────────────────────────────────────────

console.log('\n── URL encode/decode round-trip (pads-v1 #1pa/) ────────────');

[T1, T2, T3, T4].forEach(function(rec, i) {
  var name = 'T' + (i + 1);
  try {
    var url = codec.encode(rec);
    assert(name + ' URL contains #1pa/', url.indexOf('1pa/') !== -1);
    assert(name + ' URL no alg= param',  url.indexOf('alg=') === -1);
    var decoded = codec.decode(url);
    assert(name + ' job round-trips', decoded.job === rec.job);
    if (rec.customer) assert(name + ' customer round-trips', decoded.customer === rec.customer);
    if (rec.date)     assert(name + ' date round-trips',     decoded.date === rec.date);
    if (rec.location) assert(name + ' location round-trips', decoded.location === rec.location);
    if (rec.details)  assert(name + ' details round-trips',  decoded.details === rec.details);
    if (rec.story)    assert(name + ' story round-trips',    decoded.story === rec.story);
    console.log('        URL length: ' + url.length + ' chars');
  } catch(e) {
    assert(name + ' no error', false, e.message);
  }
});

// ── Actions round-trip ────────────────────────────────────────────────────────

console.log('\n── Actions encoding ────────────────────────────────────────');

try {
  var urlAct = codec.encode(T5_INPUT);
  var decAct = codec.decode(urlAct);
  // pads-v1 stores actions as \n-joined title string — notes are not preserved
  assert('actions field present',    decAct.actions != null);
  assert('actions encodes titles',   String(decAct.actions).indexOf('Inspect site') !== -1);
  assert('actions encodes both',     String(decAct.actions).indexOf('Do work') !== -1);
  console.log('        decoded actions: ' + JSON.stringify(decAct.actions));
} catch(e) {
  assert('actions no error', false, e.message);
}

// ── COMPACT_TIME encoding ─────────────────────────────────────────────────────

console.log('\n── COMPACT_TIME date/time encoding ─────────────────────────');

try {
  var urlCT = codec.encode({ job: 'Time test', date: '2026-05-18', meeting_time: '09:30', start_time: '10:00' });
  var decCT = codec.decode(urlCT);
  assert('date encodes/decodes', decCT.date === '2026-05-18');
  assert('meeting_time encodes/decodes', decCT.meeting_time === '09:30');
  assert('start_time encodes/decodes',   decCT.start_time === '10:00');
} catch(e) {
  assert('COMPACT_TIME no error', false, e.message);
}

// ── Legacy decode routing ─────────────────────────────────────────────────────

console.log('\n── Legacy decode (bitpad-v1 interim scheme) ────────────────');

try {
  // Encode a record with the old package to test legacy decode path
  var oldCodec = require('../src/bitpad');
  var fflate   = require('fflate');
  function toB64(b) { return Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,''); }
  var oldFrame = oldCodec.encode({ job: 'Legacy job', customer: 'Old client' });
  var oldComp  = fflate.deflateSync(oldFrame, { level: 9 });
  var oldUrl   = 'workpads.me/p#v=1&alg=bitpad-v1&d=' + toB64(oldComp);
  var decLeg   = codec.decode(oldUrl);
  assert('legacy bitpad-v1 decodes', decLeg.job === 'Legacy job');
  assert('legacy customer decodes', decLeg.customer === 'Old client');
} catch(e) {
  assert('legacy decode no error', false, e.message);
}

// ── Validate ──────────────────────────────────────────────────────────────────

console.log('\n── validate ────────────────────────────────────────────────');

assert('valid record passes',     codec.validate({ job: 'Test job' }).valid === true);
assert('missing job fails',       codec.validate({}).valid === false);
assert('null record fails',       codec.validate(null).valid === false);
assert('valid actions passes',    codec.validate({ job: 'ok', actions: [{ title: 'step', notes: 'done' }] }).valid === true);
assert('bad actions item fails',  codec.validate({ job: 'ok', actions: [{ title: '' }] }).valid === false);
assert('non-array actions fails', codec.validate({ job: 'ok', actions: 'not-array' }).valid === false);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n── Result: ' + pass + ' passed, ' + fail + ' failed ────────────────\n');
process.exit(fail > 0 ? 1 : 0);
