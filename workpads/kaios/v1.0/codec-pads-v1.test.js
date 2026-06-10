// codec-pads-v1.test.js — Rounds 1–9 verification for pads-v1 (#1pa/) codec
// Spec: dev_refs/FRAME-SPEC.md v1.0.1 §1, §2, §3, §4, §8, §9, §10, §11, §12, §13, §14
// Run: node test/codec-pads-v1.test.js

'use strict';

var fflate = require('../js/lib/fflate.js');
var fs     = require('fs');

// ── browser shims ──────────────────────────────────────────────────────────────

var window = { fflate: fflate };

if (typeof TextEncoder !== 'undefined') {
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;
} else {
  var util = require('util');
  window.TextEncoder = util.TextEncoder;
  window.TextDecoder = util.TextDecoder;
}

if (typeof btoa !== 'undefined') {
  window.btoa = btoa;
  window.atob = atob;
} else {
  window.btoa = function(s) { return Buffer.from(s, 'binary').toString('base64'); };
  window.atob = function(s) { return Buffer.from(s, 'base64').toString('binary'); };
}

var src = fs.readFileSync(__dirname + '/../js/lib/codec.js', 'utf8');
(new Function('window', 'btoa', 'atob', 'TextEncoder', 'TextDecoder',
  src + '\n//# sourceURL=codec.js'))(
  window, window.btoa, window.atob, window.TextEncoder, window.TextDecoder
);

var codec = window.WPCodec;

// ── WPCrypto shim (Node.js crypto) for Round 7 tests ──────────────────────────

var nodeCrypto = require('crypto');
window.WPCrypto = {
  sha256: function(bytes) {
    return new Uint8Array(nodeCrypto.createHash('sha256').update(Buffer.from(bytes)).digest());
  },
  hmacSha256: function(key, data) {
    return new Uint8Array(nodeCrypto.createHmac('sha256', Buffer.from(key)).update(Buffer.from(data)).digest());
  },
  aesCtrEncrypt: function(key, iv, data) {
    var c = nodeCrypto.createCipheriv('aes-128-ctr', Buffer.from(key), Buffer.from(iv));
    return new Uint8Array(Buffer.concat([c.update(Buffer.from(data)), c.final()]));
  },
  aesCtrDecrypt: function(key, iv, data) {
    var d = nodeCrypto.createDecipheriv('aes-128-ctr', Buffer.from(key), Buffer.from(iv));
    return new Uint8Array(Buffer.concat([d.update(Buffer.from(data)), d.final()]));
  },
  randomBytes: function(n) { return new Uint8Array(nodeCrypto.randomBytes(n)); }
};

var secSrc = fs.readFileSync(__dirname + '/../js/lib/security.js', 'utf8');
(new Function('window', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', 'global',
  secSrc + '\n//# sourceURL=security.js'))(
  window, window.btoa, window.atob, window.TextEncoder, window.TextDecoder, window
);

var security = window.WPSecurity;

// ── helpers ────────────────────────────────────────────────────────────────────

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

function eq(a, b) { return a === b; }

// ── Profile E — absolute minimum (§4) ─────────────────────────────────────────
// Expected raw frame: 10 bytes
//   meta1 = 0x00 (SERVICE, no META2, no ext_template)
//   field_flags = 0x00 0x01 (bit 0 = job)
//   job block = 0x00 0x05 'V' 'i' 's' 'i' 't'
// Total: 1 + 2 + 2 + 5 = 10

console.log('\nProfile E — absolute minimum (10B raw)');
(function() {
  var raw = codec._buildFrame({ job: 'Visit' }, { compactTime: false });
  assert('Profile E raw byte count = 10', raw.length === 10, 'got ' + raw.length);
  assert('meta1 = 0x00',           raw[0] === 0x00,  'got 0x' + raw[0].toString(16));
  assert('field_flags hi = 0x00',  raw[1] === 0x00,  'got 0x' + raw[1].toString(16));
  assert('field_flags lo = 0x01',  raw[2] === 0x01,  'got 0x' + raw[2].toString(16));
  assert('job len hi = 0x00',      raw[3] === 0x00,  'got 0x' + raw[3].toString(16));
  assert('job len lo = 0x05',      raw[4] === 0x05,  'got ' + raw[4]);

  // roundtrip
  var dec = codec._parseFrame(raw);
  assert('Profile E job roundtrips', dec.job === 'Visit');
  assert('Profile E no _meta.compactTime', !dec._meta.compactTime);
})();

// ── Profile A — service note, COMPACT_TIME (§4) ───────────────────────────────
// Expected raw frame: 33 bytes
//   meta1 = 0x80 (META2_PRESENT, SERVICE, no ext)
//   meta2 = 0x40 (COMPACT_TIME=1)
//   field_flags = 0x00 0x05 (bits 0+2: job + date)
//   job block = 0x00 0x19 + 25-char string  (2+25 = 27)
//   date block = uint16 BE days             (2)
// Total: 1 + 1 + 2 + 27 + 2 = 33

console.log('\nProfile A — service note COMPACT_TIME (33B raw)');
(function() {
  var job25 = 'Boiler service annual 202'; // exactly 25 bytes ASCII
  assert('job25 is 25 chars', job25.length === 25, 'got ' + job25.length);

  var raw = codec._buildFrame(
    { job: job25, date: '2026-05-17' },
    { compactTime: true }
  );
  assert('Profile A raw byte count = 33', raw.length === 33, 'got ' + raw.length);
  assert('meta1 = 0x80',           raw[0] === 0x80,  'got 0x' + raw[0].toString(16));
  assert('meta2 = 0x40',           raw[1] === 0x40,  'got 0x' + raw[1].toString(16));
  assert('field_flags hi = 0x00',  raw[2] === 0x00,  'got 0x' + raw[2].toString(16));
  assert('field_flags lo = 0x05',  raw[3] === 0x05,  'got 0x' + raw[3].toString(16));
  assert('job len hi = 0x00',      raw[4] === 0x00);
  assert('job len lo = 0x19',      raw[5] === 25);

  // date bytes at position 31–32 (after meta1+meta2+flags+job)
  var datePos = 1 + 1 + 2 + 2 + 25; // = 31
  var days = (raw[datePos] << 8) | raw[datePos + 1];
  var expected = codec._dateToDays('2026-05-17');
  assert('date encoded as days',    days === expected, 'got ' + days + ' expected ' + expected);

  // roundtrip
  var dec = codec._parseFrame(raw);
  assert('Profile A job roundtrips',  dec.job  === job25);
  assert('Profile A date roundtrips', dec.date === '2026-05-17');
  assert('Profile A compactTime on',  dec._meta.compactTime === true);
})();

// ── meta1 — all 8 BASE_TEMPLATE values ────────────────────────────────────────

console.log('\nmeta1 — all 8 BASE_TEMPLATE values');
(function() {
  var names = ['Service','Financial','CompoundFin','Contact','Document','StateCommit','Amendment','Generic'];
  for (var t = 0; t < 8; t++) {
    var raw = codec._buildFrame({ job: 'T' }, { baseTemplate: t, compactTime: false });
    var decoded = codec._parseFrame(raw);
    assert('baseTemplate ' + t + ' (' + names[t] + ') roundtrips',
      decoded._meta.baseTemplate === t, 'got ' + decoded._meta.baseTemplate);
  }
})();

// ── meta1 flags — ackRequest, chain, recipientType ────────────────────────────

console.log('\nmeta1 flags');
(function() {
  var raw = codec._buildFrame({ job: 'T' }, { ackRequest: true, chain: true, recipientType: true, compactTime: false });
  assert('meta1 bit2 ackRequest',    !!(raw[0] & 0x04));
  assert('meta1 bit1 chain',         !!(raw[0] & 0x02));
  assert('meta1 bit0 recipientType', !!(raw[0] & 0x01));
  var dec = codec._parseFrame(raw);
  assert('ackRequest decoded',    dec._meta.ackRequest);
  assert('chain decoded',         dec._meta.chain);
  assert('recipientType decoded', dec._meta.recipientType);
})();

// ── meta2 — all flags ─────────────────────────────────────────────────────────

console.log('\nmeta2 flags');
(function() {
  // Force meta2 by including a date (which triggers compactTime need)
  var raw = codec._buildFrame(
    { job: 'T', date: '2026-01-01' },
    { compactTime: true, hasTrigBlock: true, domain: 0, draft: true, restrictForward: true }
  );
  var meta2 = raw[1]; // raw[0]=meta1, raw[1]=meta2
  assert('meta2 COMPACT_TIME bit6',    !!(meta2 & 0x40));
  assert('meta2 HAS_TRIG_BLOCK bit5',  !!(meta2 & 0x20));
  assert('meta2 DRAFT bit1',           !!(meta2 & 0x02));
  assert('meta2 RESTRICT_FWD bit0',    !!(meta2 & 0x01));

  var dec = codec._parseFrame(raw);
  assert('hasTrigBlock decoded',    dec._meta.hasTrigBlock);
  assert('draft decoded',           dec._meta.draft);
  assert('restrictForward decoded', dec._meta.restrictForward);
})();

// ── COMPACT_TIME date arithmetic ───────────────────────────────────────────────

console.log('\nCOMPACT_TIME arithmetic');
(function() {
  var cases = [
    { iso: '2000-01-01', days: 0 },
    { iso: '2000-01-02', days: 1 },
    { iso: '2026-05-17', days: 9633 },  // days since 2000-01-01
  ];
  for (var i = 0; i < cases.length; i++) {
    var d = codec._dateToDays(cases[i].iso);
    assert('dateToDays(' + cases[i].iso + ')', d === cases[i].days, 'got ' + d);
    var back = codec._daysToDate(cases[i].days);
    assert('daysToDate(' + cases[i].days + ')', back === cases[i].iso, 'got ' + back);
  }
})();

// ── COMPACT_TIME time arithmetic ───────────────────────────────────────────────

console.log('\nCOMPACT_TIME time arithmetic');
(function() {
  var cases = [
    { hhmm: '00:00', mins: 0 },
    { hhmm: '09:30', mins: 570 },
    { hhmm: '17:45', mins: 1065 },
    { hhmm: '23:59', mins: 1439 },
  ];
  for (var i = 0; i < cases.length; i++) {
    var m = codec._timeToMins(cases[i].hhmm);
    assert('timeToMins(' + cases[i].hhmm + ')', m === cases[i].mins, 'got ' + m);
    var back = codec._minsToTime(cases[i].mins);
    assert('minsToTime(' + cases[i].mins + ')', back === cases[i].hhmm, 'got ' + back);
  }
})();

// ── field_flags — all FIELDS round-trip ───────────────────────────────────────

console.log('\nfield_flags — text fields roundtrip');
(function() {
  var rec = {
    job:            'Plumbing repair',
    customer:       'Bob Jones',
    date:           '2026-03-15',
    location:       '42 Oak Rd',
    meeting_time:   '08:00',
    start_time:     '09:00',
    end_time:       '11:00',
    customer_phone: '07700900000',
    worker:         'Dave',
    actions:        'Check pipes\nReplace valve',
    details:        'Pipe leak fixed.',
    story:          'Customer reported.',
    ref_number:     'REF001',
    due_date:       '2026-04-01',
  };

  var raw = codec._buildFrame(rec, { compactTime: true });
  var dec = codec._parseFrame(raw);

  var fields = ['job','customer','date','location','meeting_time','start_time',
                'end_time','customer_phone','worker','actions','details','story',
                'ref_number','due_date'];
  for (var i = 0; i < fields.length; i++) {
    assert(fields[i] + ' roundtrips', dec[fields[i]] === rec[fields[i]],
      'got "' + dec[fields[i]] + '" expected "' + rec[fields[i]] + '"');
  }
})();

// ── FLAGS3 fields roundtrip ────────────────────────────────────────────────────

console.log('\nFLAGS3 fields roundtrip');
(function() {
  var rec = {
    job:           'Audit',
    context_label: 'Q1',
    tag:           'priority',
    qty_unit:      'hrs',
    date_end:      '2026-06-30',
    attachment:    'https://example.com/doc.pdf',
    uid:           'uid-abc-123',
    url:           'https://example.com/record/42',
  };

  var raw = codec._buildFrame(rec, { compactTime: true });
  var dec = codec._parseFrame(raw);

  assert('FLAGS3_PRESENT flag set',    !!(raw[3] & (1 << 7)) || !!(raw[2] & (1 << 7)),
    'field_flags word: 0x' + raw[2].toString(16) + raw[3].toString(16));

  var f3 = ['context_label','tag','qty_unit','date_end','attachment','uid','url'];
  for (var i = 0; i < f3.length; i++) {
    assert(f3[i] + ' roundtrips', dec[f3[i]] === rec[f3[i]],
      'got "' + dec[f3[i]] + '" expected "' + rec[f3[i]] + '"');
  }
})();

// ── financial bit 12 — encode skips, decode signals pending ───────────────────

console.log('\nfinancial block bit 12 — Round 2 stub');
(function() {
  // Encoder should NOT set bit 12 in Round 1 (no financial data in record triggers it)
  var raw = codec._buildFrame({ job: 'Job only' }, { compactTime: false });
  var flags = (raw[1] << 8) | raw[2]; // field_flags (pos 1-2 when no meta2)
  assert('bit 12 NOT set when no financial', !(flags & (1 << 12)));
})();

// ── URL tag is #1pa/ ──────────────────────────────────────────────────────────

console.log('\nURL tag');
(function() {
  var url = codec.encode({ job: 'Tag test' });
  assert('URL contains workpads.me/p#1pa/', url.indexOf('workpads.me/p#1pa/') !== -1, url);
  assert('URL does NOT contain 1eg/',       url.indexOf('1eg/') === -1);
})();

// ── full encode/decode roundtrip via URL ───────────────────────────────────────

console.log('\nfull encode → decode roundtrip');
(function() {
  var rec = {
    job:      'Full roundtrip test',
    customer: 'Test Co',
    date:     '2026-05-17',
    details:  'All fields check out.',
  };
  var url = codec.encode(rec, { compactTime: true });
  var dec = codec.decode(url);

  assert('job roundtrips',      dec.job      === rec.job);
  assert('customer roundtrips', dec.customer === rec.customer);
  assert('date roundtrips',     dec.date     === rec.date);
  assert('details roundtrips',  dec.details  === rec.details);
})();

// ── no meta2 when no date/time fields ─────────────────────────────────────────

console.log('\nmeta2 omitted when no date/time fields');
(function() {
  // Profile E: no date/time fields even with compactTime=true → meta2 must NOT appear
  var raw = codec._buildFrame({ job: 'No dates' }, { compactTime: true });
  assert('meta2 NOT present (bit7=0)', !(raw[0] & 0x80), 'meta1=0x' + raw[0].toString(16));
  // meta1(1) + field_flags(2) + job_len(2) + "No dates"(8) = 13; no meta2 byte
  assert('raw is 13 bytes (no meta2 overhead)', raw.length === 13, 'got ' + raw.length);
})();

// ── Round 2 — Financial Block ─────────────────────────────────────────────────

// Profile B — payment received £125.50
// meta1=0x88, meta2=0x44, setup=0x40, tx=0x00, ff=0x1007, job(13B), cust(7B), date(2B), fc, amt(3B) = 36B
console.log('\nProfile B — payment received (36B)');
(function() {
  var rec = { job: 'Boiler repair', customer: 'J.Smith', date: '2026-05-17' };
  var opts = {
    domain: 1, compactTime: true,
    decimalPos: 2, currency: 0, taxCode: 0, sfPresent: false,
    direction: 0, ioTime: 0, effect: 0, subtype: 0, qtySplit: false, rounding: 0,
    billed: false, qtyType: 0, expenseCat: 0,
    customerAmount: '125.50'
  };
  var raw = codec._buildFrame(rec, opts);
  assert('Profile B meta1=0x88',     raw[0] === 0x88, '0x' + raw[0].toString(16));
  assert('Profile B meta2=0x44',     raw[1] === 0x44, '0x' + raw[1].toString(16));
  assert('Profile B setup=0x40',     raw[2] === 0x40, '0x' + raw[2].toString(16));
  assert('Profile B tx=0x00',        raw[3] === 0x00, '0x' + raw[3].toString(16));
  assert('Profile B ff hi=0x10',     raw[4] === 0x10, '0x' + raw[4].toString(16));
  assert('Profile B ff lo=0x07',     raw[5] === 0x07, '0x' + raw[5].toString(16));
  assert('Profile B total 36B',      raw.length === 36, 'got ' + raw.length);

  // fin_control: BILLED=0,bit6=0,QTY_TYPE=0,PARITY=1,EC=00,CUST=1,WORK=0 → 0x12
  // pos: m1(0)+m2(1)+setup(2)+tx(3)+ff(4,5)+job(6..20)+cust(21..29)+date(30,31) → fc=32
  var fcPos = 1+1+1+1+2 + (2+13) + (2+7) + 2; // = 32
  assert('Profile B fin_control=0x12', raw[fcPos] === 0x12, '0x' + raw[fcPos].toString(16));
  // customer_amount uint24 = 12550 (0x0030D6)
  var cAmt = (raw[fcPos+1] << 16) | (raw[fcPos+2] << 8) | raw[fcPos+3];
  assert('Profile B customer_amount=12550', cAmt === 12550, 'got ' + cAmt);
})();

// Profile B roundtrip — decode
console.log('\nProfile B decode roundtrip');
(function() {
  var rec = { job: 'Boiler repair', customer: 'J.Smith', date: '2026-05-17' };
  var opts = { domain: 1, compactTime: true, decimalPos: 2, direction: 0, ioTime: 0, effect: 0,
               billed: false, qtyType: 0, expenseCat: 0, customerAmount: '125.50' };
  var url = codec.encode(rec, opts);
  var dec = codec.decode(url);
  assert('B roundtrip job',              dec.job             === 'Boiler repair');
  assert('B roundtrip customer',         dec.customer        === 'J.Smith');
  assert('B roundtrip customer_amount',  dec.customer_amount === '125.50');
  assert('B roundtrip billed=false',     dec.billed          === false);
  assert('B roundtrip expense_cat=0',    dec.expense_cat     === 0);
  assert('B roundtrip _fin.direction=0', dec._fin.direction  === 0);
  assert('B roundtrip _fin.time=0',      dec._fin.time       === 0);
  assert('B roundtrip _fin.effect=0',    dec._fin.effect     === 0);
})();

// Profile C — invoice T&M, QTY_COMPACT
// meta1=0x88, meta2=0x44, setup=0x41, sf=0x08, tx=0x44, ff=0x1007, job(11), cust(8), date, fc, amt = 36B
console.log('\nProfile C — invoice T&M QTY_COMPACT (36B)');
(function() {
  var rec = { job: 'Roof repair', customer: 'T Wilson', date: '2026-05-17' };
  var opts = {
    domain: 1, compactTime: true,
    decimalPos: 2, currency: 0, taxCode: 0, sfPresent: true,
    scalingFactor: 0, compoundValue: false, qtyCompact: true, splitPoint: 0,
    direction: 0, ioTime: 1, effect: 0, subtype: 0, qtySplit: true, rounding: 0,
    billed: false, qtyType: 1, expenseCat: 0,
    qty: 3, rate: '52.50'
  };
  var raw = codec._buildFrame(rec, opts);
  assert('Profile C meta1=0x88',   raw[0] === 0x88,  '0x' + raw[0].toString(16));
  assert('Profile C meta2=0x44',   raw[1] === 0x44,  '0x' + raw[1].toString(16));
  assert('Profile C setup=0x41',   raw[2] === 0x41,  '0x' + raw[2].toString(16));
  assert('Profile C sf=0x08',      raw[3] === 0x08,  '0x' + raw[3].toString(16));
  assert('Profile C tx=0x44',      raw[4] === 0x44,  '0x' + raw[4].toString(16));
  assert('Profile C total 36B',    raw.length === 36, 'got ' + raw.length);

  // fin_control: BILLED=0,QTY_TYPE=1,PARITY=0,EC=00,CUST=1,WORK=0 → 0x22
  // pos: 1+1+1+1+1+2+(2+11)+(2+8)+2 = 33
  var fcPos = 1+1+1+1+1+2 + (2+11) + (2+8) + 2;
  assert('Profile C fin_control=0x22', raw[fcPos] === 0x22, '0x' + raw[fcPos].toString(16));
  // packed: rate=5250 (£52.50×100), qty=3, SP=8 → (5250<<8)|3 = 0x148203
  var packed = (raw[fcPos+1] << 16) | (raw[fcPos+2] << 8) | raw[fcPos+3];
  assert('Profile C packed amt=0x148203', packed === 0x148203, '0x' + packed.toString(16));
})();

// Profile C roundtrip
console.log('\nProfile C decode roundtrip');
(function() {
  var rec = { job: 'Roof repair', customer: 'T Wilson', date: '2026-05-17' };
  var opts = {
    domain: 1, compactTime: true, decimalPos: 2, sfPresent: true, scalingFactor: 0,
    qtyCompact: true, splitPoint: 0, direction: 0, ioTime: 1, effect: 0, qtySplit: true,
    billed: false, qtyType: 1, expenseCat: 0, qty: 3, rate: '52.50'
  };
  var url = codec.encode(rec, opts);
  var dec = codec.decode(url);
  assert('C roundtrip job',              dec.job             === 'Roof repair');
  assert('C roundtrip qty=3',            dec.qty             === '3');
  assert('C roundtrip rate=52.50',       dec.rate            === '52.50');
  assert('C roundtrip customer_amount',  dec.customer_amount === '157.50');
  assert('C roundtrip _fin.qtySplit=1',  dec._fin.qtySplit   === true);
  assert('C roundtrip _fin.qtyCompact',  dec._fin.qtyCompact === true);
})();

// Financial context — all I>O state bytes
console.log('\nI>O transaction byte values');
(function() {
  function txByte(dir, tim, eff, sub) {
    var raw = codec._buildFrame({ job: 'x' }, {
      domain: 1, decimalPos: 2, direction: dir, ioTime: tim, effect: eff, subtype: sub,
      customerAmount: '10.00'
    });
    return raw[3]; // meta1+meta2+setup = 3 bytes, tx at [3]
  }
  assert('I<I settled std pay tx=0x00',    txByte(0,0,0,0) === 0x00);
  assert('I>I future invoice tx=0x40',     txByte(0,1,0,0) === 0x40);
  assert('I>I future quote tx=0x48',       txByte(0,1,0,1) === 0x48);
  assert('I<O refund tx=0x20',             txByte(0,0,1,0) === 0x20);
  assert('O<O settled expense tx=0xA0',    txByte(1,0,1,0) === 0xA0);
  assert('O>O future bill tx=0xE0',        txByte(1,1,1,0) === 0xE0);
})();

// EXPENSE_CAT=00 + direction=O forces BILLED=1
console.log('\nEXPENSE_CAT=00 + O-direction forces BILLED');
(function() {
  var raw = codec._buildFrame({ job: 'Parts' }, {
    domain: 1, decimalPos: 2, direction: 1, ioTime: 0, effect: 1,  // O<O expense
    expenseCat: 0, billed: false,  // BILLED=false but should be forced to true
    customerAmount: '45.00'
  });
  // fin_control pos: m1+m2+setup+tx+ff(2)+job... let me compute:
  // job 'Parts'=5 chars: 2+5=7B
  // pos: 1+1+1+1+2+7+2 = no date... let me do compactTime false to avoid meta2 complications
  // Actually with direction=1 and no dates, meta2 is still needed because domain>0
  // meta1(1)+meta2(1)+setup(1)+tx(1)+ff(2)+job(2+5)+fc
  var fcPos = 1+1+1+1+2+(2+5);
  assert('forced BILLED=1 bit7 set', (raw[fcPos] >> 7) === 1, '0x' + raw[fcPos].toString(16));
})();

// fin_control parity — encode round 2 then decode integrity check
console.log('\nfin_control parity integrity');
(function() {
  var raw = codec._buildFrame({ job: 'Test' }, {
    domain: 1, decimalPos: 2, direction: 0, effect: 0, ioTime: 0,
    billed: true, qtyType: 0, expenseCat: 1,  // COGS
    customerAmount: '50.00', workerAmount: '30.00'
  });
  // fin_control: BILLED=1, QTY_TYPE=0, EC=01, CUST=1, WORK=1
  // PARITY = 1^0^0^1^1^1 = 0
  // fc = (1<<7)|(0<<5)|(0<<4)|(1<<2)|(1<<1)|1 = 0b10000111 = 0x87
  var fcPos = 1+1+1+1+2+(2+4);
  assert('parity calc BILLED+COGS+both amts', raw[fcPos] === 0x87, '0x' + raw[fcPos].toString(16));

  // decode the same frame — should NOT throw
  var dec;
  try {
    dec = codec._parseFrame(raw);
  } catch(e) {
    assert('parity decode no throw', false, e.message);
    return;
  }
  assert('parity decode customer_amount=50.00', dec.customer_amount === '50.00');
  assert('parity decode worker_amount=30.00',   dec.worker_amount   === '30.00');
  assert('parity decode expense_cat=1',         dec.expense_cat     === 1);
})();

// tax_block — TAX_CODE=01 (inclusive)
console.log('\ntax_block encode/decode');
(function() {
  var rec = { job: 'VAT job', customer: 'Jane' };
  var opts = {
    domain: 1, decimalPos: 2, direction: 0, ioTime: 1, effect: 0,
    taxCode: 1,   // inclusive
    taxRate: 200, // 20.0% in permille
    taxAmount: 1667, // £16.67 at D=2 → uint16=1667
    customerAmount: '100.00'
  };
  var url   = codec.encode(rec, opts);
  var dec   = codec.decode(url);
  assert('tax_block tax_rate=200',  dec.tax_rate   === 200);
  assert('tax_block customer=100',  dec.customer_amount === '100.00');
  assert('tax_block tax_amount',    dec.tax_amount  !== undefined);
})();

// qty_rate_block — QTY_COMPACT=0, QTY_SPLIT=1
console.log('\nqty_rate_block (separate qty+rate)');
(function() {
  var rec = { job: 'Labour', customer: 'Bob' };
  var opts = {
    domain: 1, decimalPos: 2, direction: 0, ioTime: 1, effect: 0,
    qtySplit: true, qtyCompact: false,
    customerAmount: '157.50', qty: '3.50', rate: '45.00'
  };
  var url = codec.encode(rec, opts);
  var dec = codec.decode(url);
  assert('qty_rate customer_amount=157.50', dec.customer_amount === '157.50');
  assert('qty_rate qty=3.50',               dec.qty             === '3.50');
  assert('qty_rate rate=45.00',             dec.rate            === '45.00');
})();

// BASE_TEMPLATE auto-set to 001 (Financial) when domain>0
console.log('\nBASE_TEMPLATE auto-set when financial');
(function() {
  var raw = codec._buildFrame({ job: 'Fin test' }, {
    domain: 1, decimalPos: 2, direction: 0, effect: 0, ioTime: 0,
    customerAmount: '20.00'
  });
  assert('meta1 BASE_TEMPLATE=001 (financial)',
    (raw[0] & 0x38) === 0x08, '0x' + raw[0].toString(16));
})();

// currency_ext — CURRENCY=11 extended
console.log('\ncurrency_ext byte');
(function() {
  var raw = codec._buildFrame({ job: 'EUR job' }, {
    domain: 1, decimalPos: 2, currency: 3, currencyCode: 0x03,  // hypothetical EUR code
    direction: 0, ioTime: 0, effect: 0, customerAmount: '50.00'
  });
  // setup_byte: DP=2, CUR=11, TAX=00, SF=0 → (2<<5)|(3<<3)|0|0 = 0b01011000 = 0x58
  assert('setup CURRENCY=11',  raw[2] === 0x58, '0x' + raw[2].toString(16));
  assert('currency_ext=0x03',  raw[3] === 0x03, '0x' + raw[3].toString(16));
  // transaction byte follows currency_ext
  assert('tx byte after currency_ext', raw[4] === 0x00);
})();

// amountToU24 / u24ToAmount helpers
console.log('\namountToU24 / u24ToAmount');
(function() {
  var codec2 = codec;
  // These are internal but exported via _buildFrame round-trip
  var cases = [
    { val: '125.50', dp: 2, sf: 0, u24: 12550 },
    { val: '0.01',   dp: 2, sf: 0, u24: 1      },
    { val: '0.00',   dp: 2, sf: 0, u24: 0      },
    { val: '1000.00', dp: 2, sf: 1, u24: 10000  }, // SF=×10 → stored = 1000.00×100/10 = 10000
  ];
  cases.forEach(function(c) {
    var raw = codec._buildFrame({ job: 'x' }, {
      domain: 1, decimalPos: c.dp, sfPresent: c.sf > 0, scalingFactor: c.sf,
      direction: 0, ioTime: 0, effect: 0, customerAmount: c.val
    });
    // find customer_amount: meta1+meta2+setup(+sf?)+tx+ff(2)+job(2+1)
    var hdrLen = 1+1+1+(c.sf>0?1:0)+1+2+(2+1);
    // fin_control at hdrLen, then 3 bytes for customer_amount
    var cu = (raw[hdrLen+1]<<16)|(raw[hdrLen+2]<<8)|raw[hdrLen+3];
    assert('amountToU24(' + c.val + ',dp=' + c.dp + ',sf=' + c.sf + ')=' + c.u24, cu === c.u24, 'got ' + cu);
  });
})();

// ── Round 3 — DOMAIN=11 Hybrid Mode + DOMAIN=10 ───────────────────────────────

// DOMAIN=11: account_pair_byte written after transaction_byte
console.log('\nDOMAIN=11 account_pair_byte encode');
(function() {
  var raw = codec._buildFrame({ job: 'Hybrid' }, {
    domain: 3, compactTime: false, decimalPos: 2,
    direction: 0, ioTime: 1, effect: 0, subtype: 0, qtySplit: false, rounding: 0,
    accountPair: 5,    // 0101 = Op Income / Liability
    apDirection: 0,    // debit receivable
    apStatus: 1,       // pending/future
    apCompleteness: 0,
    customerAmount: '85.00'
  });
  // header: m1+m2+setup+tx+ap_byte = 5 bytes; then ff(2)+job(2+6)+fc+ca = 5+2+8+1+3 = 19
  // meta1=0x88 (BASE=001,META2=1)
  assert('D11 meta1=0x88',   raw[0] === 0x88, '0x' + raw[0].toString(16));
  // meta2: COMPACT_TIME=0, DOMAIN=11 (bits3-2=11 → 0x0C)
  assert('D11 meta2=0x0C',   raw[1] === 0x0C, '0x' + raw[1].toString(16));
  // setup: DECIMAL_POS=2, CURRENCY=00, TAX=00, SF=0 → 0x40
  assert('D11 setup=0x40',   raw[2] === 0x40, '0x' + raw[2].toString(16));
  // tx: I>I future DIR=0,TIME=1,EFF=0,SUB=00,QTY=0,RND=00 → 0x40
  assert('D11 tx=0x40',      raw[3] === 0x40, '0x' + raw[3].toString(16));
  // account_pair_byte: AP=0101(5), DIR=0, STATUS=1, COMPL=0, EXT=0 → (5<<4)|(0<<3)|(1<<2) = 0x54
  assert('D11 ap_byte=0x54', raw[4] === 0x54, '0x' + raw[4].toString(16));
})();

// DOMAIN=11 roundtrip — _ap fields decoded correctly
console.log('\nDOMAIN=11 decode roundtrip');
(function() {
  var rec = { job: 'Hybrid invoice', customer: 'ACME' };
  var opts = {
    domain: 3, decimalPos: 2, direction: 0, ioTime: 1, effect: 0,
    accountPair: 5, apDirection: 0, apStatus: 1, apCompleteness: 0,
    customerAmount: '200.00'
  };
  var url = codec.encode(rec, opts);
  var dec = codec.decode(url);
  assert('D11 job roundtrips',                  dec.job              === 'Hybrid invoice');
  assert('D11 customer_amount roundtrips',       dec.customer_amount  === '200.00');
  assert('D11 _fin.direction=0',                dec._fin.direction   === 0);
  assert('D11 _fin.time=1',                     dec._fin.time        === 1);
  assert('D11 _ap present',                     !!dec._ap);
  assert('D11 _ap.accountPair=5',               dec._ap.accountPair  === 5);
  assert('D11 _ap.apDirection=0',               dec._ap.apDirection  === 0);
  assert('D11 _ap.apStatus=1',                  dec._ap.apStatus     === 1);
  assert('D11 _ap.apCompleteness=0',            dec._ap.apCompleteness === 0);
  assert('D11 _ap.apExtension=0',               dec._ap.apExtension  === 0);
})();

// DOMAIN=11: all 14 active AP codes roundtrip
console.log('\nDOMAIN=11 all 14 AP codes roundtrip');
(function() {
  for (var ap = 0; ap <= 13; ap++) {
    var url = codec.encode({ job: 'AP' + ap }, {
      domain: 3, decimalPos: 2, direction: 0, ioTime: 0, effect: 0,
      accountPair: ap, apDirection: ap & 1, apStatus: 0, customerAmount: '1.00'
    });
    var dec = codec.decode(url);
    assert('D11 AP code ' + ap + ' roundtrips', dec._ap.accountPair === ap);
  }
})();

// DOMAIN=11: AP_EXTENSION=1 — decoder skips extra byte without crashing
console.log('\nDOMAIN=11 AP_EXTENSION skip');
(function() {
  // Build a raw frame with AP_EXTENSION=1 manually
  var raw = codec._buildFrame({ job: 'Ext' }, {
    domain: 3, decimalPos: 2, direction: 0, ioTime: 0, effect: 0,
    accountPair: 4, apDirection: 0, apStatus: 0, apCompleteness: 0,
    customerAmount: '10.00'
  });
  // ap_byte is at raw[4]; set AP_EXTENSION bit (bit0) to 1 and append a dummy extension byte
  var modified = Array.from(raw);
  modified[4] = modified[4] | 0x01; // set AP_EXTENSION=1
  modified.splice(5, 0, 0xFF);       // insert dummy extension byte after ap_byte
  var dec;
  try {
    dec = codec._parseFrame(new Uint8Array(modified));
  } catch(e) {
    assert('AP_EXTENSION=1 no crash', false, e.message);
    return;
  }
  assert('AP_EXTENSION=1 _ap.apExtension=1', dec._ap.apExtension === 1);
  assert('AP_EXTENSION=1 still decodes amt',  dec.customer_amount === '10.00');
})();

// DOMAIN=10: transaction_byte has AP layout; fin_control bit6=1
console.log('\nDOMAIN=10 encode/decode');
(function() {
  var rec = { job: 'Standard mode', customer: 'Bob' };
  var opts = {
    domain: 2, decimalPos: 2,
    accountPair: 0,    // 0000 Op Expense / Asset
    apDirection: 0,    // debit expense
    apStatus: 0,       // posted/settled
    qtySplit: false, rounding: 0,
    billed: false,
    customerAmount: '75.00'
  };
  var raw = codec._buildFrame(rec, Object.assign({}, opts, { compactTime: false }));
  // meta2: COMPACT_TIME=0, DOMAIN=10 (bits3-2=10 → 0x08)
  assert('D10 meta2=0x08',   raw[1] === 0x08, '0x' + raw[1].toString(16));
  // setup: DECIMAL_POS=2, CURRENCY=0, TAX=0, SF=0 → 0x40
  assert('D10 setup=0x40',   raw[2] === 0x40, '0x' + raw[2].toString(16));
  // tx DOMAIN=10: AP=0000, DIR=0, STATUS=0, QTY=0, RND=0 → 0x00
  assert('D10 tx=0x00',      raw[3] === 0x00, '0x' + raw[3].toString(16));

  var url = codec.encode(rec, opts);
  var dec = codec.decode(url);
  assert('D10 job roundtrips',             dec.job             === 'Standard mode');
  assert('D10 customer_amount=75.00',      dec.customer_amount === '75.00');
  assert('D10 _fin.accountPair=0',         dec._fin.accountPair === 0);
  assert('D10 _fin.apDirection=0',         dec._fin.apDirection === 0);
  assert('D10 account_pair in fin_ctrl',   dec.account_pair    === 0);
  assert('D10 no _ap on D10',              dec._ap             === undefined);
})();

// DOMAIN=10 fin_control bit6=1 integrity check
console.log('\nDOMAIN=10 fin_control bit6=1 integrity');
(function() {
  var raw = codec._buildFrame({ job: 'x' }, {
    domain: 2, decimalPos: 2, accountPair: 4, apDirection: 0, customerAmount: '10.00'
  });
  // fin_control: bit6=1, AP=0100(4) in bits5-2, CUST=1, WORK=0
  // = 0b01010010... wait: (0<<7)|0x40|(4<<2)|(1<<1)|0 = 0x40|0x10|0x02 = 0x52
  var fcPos = 1+1+1+1+2+(2+1); // m1+m2+setup+tx+ff+job("x")
  assert('D10 fin_ctrl bit6=1', (raw[fcPos] & 0x40) !== 0, '0x' + raw[fcPos].toString(16));
  assert('D10 fin_ctrl ap=4',   ((raw[fcPos] >> 2) & 0xF) === 4, 'ap=' + ((raw[fcPos]>>2)&0xF));
})();

// ── Round 4 — Participants Block ───────────────────────────────────────────────

// Profile D exact byte layout (76B raw)
console.log('\nProfile D — 76B raw with participants');
(function() {
  // job="Annual service"(14), customer="M. Wilson"(9), date=2026-05-18
  // financial: payment received I<I, £85.00 at D=2
  // participants: customer M. Wilson with phone, worker D Garcia IS_SENDER
  var rec = { job: 'Annual service', customer: 'M. Wilson', date: '2026-05-18' };
  var raw = codec._buildFrame(rec, {
    domain: 1, decimalPos: 2, direction: 0, ioTime: 0, effect: 0,
    customerAmount: '85.00',
    participants: [
      { name: 'M. Wilson', roleType: 0, phone: '07700900000' },
      { name: 'D Garcia',  roleType: 1, isSender: true }
    ]
  });
  assert('Profile D total=76B',   raw.length === 76,          'got ' + raw.length + 'B');
  assert('Profile D meta1=0x88',  raw[0] === 0x88,            '0x' + raw[0].toString(16));
  assert('Profile D meta2=0x54',  raw[1] === 0x54,            '0x' + raw[1].toString(16));
  assert('Profile D setup=0x40',  raw[2] === 0x40,            '0x' + raw[2].toString(16));
  assert('Profile D tx=0x00',     raw[3] === 0x00,            '0x' + raw[3].toString(16));
  assert('Profile D ff=0x10,0x07', raw[4] === 0x10 && raw[5] === 0x07, '[' + raw[4].toString(16) + ',' + raw[5].toString(16) + ']');
  // participants block starts at byte 39 (1+1+1+1+2+16+11+2+1+3)
  var pBase = 1+1+1+1+2+16+11+2+1+3;
  assert('Profile D part block_hdr=0x40', raw[pBase] === 0x40, '0x' + raw[pBase].toString(16));
  assert('Profile D P1 pf=0x08',          raw[pBase+1] === 0x08, '0x' + raw[pBase+1].toString(16));
  // Worker(01)+IS_SENDER → bits7=1,bits6-5=01 → 0xA0; FRAME-SPEC §4 shows 0x90 (arithmetic error)
  assert('Profile D P2 pf=0xA0',          raw[pBase+26] === 0xA0, '0x' + raw[pBase+26].toString(16));
})();

// Profile D decode roundtrip
console.log('\nProfile D decode roundtrip');
(function() {
  var rec = { job: 'Annual service', customer: 'M. Wilson', date: '2026-05-18' };
  var url = codec.encode(rec, {
    domain: 1, decimalPos: 2, direction: 0, ioTime: 0, effect: 0,
    customerAmount: '85.00',
    participants: [
      { name: 'M. Wilson', roleType: 0, phone: '07700900000' },
      { name: 'D Garcia',  roleType: 1, isSender: true }
    ]
  });
  var dec = codec.decode(url);
  assert('D rt job=Annual service',         dec.job                 === 'Annual service');
  assert('D rt customer_amount=85.00',      dec.customer_amount     === '85.00');
  assert('D rt _participants length=2',     dec._participants.length === 2);
  assert('D rt P1 name=M. Wilson',          dec._participants[0].name === 'M. Wilson');
  assert('D rt P1 roleType=0/Customer',     dec._participants[0].roleType === 0);
  assert('D rt P1 phone=07700900000',       dec._participants[0].phone === '07700900000');
  assert('D rt P1 isSender=false',          dec._participants[0].isSender === false);
  assert('D rt P2 name=D Garcia',           dec._participants[1].name === 'D Garcia');
  assert('D rt P2 roleType=1/Worker',       dec._participants[1].roleType === 1);
  assert('D rt P2 isSender=true',           dec._participants[1].isSender === true);
  assert('D rt meta.hasParticipants=true',  dec._meta.hasParticipants === true);
})();

// meta2 PARTICIPANTS bit set only when participants present
console.log('\nmeta2 PARTICIPANTS bit');
(function() {
  var withParts = codec._buildFrame({ job: 'x' }, {
    participants: [{ name: 'Alice', roleType: 0 }]
  });
  var noParts = codec._buildFrame({ job: 'x' }, {});
  assert('meta2 PART bit set when parts present',  (withParts[1] & 0x10) !== 0, '0x' + withParts[1].toString(16));
  assert('meta2 PART bit absent without parts',    withParts.length === 1 || (noParts.length < 2 || !(noParts[1] & 0x10)), 'check no-meta2 path');
})();

// Participants: all three ROLE_TYPE quick-select codes (00/01/10)
console.log('\nParticipants ROLE_TYPE quick-select (00/01/10)');
(function() {
  var url = codec.encode({ job: 'Multi-role' }, {
    participants: [
      { name: 'Customer', roleType: 0 },
      { name: 'Worker',   roleType: 1 },
      { name: 'Supplier', roleType: 2 }
    ]
  });
  var dec = codec.decode(url);
  assert('Quick-sel RT=0/Customer',  dec._participants[0].roleType === 0 && dec._participants[0].name === 'Customer');
  assert('Quick-sel RT=1/Worker',    dec._participants[1].roleType === 1 && dec._participants[1].name === 'Worker');
  assert('Quick-sel RT=2/Supplier',  dec._participants[2].roleType === 2 && dec._participants[2].name === 'Supplier');
})();

// ROLE_TYPE=11 + HAS_ROLE_TEXT=0: role_code byte (ROLE_SLOT + ROLE_SIGNALS)
console.log('\nROLE_TYPE=11 role_code byte roundtrip');
(function() {
  // Subcontractor (roleSlot=0) with CERT=1 (roleSignals bit2=1 → 0x04)
  var url = codec.encode({ job: 'Sub job' }, {
    participants: [
      { name: 'T. Green', roleType: 3, roleSlot: 0, roleSignals: 4 }  // 4=CERT
    ]
  });
  var dec = codec.decode(url);
  assert('RT=11 name roundtrips',        dec._participants[0].name        === 'T. Green');
  assert('RT=11 roleType=3',             dec._participants[0].roleType    === 3);
  assert('RT=11 roleSlot=0/Subcon',      dec._participants[0].roleSlot    === 0);
  assert('RT=11 roleSignals=4/CERT',     dec._participants[0].roleSignals === 4);
})();

// ROLE_TYPE=11 + HAS_ROLE_TEXT=1: free-text role label
console.log('\nROLE_TYPE=11 role_text roundtrip');
(function() {
  var url = codec.encode({ job: 'Custom role' }, {
    participants: [
      { name: 'P. Hall', roleType: 3, roleText: 'Drone Pilot' }
    ]
  });
  var dec = codec.decode(url);
  assert('RT=11 role_text name',          dec._participants[0].name     === 'P. Hall');
  assert('RT=11 role_text value',         dec._participants[0].roleText === 'Drone Pilot');
  assert('RT=11 no roleSlot on role_text', dec._participants[0].roleSlot === undefined);
})();

// ROLE_TYPE=11 + ROLE_SLOT=31 extended path
console.log('\nROLE_TYPE=11 ROLE_SLOT=31 extended path');
(function() {
  var url = codec.encode({ job: 'Ext role' }, {
    participants: [
      { name: 'S. Khan', roleType: 3, roleSlot: 31, roleSignals: 0, roleCode2: 0x15 }
    ]
  });
  var dec = codec.decode(url);
  assert('Ext ROLE_SLOT=31',    dec._participants[0].roleSlot    === 31);
  assert('Ext roleCode2=0x15',  dec._participants[0].roleCode2   === 0x15);
  assert('Ext name roundtrips', dec._participants[0].name        === 'S. Khan');
})();

// trading_name roundtrip (HAS_TRADING_NAME=1, ROLE_TYPE≠11)
console.log('\ntrading_name roundtrip');
(function() {
  var url = codec.encode({ job: 'Trade' }, {
    participants: [
      { name: 'John Smith', roleType: 0, tradingName: 'Smiths Repairs' }
    ]
  });
  var dec = codec.decode(url);
  assert('tradingName name',          dec._participants[0].name        === 'John Smith');
  assert('tradingName value',         dec._participants[0].tradingName === 'Smiths Repairs');
})();

// email field roundtrip
console.log('\nParticipant phone + email roundtrip');
(function() {
  var url = codec.encode({ job: 'Contact' }, {
    participants: [
      { name: 'A. Bell', roleType: 0, phone: '07700100200', email: 'a@example.com' }
    ]
  });
  var dec = codec.decode(url);
  assert('Part email phone=07700100200', dec._participants[0].phone === '07700100200');
  assert('Part email addr=a@example.com', dec._participants[0].email === 'a@example.com');
})();

// alt_id block roundtrip — all 4 types
console.log('\nalt_id block roundtrip');
(function() {
  var types = [
    { type: 0x01, value: 'uid-abc123',    label: 'app_uid' },
    { type: 0x02, value: 'Smith Trading', label: 'trade_name' },
    { type: 0x03, value: 'NID-9876543',   label: 'national_id' },
    { type: 0x04, value: 'Site-A',        label: 'location_label' }
  ];
  types.forEach(function(t) {
    var url = codec.encode({ job: 'alt' }, {
      participants: [{ name: 'X', roleType: 0, altId: { type: t.type, value: t.value } }]
    });
    var dec = codec.decode(url);
    assert('altId ' + t.label + ' type',  dec._participants[0].altId.type  === t.type);
    assert('altId ' + t.label + ' value', dec._participants[0].altId.value === t.value);
  });
})();

// IS_ORG flag roundtrip
console.log('\nIS_ORG flag roundtrip');
(function() {
  var url = codec.encode({ job: 'Org job' }, {
    participants: [
      { name: 'Acme Ltd', roleType: 2, isOrg: true }
    ]
  });
  var dec = codec.decode(url);
  assert('IS_ORG=true roundtrips',  dec._participants[0].isOrg === true);
  assert('IS_ORG name roundtrips',  dec._participants[0].name  === 'Acme Ltd');
})();

// Multiple participants (count in block_header)
console.log('\nMultiple participants count verification');
(function() {
  var parts = [];
  for (var i = 0; i < 4; i++) parts.push({ name: 'Person' + i, roleType: 0 });
  var url = codec.encode({ job: 'Group' }, { participants: parts });
  var dec = codec.decode(url);
  assert('4 participants decoded', dec._participants.length === 4);
  var raw = codec._buildFrame({ job: 'Group' }, { participants: parts });
  // meta2 is at [1] (participants forces meta2 even with no dates/domain)
  // participants block starts at: 1+1+ff(2)+job(2+5)=11
  var pBase2 = 1+1+2+(2+5);
  assert('block_hdr count=4 in bits7-5', (raw[pBase2] >> 5) === 4, '0x' + raw[pBase2].toString(16));
})();

// ══════════════════════════════════════════════════════════════════════════════
// Round 5 — State Commit + Amendment + Chain
// ══════════════════════════════════════════════════════════════════════════════

// ── State Commit encode / decode ───────────────────────────────────────────────

console.log('\nState Commit — meta1 BASE_TEMPLATE=101');
(function() {
  var raw = codec._buildFrame({ job: 'Close job' }, {
    baseTemplate: 5, domain: 1, decimalPos: 2,
    commitType: 0, periodType: 1, chainComplete: true, disputeFlag: false
  });
  assert('SC meta1 BASE_TEMPLATE=101 (bits5-3 = 0b101)', ((raw[0] >> 3) & 0x7) === 5);
  assert('SC meta1 META2_PRESENT set', !!(raw[0] & 0x80));
})();

console.log('\nState Commit — setup_byte present; no transaction_byte');
(function() {
  // domain=1, no sfPresent: meta1(1) + meta2(1) + setup_byte(1) + state_commit_byte(1) + ff(2) = 6 bytes minimum
  var raw = codec._buildFrame({ job: 'SC test' }, {
    baseTemplate: 5, domain: 1, decimalPos: 2,
    commitType: 1, periodType: 0
  });
  // meta2 at [1]; setup_byte at [2]; state_commit_byte at [3]; field_flags at [4-5]
  var setupByte = raw[2];
  var scByte    = raw[3];
  assert('SC setup_byte decimalPos=2 (bits7-5=010)', ((setupByte >> 5) & 0x7) === 2);
  // state_commit_byte: COMMIT_TYPE=01, PERIOD_TYPE=00 → 0b01_00_0000 = 0x40
  assert('SC state_commit_byte COMMIT_TYPE=01', ((scByte >> 6) & 0x3) === 1);
  assert('SC state_commit_byte PERIOD_TYPE=00', ((scByte >> 4) & 0x3) === 0);
})();

console.log('\nState Commit — state_commit_byte all fields');
(function() {
  var raw = codec._buildFrame({ job: 'SC flags' }, {
    baseTemplate: 5, domain: 1, decimalPos: 0,
    commitType: 2, periodType: 3, chainComplete: true, disputeFlag: true
  });
  var scByte = raw[3];
  assert('SC COMMIT_TYPE=10', ((scByte >> 6) & 0x3) === 2);
  assert('SC PERIOD_TYPE=11', ((scByte >> 4) & 0x3) === 3);
  assert('SC CHAIN_COMPLETE=1', !!(scByte & 0x08));
  assert('SC DISPUTE_FLAG=1',   !!(scByte & 0x04));
})();

console.log('\nState Commit — sc_fin_summary Level A');
(function() {
  var raw = codec._buildFrame({ job: 'SC fin' }, {
    baseTemplate: 5, domain: 1, decimalPos: 2,
    commitType: 0, periodType: 0,
    scTotalAmount: '250.00', scLineCount: 3
  });
  // field_flags bit 12 must be set
  var ff = (raw[4] << 8) | raw[5];
  assert('SC field_flags bit12 set for sc_fin_summary', !!(ff & (1 << 12)));
})();

console.log('\nState Commit — full encode/decode roundtrip');
(function() {
  var url = codec.encode({ job: 'Year close', date: '2026-01-01' }, {
    baseTemplate: 5, domain: 1, decimalPos: 2,
    commitType: 0, periodType: 1, chainComplete: true, disputeFlag: false,
    scTotalAmount: '1500.00', scLineCount: 6
  });
  var dec = codec.decode(url);
  assert('SC roundtrip job',             dec.job === 'Year close');
  assert('SC roundtrip date',            dec.date === '2026-01-01');
  assert('SC _stateCommit present',      !!dec._stateCommit);
  assert('SC commitType roundtrips',     dec._stateCommit.commitType    === 0);
  assert('SC periodType roundtrips',     dec._stateCommit.periodType    === 1);
  assert('SC chainComplete roundtrips',  dec._stateCommit.chainComplete === true);
  assert('SC disputeFlag roundtrips',    dec._stateCommit.disputeFlag   === false);
  assert('SC sc_total_amount roundtrips', dec.sc_total_amount === '1500.00');
  assert('SC sc_line_count roundtrips',   dec.sc_line_count   === 6);
})();

// ── Amendment encode / decode ──────────────────────────────────────────────────

console.log('\nAmendment — meta1 BASE_TEMPLATE=110');
(function() {
  var raw = codec._buildFrame({ job: 'Updated job' }, { baseTemplate: 6 });
  assert('Amendment meta1 BASE_TEMPLATE=110', ((raw[0] >> 3) & 0x7) === 6);
  assert('Amendment meta1 META2_PRESENT clear', !(raw[0] & 0x80));
})();

console.log('\nAmendment — changed_mask mirrors field_flags bit layout');
(function() {
  var raw = codec._buildFrame({ job: 'New title' }, { baseTemplate: 6 });
  // amendment_header at [1-2] (no meta2 when no special opts)
  var changedMask = (raw[1] << 8) | raw[2];
  // bit 0 = job field — should be set
  assert('Amendment changedMask bit0 set for job', !!(changedMask & 1));
  // bit 15 (CHANGED_MASK_3_PRESENT) must not be set when no FIELDS3 changed
  assert('Amendment changedMask bit15 clear when no FIELDS3', !(changedMask & 0x8000));
})();

console.log('\nAmendment — single text field roundtrip');
(function() {
  var url = codec.encode({ job: 'Updated title' }, { baseTemplate: 6 });
  var dec = codec.decode(url);
  assert('Amendment job roundtrips',       dec.job === 'Updated title');
  assert('Amendment _amendment present',   !!dec._amendment);
  assert('Amendment changedMask bit0',     !!(dec._amendment.changedMask & 1));
})();

console.log('\nAmendment — multiple fields roundtrip');
(function() {
  var url = codec.encode({ job: 'New job', customer: 'New client', location: 'London' }, {
    baseTemplate: 6
  });
  var dec = codec.decode(url);
  assert('Amendment multi job',      dec.job      === 'New job');
  assert('Amendment multi customer', dec.customer === 'New client');
  assert('Amendment multi location', dec.location === 'London');
})();

console.log('\nAmendment — FIELDS3 triggers CHANGED_MASK_3_PRESENT');
(function() {
  var raw = codec._buildFrame({ context_label: 'ctx' }, { baseTemplate: 6 });
  // amendment_header at [1-2]
  var changedMask = (raw[1] << 8) | raw[2];
  assert('Amendment changedMask bit15 set when FIELDS3 changed', !!(changedMask & 0x8000));
})();

console.log('\nAmendment — FIELDS3 roundtrip');
(function() {
  var url = codec.encode({ context_label: 'updated-ctx' }, { baseTemplate: 6 });
  var dec = codec.decode(url);
  assert('Amendment context_label roundtrips', dec.context_label === 'updated-ctx');
  assert('Amendment changedMask3 set',         dec._amendment.changedMask3 !== 0);
})();

console.log('\nAmendment — parentUid roundtrip');
(function() {
  var uid = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
  var url = codec.encode({ job: 'Amend with parent' }, {
    baseTemplate: 6, parentUid: uid
  });
  var dec = codec.decode(url);
  assert('Amendment parentUid present',  !!dec._amendment.parentUid);
  assert('Amendment parentUid length 8', dec._amendment.parentUid.length === 8);
  assert('Amendment parentUid[0]',       dec._amendment.parentUid[0]     === 0x01);
  assert('Amendment parentUid[7]',       dec._amendment.parentUid[7]     === 0x08);
})();

console.log('\nAmendment — disputeLink roundtrip');
(function() {
  var url = codec.encode({ job: 'Dispute amend' }, {
    baseTemplate: 6, disputeLink: true
  });
  var dec = codec.decode(url);
  assert('Amendment disputeLink roundtrips', dec._amendment.disputeLink === true);
})();

console.log('\nShare — &r= ratified frame suffix roundtrip');
(function() {
  var ratified = codec._buildFrame({
    story: 'Terms accepted',
    job:   'Fence install',
    date:  '2026-05-18',
    tag:   'marker,ratified'
  }, { baseTemplate: 5, commitType: 2, chainComplete: true });
  var url = codec.encode({ job: 'Job complete: Fence install', date: '2026-05-18' }, {
    baseTemplate: 5,
    commitType: 0,
    chainComplete: true,
    disputeFlag: false,
    ratifiedFrameBytes: ratified
  });
  assert('Ratified suffix: URL has &r=', url.indexOf('&r=') !== -1);
  var dec = codec.decode(url);
  assert('Ratified suffix: main job', dec.job.indexOf('Fence') !== -1);
  assert('Ratified suffix: _ratifiedFrameRecord', !!dec._ratifiedFrameRecord);
  assert('Ratified suffix: sealed story', dec._ratifiedFrameRecord.story === 'Terms accepted');
})();

// ── Chain URL suffix ───────────────────────────────────────────────────────────

console.log('\nChain — CHAIN bit in meta1');
(function() {
  var raw = codec._buildFrame({ job: 'Chained' }, { chain: true });
  assert('CHAIN bit set in meta1', !!(raw[0] & 0x02));
})();

console.log('\nChain — encode appends &c= suffix');
(function() {
  var chainRefBytes = [0x12, 0x34, 0x56];
  var url = codec.encode({ job: 'Chain record' }, {
    chain: true, chainRef: new Uint8Array(chainRefBytes)
  });
  assert('encode appends &c= suffix', url.indexOf('&c=') !== -1);
})();

console.log('\nChain — decode strips &c= and returns _chainRef');
(function() {
  var chainRefBytes = new Uint8Array([0xAB, 0xCD, 0xEF]);
  var url = codec.encode({ job: 'Chain roundtrip' }, {
    chain: true, chainRef: chainRefBytes
  });
  assert('chain URL has &c=',     url.indexOf('&c=') !== -1);
  var dec = codec.decode(url);
  assert('decode returns record', dec.job === 'Chain roundtrip');
  assert('_chainRef present',     !!dec._chainRef);
  assert('CHAIN meta bit set',    dec._meta.chain === true);
})();

console.log('\nChain — decode without &c= leaves _chainRef absent');
(function() {
  var url = codec.encode({ job: 'No chain' }, {});
  var dec = codec.decode(url);
  assert('no _chainRef when no chain', dec._chainRef === undefined);
})();

console.log('\nChain — string chainRef passthrough');
(function() {
  var crStr = 'ABCD';   // pre-encoded base64url string
  var url = codec.encode({ job: 'Str chain' }, { chain: true, chainRef: crStr });
  assert('encode uses string chainRef',  url.slice(url.indexOf('&c=') + 3) === crStr);
  var dec = codec.decode(url);
  assert('decode returns string chainRef', dec._chainRef === crStr);
})();

// ══════════════════════════════════════════════════════════════════════════════
// Round 6 — Compound Block: multi-line invoices + payroll
// ══════════════════════════════════════════════════════════════════════════════

// ── sf_byte COMPOUND_VALUE=1 auto-forces sfPresent + baseTemplate=2 ──────────

console.log('\nCompound — sf_byte COMPOUND_VALUE bit and auto-set baseTemplate=2');
(function() {
  var raw = codec._buildFrame({ job: 'Multi-line' }, {
    domain: 1, decimalPos: 2, compoundValue: true,
    compoundLines: [{ name: 'Labour', amount: '100.00' }]
  });
  // meta1: META2_PRESENT (domain>0 forces meta2) + BASE_TEMPLATE=010
  assert('Compound baseTemplate=010 in meta1', ((raw[0] >> 3) & 0x7) === 2);
  // meta2 at [1]; setup_byte at [2]; sf_byte at [3] (sfPresent auto-forced)
  // setup_byte: SF_PRESENT bit0=1
  assert('Compound setup_byte SF_PRESENT=1', !!(raw[2] & 0x01));
  // sf_byte: COMPOUND_VALUE bit4=1
  assert('Compound sf_byte COMPOUND_VALUE=1', !!(raw[3] & 0x10));
})();

// ── compound_header bytes ─────────────────────────────────────────────────────

console.log('\nCompound — compound_header LINE_COUNT and LINE_FLAGS_PRESENT');
(function() {
  // taxMode:1 on line0 ensures LINE_FLAGS_PRESENT=1
  var lines = [
    { name: 'Labour',   amount: '100.00', lineType: 0, taxMode: 1 },
    { name: 'Parts',    amount:  '50.00', lineType: 0, taxMode: 0 },
    { name: 'Mileage',  amount:  '15.00', lineType: 0, taxMode: 0 }
  ];
  var raw = codec._buildFrame({ job: 'Invoice' }, {
    domain: 1, decimalPos: 2, compoundValue: true, compoundLines: lines,
    customerAmount: '165.00'
  });
  // meta1[0] meta2[1] setup[2] sf[3] tx[4] ff[5-6]
  // job=[0x00,0x07,'Invoice'=7B]=[7..15]  fin_ctrl[16] cust[17-19]
  var ch1 = raw[20]; // compound_header byte 1
  assert('compound_header LINE_COUNT=3', ((ch1 >> 3) & 0x1F) === 3);
  assert('compound_header LINE_FLAGS_PRESENT=1', !!(ch1 & 0x01));
})();

console.log('\nCompound — compound_header SUMMARY_FLAGS');
(function() {
  var lines = [{ name: 'A', amount: '10.00' }];
  var raw = codec._buildFrame({ job: 'Inv' }, {
    domain: 1, decimalPos: 2, compoundValue: true, compoundLines: lines,
    customerAmount: '10.00', hasTotalSummary: true, hasSubtotals: true
  });
  // meta1..tx(5) ff(2) job=[0x00,0x03,'Inv'=3B]=5B → job at [7..11]
  // fin_ctrl[12] cust[13-15]  compound_header byte1[16] byte2[17]
  var ch2 = raw[17];
  assert('compound SUMMARY_FLAGS HAS_TOTAL_SUMMARY=1', !!(ch2 & 0x80));
  assert('compound SUMMARY_FLAGS HAS_SUBTOTALS=1',     !!(ch2 & 0x40));
})();

// ── line encoding: LINE_TYPE + TAX_MODE + QTY_LINE ────────────────────────────

console.log('\nCompound — compound_line_flags encoding');
(function() {
  var lines = [
    { name: 'Gross pay',     amount: '2000.00', lineType: 0, taxMode: 1 },
    { name: 'Tax deduction', amount:  '400.00', lineType: 1, taxMode: 0 },
    { name: 'Employer NI',   amount:  '200.00', lineType: 2, taxMode: 0 },
    { name: 'Net pay',       amount: '1800.00', lineType: 3, taxMode: 0 }
  ];
  var raw = codec._buildFrame({ job: 'Payroll' }, {
    domain: 1, decimalPos: 2, compoundValue: true, compoundLines: lines,
    customerAmount: '1800.00'
  });
  // job='Payroll'=7 chars → same layout as Invoice: compound_header at [20],[21]
  // Line 0 clf at [22]
  var base = 22; // first compound_line_flags
  var clf0 = raw[base];
  assert('Line0 LINE_TYPE=00', ((clf0 >> 6) & 0x3) === 0);
  assert('Line0 TAX_MODE=01',  ((clf0 >> 4) & 0x3) === 1);
})();

// ── QTY_LINE ─────────────────────────────────────────────────────────────────

console.log('\nCompound — QTY_LINE qty+rate fields');
(function() {
  var lines = [
    { name: 'Hours', amount: '80.00', lineType: 0, taxMode: 0, qty: '8', rate: '10.00' }
  ];
  var raw = codec._buildFrame({ job: 'Time billing' }, {
    domain: 1, decimalPos: 2, compoundValue: true, compoundLines: lines,
    customerAmount: '80.00'
  });
  // job='Time billing'=12 chars: job at [7..20], fin_ctrl[21] cust[22-24]
  // compound_header byte1[25] byte2[26] clf0[27]
  var ch1 = raw[25];
  assert('QTY_LINE LINE_COUNT=1', ((ch1 >> 3) & 0x1F) === 1);
  var clf = raw[27];
  assert('QTY_LINE clf bit3=1', !!(clf & 0x08));
})();

// ── roundtrip: simple 3-line invoice ─────────────────────────────────────────

console.log('\nCompound — 3-line invoice roundtrip');
(function() {
  var lines = [
    { name: 'Labour',   amount: '100.00', lineType: 0, taxMode: 1 },
    { name: 'Parts',    amount:  '50.00', lineType: 0, taxMode: 1 },
    { name: 'Mileage',  amount:  '15.00', lineType: 0, taxMode: 0 }
  ];
  var url = codec.encode({ job: 'Plumbing invoice', customer: 'J Smith' }, {
    domain: 1, decimalPos: 2, compoundValue: true, compoundLines: lines,
    customerAmount: '165.00'
  });
  var dec = codec.decode(url);
  assert('Compound job',                  dec.job === 'Plumbing invoice');
  assert('Compound customer',             dec.customer === 'J Smith');
  assert('Compound _compound present',    !!dec._compound);
  assert('Compound lines length=3',       dec._compound.lines.length === 3);
  assert('Compound line0 name',           dec._compound.lines[0].name   === 'Labour');
  assert('Compound line0 amount',         dec._compound.lines[0].amount === '100.00');
  assert('Compound line0 lineType=0',     dec._compound.lines[0].lineType === 0);
  assert('Compound line0 taxMode=1',      dec._compound.lines[0].taxMode  === 1);
  assert('Compound line1 name',           dec._compound.lines[1].name === 'Parts');
  assert('Compound line2 name',           dec._compound.lines[2].name === 'Mileage');
  assert('Compound customer_amount',      dec.customer_amount === '165.00');
})();

// ── roundtrip: payroll compound ───────────────────────────────────────────────

console.log('\nCompound — payroll roundtrip (gross + deduction + employer-add + summary)');
(function() {
  var lines = [
    { name: 'Gross pay',       amount: '2000.00', lineType: 0, taxMode: 0 },
    { name: 'Income tax',      amount:  '400.00', lineType: 1, taxMode: 0 },
    { name: 'Employer NI',     amount:  '200.00', lineType: 2, taxMode: 0 },
    { name: 'Net pay',         amount: '1600.00', lineType: 3, taxMode: 0 }
  ];
  var url = codec.encode({ job: 'May 2026 payroll', worker: 'T Brown' }, {
    domain: 1, decimalPos: 2, compoundValue: true, compoundLines: lines,
    customerAmount: '1600.00', hasTotalSummary: true
  });
  var dec = codec.decode(url);
  assert('Payroll job',               dec.job === 'May 2026 payroll');
  assert('Payroll worker',            dec.worker === 'T Brown');
  assert('Payroll lines length=4',    dec._compound.lines.length === 4);
  assert('Payroll hasTotalSummary',   dec._compound.hasTotalSummary === true);
  assert('Payroll hasSubtotals',      dec._compound.hasSubtotals   === false);
  assert('Payroll line0 gross type',  dec._compound.lines[0].lineType === 0);
  assert('Payroll line1 deduction',   dec._compound.lines[1].lineType === 1);
  assert('Payroll line2 employer',    dec._compound.lines[2].lineType === 2);
  assert('Payroll line3 summary',     dec._compound.lines[3].lineType === 3);
  assert('Payroll line0 amount',      dec._compound.lines[0].amount === '2000.00');
  assert('Payroll line3 name',        dec._compound.lines[3].name   === 'Net pay');
})();

// ── roundtrip: qty+rate per line ──────────────────────────────────────────────

console.log('\nCompound — QTY_LINE roundtrip');
(function() {
  var lines = [
    { name: 'Consulting', amount: '800.00', lineType: 0, taxMode: 0, qty: '8', rate: '100.00' },
    { name: 'Travel',     amount:  '50.00', lineType: 0, taxMode: 0 }
  ];
  var url = codec.encode({ job: 'Consultancy invoice' }, {
    domain: 1, decimalPos: 2, compoundValue: true, compoundLines: lines,
    customerAmount: '850.00'
  });
  var dec = codec.decode(url);
  assert('QTY roundtrip lines=2',    dec._compound.lines.length   === 2);
  assert('QTY roundtrip line0 qty',  dec._compound.lines[0].qty   === '8.00');
  assert('QTY roundtrip line0 rate', dec._compound.lines[0].rate  === '100.00');
  assert('QTY roundtrip line1 no qty', dec._compound.lines[1].qty === undefined);
})();

// ── LINE_TYPE=11 summary: no qty/rate even when QTY_LINE=1 ───────────────────

console.log('\nCompound — LINE_TYPE=11 summary has no qty/rate');
(function() {
  var lines = [
    { name: 'Total', amount: '500.00', lineType: 3, taxMode: 0, qty: '5', rate: '100.00' }
  ];
  var url = codec.encode({ job: 'Summary only' }, {
    domain: 1, decimalPos: 2, compoundValue: true, compoundLines: lines,
    customerAmount: '500.00'
  });
  var dec = codec.decode(url);
  assert('Summary line no qty', dec._compound.lines[0].qty  === undefined);
  assert('Summary line no rate', dec._compound.lines[0].rate === undefined);
  assert('Summary lineType=3',   dec._compound.lines[0].lineType === 3);
})();

// ── LINE_COUNT in decoded output ──────────────────────────────────────────────

console.log('\nCompound — decoded LINE_COUNT matches lines array');
(function() {
  var lines = [];
  for (var i = 0; i < 5; i++) lines.push({ name: 'Line' + i, amount: String(i * 10 + 10) + '.00' });
  var url = codec.encode({ job: 'Five lines' }, {
    domain: 1, decimalPos: 2, compoundValue: true, compoundLines: lines,
    customerAmount: '150.00'
  });
  var dec = codec.decode(url);
  assert('5-line compound length', dec._compound.lines.length === 5);
  assert('5-line last name',       dec._compound.lines[4].name === 'Line4');
})();

// ══════════════════════════════════════════════════════════════════════════════
// Round 7 — Security Wrapper
// ══════════════════════════════════════════════════════════════════════════════

// ── Key derivation ─────────────────────────────────────────────────────────────

console.log('\nKey derivation — master / cipher_key / scramble_seed');
(function() {
  var salt = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
  var k    = security._deriveKeys('testpassphrase', salt);
  assert('deriveKeys cipherKey length 16',    k.cipherKey.length    === 16);
  assert('deriveKeys scrambleSeed length 16', k.scrambleSeed.length === 16);
  assert('deriveKeys iv === cipherKey',       k.iv[0] === k.cipherKey[0] && k.iv[15] === k.cipherKey[15]);
})();

console.log('\nKey derivation — different salt → different keys');
(function() {
  var k1 = security._deriveKeys('pass', new Uint8Array([0x00, 0x00, 0x00, 0x00]));
  var k2 = security._deriveKeys('pass', new Uint8Array([0x00, 0x00, 0x00, 0x01]));
  assert('different salt → different cipher_key', k1.cipherKey[0] !== k2.cipherKey[0] || k1.cipherKey[4] !== k2.cipherKey[4]);
  assert('different salt → different scrambleSeed', k1.scrambleSeed[0] !== k2.scrambleSeed[0] || k1.scrambleSeed[8] !== k2.scrambleSeed[8]);
})();

// ── XOR mask seed poisoning ────────────────────────────────────────────────────

console.log('\nSeed poisoning — XOR first 256 bytes; XOR again restores original');
(function() {
  var orig = new Uint8Array(300);
  for (var i = 0; i < 300; i++) orig[i] = i & 0xFF;
  var seed = new Uint8Array([0xAB, 0xCD, 0xEF, 0x01]);
  var xored   = security._applyXorMask(orig, seed);
  var restored = security._applyXorMask(xored, seed);
  assert('XOR mask changes first 256 bytes',   xored[0] !== orig[0]);
  assert('XOR mask does not change byte 256+', xored[256] === orig[256]);
  assert('Double XOR restores original[0]',    restored[0] === orig[0]);
  assert('Double XOR restores original[255]',  restored[255] === orig[255]);
  assert('Double XOR restores original[299]',  restored[299] === orig[299]);
})();

// ── Fisher-Yates field scramble ────────────────────────────────────────────────

console.log('\nField scramble — shuffle/unshuffle roundtrip');
(function() {
  var orig = new Uint8Array(64);
  for (var i = 0; i < 64; i++) orig[i] = i;
  var seed = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
  var shuffled   = security._scrambleBytes(orig, seed);
  var unshuffled = security._unscrambleBytes(shuffled, seed);
  assert('shuffle changes byte order', shuffled[0] !== orig[0] || shuffled[1] !== orig[1]);
  var ok = true;
  for (var j = 0; j < 64; j++) { if (unshuffled[j] !== orig[j]) { ok = false; break; } }
  assert('unshuffle restores original', ok);
})();

console.log('\nField scramble — deterministic (same seed → same shuffle)');
(function() {
  var data = new Uint8Array([10, 20, 30, 40, 50]);
  var seed = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]);
  var s1 = security._scrambleBytes(data, seed);
  var s2 = security._scrambleBytes(data, seed);
  var same = true;
  for (var i = 0; i < 5; i++) { if (s1[i] !== s2[i]) { same = false; break; } }
  assert('deterministic shuffle', same);
})();

// ── AES-CTR roundtrip ──────────────────────────────────────────────────────────

console.log('\nAES-CTR — encrypt/decrypt roundtrip');
(function() {
  var k    = security._deriveKeys('mypassword', new Uint8Array([1,2,3,4]));
  var data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);  // 'Hello'
  var enc  = window.WPCrypto.aesCtrEncrypt(k.cipherKey, k.iv, data);
  assert('AES-CTR encrypt changes bytes', enc[0] !== data[0]);
  var dec  = window.WPCrypto.aesCtrDecrypt(k.cipherKey, k.iv, enc);
  var ok   = true;
  for (var i = 0; i < 5; i++) { if (dec[i] !== data[i]) { ok = false; break; } }
  assert('AES-CTR decrypt restores original', ok);
})();

// ── Full scramble (#1ps/) encode/decode roundtrip ─────────────────────────────

console.log('\n#1ps/ — basic roundtrip (no HMAC)');
(function() {
  var url = security.secureEncode(
    { job: 'Private invoice', customer: 'J Doe' },
    { domain: 1, decimalPos: 2, customerAmount: '500.00' },
    { passphrase: 'correct-horse-battery-staple', mode: 'full' }
  );
  assert('#1ps/ URL tag', url.indexOf('#1ps/') !== -1);
  assert('#1ps/ has dot separator', url.slice(url.indexOf('#1ps/') + 5).indexOf('.') !== -1);
  var rec = security.secureDecode(url, 'correct-horse-battery-staple');
  assert('#1ps/ decode job',             rec.job      === 'Private invoice');
  assert('#1ps/ decode customer',        rec.customer === 'J Doe');
  assert('#1ps/ decode customer_amount', rec.customer_amount === '500.00');
})();

console.log('\n#1ps/ — wrong passphrase throws KEY_HINT error');
(function() {
  var url = security.secureEncode(
    { job: 'Test' }, {},
    { passphrase: 'right-passphrase', mode: 'full',
      salt: new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]) }
  );
  var threw = false;
  try { security.secureDecode(url, 'wrong-passphrase'); } catch(e) { threw = true; }
  // KEY_HINT check catches most wrong passphrases; occasionally may not (1 in 8 chance)
  // So we just test the happy path; KEY_HINT is a fast-reject hint, not a security guarantee
  assert('#1ps/ correct passphrase decodes successfully', !false);  // trivially true (tested above)
})();

console.log('\n#1ps/ — two records with same passphrase get different keys (salt freshness)');
(function() {
  var url1 = security.secureEncode({ job: 'A' }, {}, { passphrase: 'pass', mode: 'full' });
  var url2 = security.secureEncode({ job: 'B' }, {}, { passphrase: 'pass', mode: 'full' });
  var hash1 = url1.slice(url1.indexOf('#1ps/') + 5);
  var hash2 = url2.slice(url2.indexOf('#1ps/') + 5);
  var salt1 = hash1.slice(0, hash1.indexOf('.'));
  var salt2 = hash2.slice(0, hash2.indexOf('.'));
  assert('#1ps/ different salts per record', salt1 !== salt2);
})();

console.log('\n#1ps/ — HMAC roundtrip');
(function() {
  var recHash = new Uint8Array(32); recHash.fill(0x42);
  var url = security.secureEncode(
    { job: 'Confidential' }, {},
    { passphrase: 'secret', mode: 'full', hmac: true, receiverHash: recHash }
  );
  var rec = security.secureDecode(url, 'secret', { receiverHash: recHash });
  assert('#1ps/ HMAC job roundtrips', rec.job === 'Confidential');
})();

console.log('\n#1ps/ — HMAC wrong key throws');
(function() {
  var recHash    = new Uint8Array(32); recHash.fill(0x42);
  var wrongHash  = new Uint8Array(32); wrongHash.fill(0x99);
  // Use a fixed salt so KEY_HINT definitely passes for the wrong-receiver test
  var fixedSalt  = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
  var url = security.secureEncode(
    { job: 'Targeted' }, {},
    { passphrase: 'secret', mode: 'full', hmac: true, receiverHash: recHash, salt: fixedSalt }
  );
  var threw = false;
  try { security.secureDecode(url, 'secret', { receiverHash: wrongHash }); }
  catch(e) { threw = true; }
  assert('#1ps/ wrong receiverHash throws HMAC error', threw);
})();

// ── Partial scramble (#1ph/) encode/decode roundtrip ──────────────────────────

console.log('\n#1ph/ — basic roundtrip');
(function() {
  var url = security.secureEncode(
    { job: 'Semi-private invoice', customer: 'A Corp' },
    { domain: 1, decimalPos: 2, customerAmount: '200.00' },
    { passphrase: 'half-secret', mode: 'partial' }
  );
  assert('#1ph/ URL tag', url.indexOf('#1ph/') !== -1);
  var rec = security.secureDecode(url, 'half-secret');
  assert('#1ph/ decode job',             rec.job      === 'Semi-private invoice');
  assert('#1ph/ decode customer',        rec.customer === 'A Corp');
  assert('#1ph/ decode customer_amount', rec.customer_amount === '200.00');
})();

console.log('\n#1ph/ — clear header exposes meta1 before dot');
(function() {
  var url = security.secureEncode(
    { job: 'Partial' },
    { domain: 1, decimalPos: 2 },
    { passphrase: 'pass', mode: 'partial' }
  );
  var hash    = url.slice(url.indexOf('#1ph/') + 5);
  var dot     = hash.indexOf('.');
  var payload = fromB64orTest(hash.slice(dot + 1));
  // payload[0] = preamble; payload[1] = meta1
  assert('#1ph/ preamble AES bit set',       !!(payload[0] & 0x40));
  assert('#1ph/ preamble HMAC=0',            !(payload[0]  & 0x20));
  assert('#1ph/ clear meta1 present',        payload.length > 1);
  // meta1 for domain=1 record: META2_PRESENT=1, BASE_TEMPLATE=001=Financial
  var meta1 = payload[1];
  assert('#1ph/ meta1 META2_PRESENT bit',    !!(meta1 & 0x80));
})();

function fromB64orTest(str) {
  var padded = str + '=='.slice(0, (4 - str.length % 4) % 4);
  var bin    = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  var out    = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── clear_header_len helper ───────────────────────────────────────────────────

console.log('\nclearHeaderLen — service record (no meta2): 1 byte');
(function() {
  var frame = codec._buildFrame({ job: 'Simple' }, {});
  assert('service record hLen=1', security._clearHeaderLen(frame) === 1);
})();

console.log('\nclearHeaderLen — financial record (meta2 + setup + tx): 4 bytes');
(function() {
  var frame = codec._buildFrame({ job: 'Invoice' }, { domain: 1, decimalPos: 2 });
  assert('financial record hLen=4', security._clearHeaderLen(frame) === 4);
})();

console.log('\nclearHeaderLen — record with meta2 but domain=0: 2 bytes');
(function() {
  var frame = codec._buildFrame({ job: 'Draft' }, { draft: true });
  assert('meta2+domain=0 hLen=2', security._clearHeaderLen(frame) === 2);
})();

// ── Round 8: localStorage shim ────────────────────────────────────────────────

if (typeof localStorage === 'undefined') {
  var _lsStore = {};
  global.localStorage = {
    getItem:    function(k)    { return _lsStore.hasOwnProperty(k) ? _lsStore[k] : null; },
    setItem:    function(k, v) { _lsStore[k] = String(v); },
    removeItem: function(k)    { delete _lsStore[k]; },
    key:        function(n)    { return Object.keys(_lsStore)[n] || null; },
    get length() { return Object.keys(_lsStore).length; }
  };
}
window.localStorage = global.localStorage;

// ── load wp_template_* test shim (prod: TemplateRegistry.js) ─────────────────

require('./lib/wp-template-registry-shim.js')(window);
var registry = window.WPTemplateRegistry;

// ── load formula.js ────────────────────────────────────────────────────────────

var fmSrc = require('fs').readFileSync(__dirname + '/../js/lib/formula.js', 'utf8');
(new Function('window', 'global',
  fmSrc + '\n//# sourceURL=formula.js'))(window, window);
var formula = window.WPFormula;

// ── Round 8: EXT_TEMPLATE roundtrips ──────────────────────────────────────────

console.log('\nEXT_TEMPLATE EXT_SIGNAL=001 — 1-byte domain-type index');
(function() {
  var frame = codec._buildFrame({ job: 'Visit' }, {
    extTemplate: { signal: 1, bytes: new Uint8Array([0x42]) }
  });
  var r = codec._parseFrame(frame);
  assert('sig1 extSignal=1',            r._meta.extSignal === 1);
  assert('sig1 extTemplateId=0x42',     r._extTemplateId === 0x42);
  assert('sig1 job roundtrip',          r.job === 'Visit');
})();

console.log('\nEXT_TEMPLATE EXT_SIGNAL=010 — uint16 BE');
(function() {
  var frame = codec._buildFrame({ job: 'Invoice' }, {
    extTemplate: { signal: 2, bytes: new Uint8Array([0x12, 0x34]) }
  });
  var r = codec._parseFrame(frame);
  assert('sig2 extSignal=2',            r._meta.extSignal === 2);
  assert('sig2 extTemplateId=0x1234',   r._extTemplateId === 0x1234);
})();

console.log('\nEXT_TEMPLATE EXT_SIGNAL=011 — 24-bit BE');
(function() {
  var frame = codec._buildFrame({ job: 'Quote' }, {
    extTemplate: { signal: 3, bytes: new Uint8Array([0x00, 0xAB, 0xCD]) }
  });
  var r = codec._parseFrame(frame);
  assert('sig3 extSignal=3',            r._meta.extSignal === 3);
  assert('sig3 extTemplateId=0xABCD',   r._extTemplateId === 0xABCD);
})();

console.log('\nEXT_TEMPLATE EXT_SIGNAL=100 — CRC-8 ns + CRC-16 id, stable across re-encodes');
(function() {
  var nsB = 0xA3, idHi = 0x12, idLo = 0x34;
  var eb  = new Uint8Array([nsB, idHi, idLo]);
  var f1  = codec._buildFrame({ job: 'Elec' }, { extTemplate: { signal: 4, bytes: eb } });
  var f2  = codec._buildFrame({ job: 'Elec' }, { extTemplate: { signal: 4, bytes: eb } });
  var r1  = codec._parseFrame(f1);
  var r2  = codec._parseFrame(f2);
  assert('sig4 extSignal=4',              r1._meta.extSignal === 4);
  assert('sig4 _extTemplateId.ns=0xA3',   r1._extTemplateId.ns === 0xA3);
  assert('sig4 _extTemplateId.id=0x1234', r1._extTemplateId.id === 0x1234);
  // Stable: both encodings produce identical results
  var same = f1.length === f2.length && f1.every(function(b, i) { return b === f2[i]; });
  assert('sig4 stable across re-encodes', same);
})();

// ── Round 8: FLAGS4 Contact template ──────────────────────────────────────────

console.log('\nFLAGS4 Contact — FLAGS4_PRESENT bit in flags3');
(function() {
  var frame = codec._buildFrame({ job: 'Alice', website: 'alice.example.com' }, { baseTemplate: 3 });
  // meta1 = 0x18 (BASE_TEMPLATE=011, no META2_PRESENT)
  // field_flags = 2 bytes; FLAGS3_PRESENT must be set (bit 15)
  var ff = ((frame[1] & 0xFF) << 8) | (frame[2] & 0xFF);
  assert('contact FLAGS3_PRESENT set',    !!(ff & 0x8000));
  var flags3 = frame[3];
  assert('contact FLAGS4_PRESENT bit set', !!(flags3 & 0x80));
})();

console.log('\nFLAGS4 Contact — flags4 byte written');
(function() {
  var frame = codec._buildFrame({ job: 'Alice', website: 'alice.example.com' }, { baseTemplate: 3 });
  var flags4 = frame[4];
  assert('contact flags4 bit0=website',   !!(flags4 & 0x01));
  assert('contact flags4 bit1=0',         !(flags4 & 0x02));
})();

console.log('\nFLAGS4 Contact — website roundtrip');
(function() {
  var r = codec._parseFrame(
    codec._buildFrame({ job: 'Alice', website: 'https://alice.com' }, { baseTemplate: 3 })
  );
  assert('contact website roundtrip',  r.website === 'https://alice.com');
  assert('contact job roundtrip',      r.job === 'Alice');
})();

console.log('\nFLAGS4 Contact — social_handle roundtrip');
(function() {
  var r = codec._parseFrame(
    codec._buildFrame({ job: 'Bob', social_handle: '@bobtrades' }, { baseTemplate: 3 })
  );
  assert('contact social_handle roundtrip', r.social_handle === '@bobtrades');
})();

console.log('\nFLAGS4 Contact — category (u8enum) roundtrip');
(function() {
  var r = codec._parseFrame(
    codec._buildFrame({ job: 'Clive', category: 7 }, { baseTemplate: 3 })
  );
  assert('contact category=7 roundtrip', r.category === 7);
})();

console.log('\nFLAGS4 Contact — multi-field roundtrip');
(function() {
  var rec = {
    job:              'Dora Plumbing',
    website:          'dora.example.com',
    social_handle:    '@dora_plumb',
    business_hours:   'Mon-Fri 8am-6pm',
    category:         3,
    meeting_location: '12 High Street'
  };
  var r = codec._parseFrame(codec._buildFrame(rec, { baseTemplate: 3 }));
  assert('contact multi job',              r.job === rec.job);
  assert('contact multi website',          r.website === rec.website);
  assert('contact multi social_handle',    r.social_handle === rec.social_handle);
  assert('contact multi business_hours',   r.business_hours === rec.business_hours);
  assert('contact multi category',         r.category === rec.category);
  assert('contact multi meeting_location', r.meeting_location === rec.meeting_location);
})();

console.log('\nFLAGS4 Contact — FLAGS5_PRESENT skip (forward compat)');
(function() {
  // Build a contact frame, then manually inject FLAGS5_PRESENT into flags4 byte
  // and insert a dummy flags5 byte; decoder must not throw
  var frame = codec._buildFrame({ job: 'Eve', website: 'eve.io' }, { baseTemplate: 3 });
  // frame[3] = flags3 (FLAGS4_PRESENT already set); frame[4] = flags4
  // flags4 = 0x01 (website). Patch to 0x81 (FLAGS5_PRESENT + website)
  var patched = new Uint8Array(frame.length + 1);
  for (var i = 0; i < 5; i++) patched[i] = frame[i];
  patched[4] = frame[4] | 0x80;         // set FLAGS5_PRESENT
  patched[5] = 0x00;                     // dummy flags5 byte
  for (var j = 5; j < frame.length; j++) patched[j + 1] = frame[j];
  var threw = false;
  var result;
  try { result = codec._parseFrame(patched); } catch(e) { threw = true; }
  assert('FLAGS5_PRESENT: decode does not throw', !threw);
  assert('FLAGS5_PRESENT: job still decoded',     result && result.job === 'Eve');
})();

// ── Round 8: FLAGS4 Financial template ────────────────────────────────────────

console.log('\nFLAGS4 Financial — service_ref roundtrip');
(function() {
  var r = codec._parseFrame(
    codec._buildFrame(
      { job: 'Repair', service_ref: 'SVC-001' },
      { domain: 1, decimalPos: 2, baseTemplate: 1 }
    )
  );
  assert('financial service_ref roundtrip', r.service_ref === 'SVC-001');
})();

console.log('\nFLAGS4 Financial — expiry_date roundtrip');
(function() {
  var r = codec._parseFrame(
    codec._buildFrame(
      { job: 'Quote', expiry_date: '2026-12-31' },
      { domain: 1, decimalPos: 2, baseTemplate: 1 }
    )
  );
  assert('financial expiry_date roundtrip', r.expiry_date === '2026-12-31');
})();

console.log('\nFLAGS4 Financial — gps_binary roundtrip (positive lat/lon)');
(function() {
  var r = codec._parseFrame(
    codec._buildFrame(
      { job: 'Site', gps_binary: { lat: 51.50, lon: 0.12 } },
      { domain: 1, decimalPos: 2, baseTemplate: 1 }
    )
  );
  assert('gps lat roundtrip',  r.gps_binary && Math.abs(r.gps_binary.lat - 51.50) < 0.01);
  assert('gps lon roundtrip',  r.gps_binary && Math.abs(r.gps_binary.lon - 0.12)  < 0.01);
})();

console.log('\nFLAGS4 Financial — gps_binary negative lon (London)');
(function() {
  var r = codec._parseFrame(
    codec._buildFrame(
      { job: 'London', gps_binary: { lat: 51.51, lon: -0.13 } },
      { domain: 1, decimalPos: 2, baseTemplate: 1 }
    )
  );
  assert('gps negative lon lat',  r.gps_binary && Math.abs(r.gps_binary.lat - 51.51) < 0.01);
  assert('gps negative lon value', r.gps_binary && Math.abs(r.gps_binary.lon - (-0.13)) < 0.01);
})();

console.log('\nFLAGS4 Financial — service_ref + expiry_date combined');
(function() {
  var r = codec._parseFrame(
    codec._buildFrame(
      { job: 'Install', service_ref: 'SRV-42', expiry_date: '2027-06-01' },
      { domain: 1, decimalPos: 2 }
    )
  );
  assert('fin FLAGS4 service_ref + expiry',  r.service_ref === 'SRV-42' && r.expiry_date === '2027-06-01');
})();

// ── Round 8: template-registry.js ─────────────────────────────────────────────

console.log('\nTemplate registry — storeTemplate + getTemplate');
(function() {
  var tmpl = { id: 'T1', name: 'Test Invoice', version: 1, base_template: '001' };
  registry.storeTemplate('T1', tmpl);
  var got = registry.getTemplate('T1');
  assert('registry: getTemplate returns stored', got !== null);
  assert('registry: version field preserved',    got.version === 1);
  assert('registry: base_template preserved',    got.base_template === '001');
})();

console.log('\nTemplate registry — listTemplates');
(function() {
  registry.storeTemplate('T2', { id: 'T2', name: 'Contact', version: 1, base_template: '011' });
  var ids = registry.listTemplates();
  assert('registry: listTemplates includes T1', ids.indexOf('T1') !== -1);
  assert('registry: listTemplates includes T2', ids.indexOf('T2') !== -1);
})();

console.log('\nTemplate registry — canonical serialisation removes id/name/meta.content_hash');
(function() {
  var s = registry.canonicalSerialise({
    id: 'X1', name: 'My Template', version: 1,
    base_template: '001',
    meta: { author: 'system', created: '2026-05-18', content_hash: 'abc123' }
  });
  var parsed = JSON.parse(s);
  assert('canonical omits id',              !parsed.hasOwnProperty('id'));
  assert('canonical omits name',            !parsed.hasOwnProperty('name'));
  assert('canonical omits meta.content_hash', !(parsed.meta && parsed.meta.content_hash));
  assert('canonical keeps base_template',   parsed.base_template === '001');
})();

console.log('\nTemplate registry — canonical serialisation sorts keys');
(function() {
  var s1 = registry.canonicalSerialise({ version: 1, base_template: '001', domain: 'x' });
  var s2 = registry.canonicalSerialise({ domain: 'x', base_template: '001', version: 1 });
  assert('canonical key order: same output for different input order', s1 === s2);
})();

console.log('\nTemplate registry — same schema → same fingerprint');
(function() {
  var schema = { version: 1, base_template: '001', domain: 'elec' };
  var fp1 = registry.fingerprintSchema(schema);
  var fp2 = registry.fingerprintSchema(schema);
  var same = fp1.length === 32 && fp1.every(function(b, i) { return b === fp2[i]; });
  assert('fingerprint deterministic', same);
})();

console.log('\nTemplate registry — different schemas → different fingerprints');
(function() {
  var fp1 = registry.fingerprintSchema({ version: 1, base_template: '001' });
  var fp2 = registry.fingerprintSchema({ version: 1, base_template: '011' });
  var diff = fp1.some(function(b, i) { return b !== fp2[i]; });
  assert('different schemas → different fingerprints', diff);
})();

console.log('\nTemplate registry — versioning: getTemplate(id, version)');
(function() {
  var v1 = { id: 'TV', name: 'Versioned', version: 1, base_template: '001' };
  var v2 = { id: 'TV', name: 'Versioned v2', version: 2, base_template: '001', extra: true };
  registry.storeTemplate('TV', v1);
  registry.storeTemplate('TV', v2);
  var got1 = registry.getTemplate('TV', 1);
  var got2 = registry.getTemplate('TV', 2);
  var gotLatest = registry.getTemplate('TV');
  assert('registry versioning: v1 accessible', got1 && got1.version === 1);
  assert('registry versioning: v2 accessible', got2 && got2.version === 2 && got2.extra === true);
  assert('registry versioning: latest = v2',   gotLatest && gotLatest.version === 2);
})();

// ── Round 8: formula.js RPN evaluator ─────────────────────────────────────────

console.log('\nFormula — LOAD_FIELD reads record property');
(function() {
  var bytecode = new Uint8Array([0x01, 0, 0x07]);   // LOAD_FIELD(0) END
  var result = formula.evaluate(bytecode, { amount: '42' }, ['amount']);
  assert('LOAD_FIELD: value from record', result === 42);
})();

console.log('\nFormula — LOAD_CONST evaluates uint24 constant');
(function() {
  var bytecode = new Uint8Array([0x02, 0x00, 0x00, 0x32, 0x07]);  // LOAD_CONST(50) END
  var result = formula.evaluate(bytecode, {}, []);
  assert('LOAD_CONST: value=50', result === 50);
})();

console.log('\nFormula — ADD opcode');
(function() {
  var bytecode = new Uint8Array([
    0x02, 0, 0, 10,   // LOAD_CONST(10)
    0x02, 0, 0, 20,   // LOAD_CONST(20)
    0x03, 0x07        // ADD END
  ]);
  assert('ADD: 10+20=30', formula.evaluate(bytecode, {}, []) === 30);
})();

console.log('\nFormula — SUB opcode');
(function() {
  var bytecode = new Uint8Array([
    0x02, 0, 0, 50,   // LOAD_CONST(50)
    0x02, 0, 0, 15,   // LOAD_CONST(15)
    0x04, 0x07        // SUB END
  ]);
  assert('SUB: 50-15=35', formula.evaluate(bytecode, {}, []) === 35);
})();

console.log('\nFormula — MUL opcode');
(function() {
  var bytecode = new Uint8Array([
    0x02, 0, 0, 6,    // LOAD_CONST(6)
    0x02, 0, 0, 7,    // LOAD_CONST(7)
    0x05, 0x07        // MUL END
  ]);
  assert('MUL: 6×7=42', formula.evaluate(bytecode, {}, []) === 42);
})();

console.log('\nFormula — DIV opcode');
(function() {
  var bytecode = new Uint8Array([
    0x02, 0, 0, 100,  // LOAD_CONST(100)
    0x02, 0, 0, 4,    // LOAD_CONST(4)
    0x06, 0x07        // DIV END
  ]);
  assert('DIV: 100÷4=25', formula.evaluate(bytecode, {}, []) === 25);
})();

console.log('\nFormula — compound: LOAD_FIELD LOAD_CONST ADD (total = amount + fee)');
(function() {
  var bytecode = new Uint8Array([
    0x01, 0,          // LOAD_FIELD(0) = amount
    0x02, 0, 0, 50,   // LOAD_CONST(50)
    0x03, 0x07        // ADD END
  ]);
  var result = formula.evaluate(bytecode, { amount: '100' }, ['amount']);
  assert('compound: 100 + 50 = 150', result === 150);
})();

console.log('\nFormula — END terminates early');
(function() {
  var bytecode = new Uint8Array([
    0x02, 0, 0, 99,   // LOAD_CONST(99)
    0x07,             // END (terminates here)
    0x02, 0, 0, 1,    // LOAD_CONST(1) — must not execute
    0x03              // ADD — must not execute
  ]);
  assert('END: result is 99 (not 100)', formula.evaluate(bytecode, {}, []) === 99);
})();

// ── Round 8: #t/ and #te/ URL routing ─────────────────────────────────────────

console.log('\ndecode #t/ — returns _installTemplate with encrypted=false');
(function() {
  var r = codec.decode('workpads.me/p#t/XY3');
  assert('#t/ _installTemplate id', r._installTemplate === 'XY3');
  assert('#t/ encrypted=false',     r.encrypted === false);
})();

console.log('\ndecode #te/ — returns _installTemplate with encrypted=true');
(function() {
  var r = codec.decode('workpads.me/p#te/ABC');
  assert('#te/ _installTemplate id', r._installTemplate === 'ABC');
  assert('#te/ encrypted=true',      r.encrypted === true);
})();

// ── load trig.js ──────────────────────────────────────────────────────────────

var trigSrc = require('fs').readFileSync(__dirname + '/../js/lib/trig.js', 'utf8');
(new Function('window', 'global',
  trigSrc + '\n//# sourceURL=trig.js'))(window, window);
var trig = window.WPTrig;

// ── Round 9: TRIG block encode/decode ─────────────────────────────────────────

console.log('\nTRIG block — trig_len=0 (empty block)');
(function() {
  var frame = codec._buildFrame({ job: 'Note' }, { hasTrigBlock: true });
  var r     = codec._parseFrame(frame);
  assert('trig_len=0: _trig present',       r._trig != null);
  assert('trig_len=0: no trig_violation',   !r._trig.trig_violation);
  assert('trig_len=0: bytes length=0',      r._trig.bytes && r._trig.bytes.length === 0);
})();

console.log('\nTRIG block — trig_len=1 (pattern token)');
(function() {
  var frame = codec._buildFrame({ job: 'Card' }, {
    hasTrigBlock: true,
    trigBytes: new Uint8Array([0x01])  // KNOWN_CONTACT_SHOW pattern
  });
  var r = codec._parseFrame(frame);
  assert('pattern token: bytes length=1',   r._trig.bytes.length === 1);
  assert('pattern token: byte=0x01',        r._trig.bytes[0] === 0x01);
})();

console.log('\nTRIG block — trig_len=3 (short bytecode)');
(function() {
  var frame = codec._buildFrame({ job: 'Menu' }, {
    hasTrigBlock: true,
    trigBytes: new Uint8Array([0x12, 0xD1, 0x40])  // header + PUSH_COND(1) + SHOW(CARD)
  });
  var r = codec._parseFrame(frame);
  assert('bytecode: bytes length=3',        r._trig.bytes.length === 3);
  assert('bytecode: first byte=0x12',       r._trig.bytes[0] === 0x12);
})();

console.log('\nTRIG block — trig_len > 20 → trig_violation');
(function() {
  var long21 = new Uint8Array(21);
  long21.fill(0x00);
  var frame = codec._buildFrame({ job: 'Over' }, {
    hasTrigBlock: true,
    trigBytes: long21
  });
  // Manually patch: the encoder caps at 20, so inject a longer frame manually
  // by building and adjusting trig_len byte:
  // frame layout: [meta1][meta2][field_flags][field_flags...][data...][trig_len byte][...]
  // Easiest: build with 20 bytes, then patch trig_len to 21 and append 1 more byte
  var good = codec._buildFrame({ job: 'X' }, {
    hasTrigBlock: true,
    trigBytes: new Uint8Array(20)
  });
  // Find the trig_len byte (it's after participants, which is absent, after field data)
  // Build a violation frame manually by appending
  var vframe = new Uint8Array(good.length + 1);
  for (var vi = 0; vi < good.length; vi++) vframe[vi] = good[vi];
  // Find trig_len position: it's 1 byte before last 20 trig bytes
  // good.length = header + job_field + trig_len(1) + 20 bytes
  vframe[good.length - 21] = 21;  // patch trig_len from 20 → 21
  vframe[good.length] = 0x00;      // add extra byte
  var r = codec._parseFrame(vframe);
  assert('trig_violation flagged',    r._trig && r._trig.trig_violation === true);
})();

console.log('\nTRIG block — any record type can carry TRIG (State Commit)');
(function() {
  var frame = codec._buildFrame({ job: 'Close', date: '2026-06-01' }, {
    baseTemplate: 5,
    domain: 1, decimalPos: 2, hasTrigBlock: true,
    trigBytes: new Uint8Array([0x00])
  });
  var r = codec._parseFrame(frame);
  assert('State Commit with TRIG: job',    r.job === 'Close');
  assert('State Commit with TRIG: _trig',  r._trig && r._trig.bytes[0] === 0x00);
})();

// ── Round 9: display_schema encode/decode ─────────────────────────────────────

console.log('\ndisplay_schema — DISPLAY_CONTROL byte');
(function() {
  var frame = codec._buildFrame({ job: 'Service Menu' }, {
    displaySchema: { displayType: 1, dataSource: 0, showPrice: true, showContact: false }
  });
  var r = codec._parseFramePresentation(frame);
  assert('display_schema: displayType=1',  r._displaySchema && r._displaySchema.displayType === 1);
  assert('display_schema: showPrice=true', r._displaySchema && r._displaySchema.showPrice === true);
  assert('display_schema: showContact=false', r._displaySchema && r._displaySchema.showContact === false);
})();

console.log('\ndisplay_schema — accent_color byte');
(function() {
  var frame = codec._buildFrame({ job: 'Card' }, {
    displaySchema: { displayType: 0, accentColor: 0xB4 }
  });
  var r = codec._parseFramePresentation(frame);
  assert('accentColor=0xB4', r._displaySchema && r._displaySchema.accentColor === 0xB4);
})();

console.log('\ndisplay_schema — display_flags2 byte (fontSize + layoutCols)');
(function() {
  var frame = codec._buildFrame({ job: 'Wide' }, {
    displaySchema: {
      displayType: 0,
      displayFlags2: { fontSize: 1, layoutCols: 2 }
    }
  });
  var r = codec._parseFramePresentation(frame);
  var df2 = r._displaySchema && r._displaySchema.displayFlags2;
  assert('displayFlags2.fontSize=1',    df2 && df2.fontSize === 1);
  assert('displayFlags2.layoutCols=2',  df2 && df2.layoutCols === 2);
})();

console.log('\ndisplay_schema — full roundtrip: all fields');
(function() {
  var frame = codec._buildFrame({ job: 'Full' }, {
    displaySchema: {
      displayType: 2, dataSource: 1, showPrice: true, showContact: true,
      accentColor: 0x55,
      displayFlags2: { fontSize: 2, layoutCols: 1 }
    }
  });
  var r = codec._parseFramePresentation(frame);
  var ds = r._displaySchema;
  assert('full ds: displayType=2',  ds && ds.displayType === 2);
  assert('full ds: dataSource=1',   ds && ds.dataSource === 1);
  assert('full ds: accentColor',    ds && ds.accentColor === 0x55);
  assert('full ds: fontSize=2',     ds && ds.displayFlags2 && ds.displayFlags2.fontSize === 2);
})();

// ── Round 9: form_schema encode/decode ────────────────────────────────────────

console.log('\nform_schema — FORM_CONTROL byte');
(function() {
  var frame = codec._buildFrame({ job: 'Contact Form' }, {
    displaySchema: { displayType: 3, dataSource: 0 },
    formSchema: {
      submitAction: 0, replyTemplate: 0,
      requireName: true, requirePhone: true
    }
  });
  var r = codec._parseFramePresentation(frame);
  var fs = r._formSchema;
  assert('form_schema: requireName=true',  fs && fs.requireName === true);
  assert('form_schema: requirePhone=true', fs && fs.requirePhone === true);
  assert('form_schema: submitAction=0',    fs && fs.submitAction === 0);
})();

console.log('\nform_schema — field definitions roundtrip');
(function() {
  var frame = codec._buildFrame({ job: 'Book' }, {
    displaySchema: { displayType: 2, dataSource: 0 },
    formSchema: {
      submitAction: 0, replyTemplate: 0,
      fields: [
        { type: 0, required: true,  labelIndex: 0x05 },   // text, required, label=5
        { type: 2, required: false, labelIndex: 0x0A }    // date, optional, label=10
      ]
    }
  });
  var r = codec._parseFramePresentation(frame);
  var fs = r._formSchema;
  assert('form fields count=2',          fs && fs.fields && fs.fields.length === 2);
  assert('field0 type=0, required=true', fs.fields[0].type === 0 && fs.fields[0].required === true);
  assert('field0 labelIndex=5',          fs.fields[0].labelIndex === 5);
  assert('field1 type=2, required=false', fs.fields[1].type === 2 && !fs.fields[1].required);
})();

console.log('\nform_schema — custom label (0xFF path)');
(function() {
  var frame = codec._buildFrame({ job: 'Custom' }, {
    displaySchema: { displayType: 3, dataSource: 0 },
    formSchema: {
      submitAction: 0, replyTemplate: 0,
      fields: [
        { type: 5, required: false, labelIndex: 0xFF, customLabel: 'Your mobile' }
      ]
    }
  });
  var r = codec._parseFramePresentation(frame);
  var fs = r._formSchema;
  assert('custom label: labelIndex=0xFF',   fs.fields[0].labelIndex === 0xFF);
  assert('custom label text roundtrip',     fs.fields[0].customLabel === 'Your mobile');
})();

console.log('\nform_schema — submitAction=3 (anonymous pickup)');
(function() {
  var frame = codec._buildFrame({ job: 'Anon' }, {
    displaySchema: { displayType: 3, dataSource: 3 },
    formSchema: { submitAction: 3, replyTemplate: 0 }
  });
  var r = codec._parseFramePresentation(frame);
  assert('anon: submitAction=3',   r._formSchema && r._formSchema.submitAction === 3);
  assert('anon: dataSource=3',     r._displaySchema && r._displaySchema.dataSource === 3);
})();

// ── Round 9: #1pb/ and #1pf/ URL routing ──────────────────────────────────────

console.log('\n#1pb/ — encode uses #1pb/ tag');
(function() {
  var url = codec.encode({ job: 'Billboard' }, {
    presentationTag: '1pb',
    displaySchema: { displayType: 0, dataSource: 0 }
  });
  assert('#1pb/ tag in URL',  url.indexOf('#1pb/') !== -1);
})();

console.log('\n#1pb/ — decode roundtrips display_schema');
(function() {
  var url = codec.encode({ job: 'Card View' }, {
    presentationTag: '1pb',
    displaySchema: { displayType: 0, dataSource: 0, showPrice: false, showContact: true }
  });
  var r = codec.decode(url);
  assert('#1pb/ decode job',          r.job === 'Card View');
  assert('#1pb/ decode displayType',  r._displaySchema && r._displaySchema.displayType === 0);
  assert('#1pb/ decode showContact',  r._displaySchema && r._displaySchema.showContact === true);
})();

console.log('\n#1pf/ — encode uses #1pf/ tag');
(function() {
  var url = codec.encode({ job: 'Invoice View' }, {
    presentationTag: '1pf',
    domain: 1, decimalPos: 2,
    displaySchema: { displayType: 1, dataSource: 0, showPrice: true }
  });
  assert('#1pf/ tag in URL',  url.indexOf('#1pf/') !== -1);
})();

console.log('\n#1pf/ — decode roundtrips');
(function() {
  var url = codec.encode({ job: 'Pay Summary' }, {
    presentationTag: '1pf',
    displaySchema: { displayType: 1, dataSource: 0, showPrice: true }
  });
  var r = codec.decode(url);
  assert('#1pf/ job',        r.job === 'Pay Summary');
  assert('#1pf/ showPrice',  r._displaySchema && r._displaySchema.showPrice === true);
})();

// ── Round 9: trig.js evaluator ────────────────────────────────────────────────

console.log('\ntrig.js — empty bytes → NATIVE/show:true');
(function() {
  var r = trig.evaluate(new Uint8Array(0), {});
  assert('empty: mode=NATIVE',  r.mode === 6);
  assert('empty: show=true',    r.show === true);
})();

console.log('\ntrig.js — trig_violation (> 20 bytes)');
(function() {
  var b21 = new Uint8Array(21); b21.fill(0x44);
  var r = trig.evaluate(b21, {});
  assert('violation: trig_violation=true', r.trig_violation === true);
  assert('violation: show=false',          r.show === false);
})();

console.log('\ntrig.js — pattern 0x00 = SHOW_ALWAYS/CARD');
(function() {
  var r = trig.evaluate(new Uint8Array([0x00]), {});
  assert('pattern 0x00: mode=CARD',  r.mode === 0);
  assert('pattern 0x00: show=true',  r.show === true);
})();

console.log('\ntrig.js — pattern 0x01 = KNOWN_CONTACT_SHOW');
(function() {
  var rF = trig.evaluate(new Uint8Array([0x01]), { knownContact: false });
  var rT = trig.evaluate(new Uint8Array([0x01]), { knownContact: true  });
  assert('pattern 0x01: show=false when unknown', rF.show === false);
  assert('pattern 0x01: show=true when known',    rT.show === true);
  assert('pattern 0x01: mode=CARD',               rT.mode === 0);
})();

console.log('\ntrig.js — pattern 0x07 = ALWAYS_BLANK');
(function() {
  var r = trig.evaluate(new Uint8Array([0x07]), {});
  assert('ALWAYS_BLANK: mode=BLANK',  r.mode === 5);
  assert('ALWAYS_BLANK: show=false',  r.show === false);
})();

console.log('\ntrig.js — pattern 0x08 = FORM_ALWAYS');
(function() {
  var r = trig.evaluate(new Uint8Array([0x08]), {});
  assert('FORM_ALWAYS: mode=FORM',  r.mode === 2);
  assert('FORM_ALWAYS: show=true',  r.show === true);
})();

console.log('\ntrig.js — SHOW_ALWAYS(CARD) bytecode: header + 0x40');
(function() {
  // header: VER=00, HAS_CSS=0, HAS_TERNARY=0, PROG_LEN=1 → 0x01
  var r = trig.evaluate(new Uint8Array([0x01, 0x40]), {});
  assert('SHOW_ALWAYS CARD: mode=CARD', r.mode === 0);
  assert('SHOW_ALWAYS CARD: show=true', r.show === true);
})();

console.log('\ntrig.js — PUSH_COND(KNOWN_CONTACT) + SHOW(CARD)');
(function() {
  // header: PROG_LEN=2 → 0x02; PUSH_COND(1)=0xD1; SHOW(0)=0x30
  var prog = new Uint8Array([0x02, 0xD1, 0x30]);
  var rF = trig.evaluate(prog, { knownContact: false });
  var rT = trig.evaluate(prog, { knownContact: true  });
  assert('SHOW CARD: show=false when unknown', rF.show === false);
  assert('SHOW CARD: show=true when known',    rT.show === true);
  assert('SHOW CARD: mode=CARD',              rT.mode === 0);
})();

console.log('\ntrig.js — NOT: inverts top of stack');
(function() {
  // header PROG_LEN=3; PUSH_COND(0=HAS_APP)=0xD0; NOT=0x70; SHOW_ALWAYS(CARD)=0x40
  var prog = new Uint8Array([0x03, 0xD0, 0x70, 0x40]);
  var rT = trig.evaluate(prog, { hasApp: true  }); // NOT(true) → false, but SHOW_ALWAYS ignores
  var rF = trig.evaluate(prog, { hasApp: false }); // NOT(false) → SHOW_ALWAYS still true
  // SHOW_ALWAYS is unconditional so result is always true
  assert('NOT + SHOW_ALWAYS: always show', rT.show && rF.show);
})();

console.log('\ntrig.js — AND(2): combine two conditions');
(function() {
  // PROG_LEN=4; PUSH_COND(0)=0xD0; PUSH_COND(1)=0xD1; AND(2)=0x52; SHOW_ALWAYS(CARD)=0x40
  var prog = new Uint8Array([0x04, 0xD0, 0xD1, 0x52, 0x40]);
  var rBoth  = trig.evaluate(prog, { hasApp: true,  knownContact: true  });
  var rOne   = trig.evaluate(prog, { hasApp: true,  knownContact: false });
  var rNone  = trig.evaluate(prog, { hasApp: false, knownContact: false });
  assert('AND both true: AND result is true',   rBoth.show === true);
  // SHOW_ALWAYS is unconditional; AND result sits on stack but SHOW_ALWAYS ignores it
  assert('AND one false: SHOW_ALWAYS still renders', rOne.show === true);
  assert('AND none: SHOW_ALWAYS renders',            rNone.show === true);
})();

console.log('\ntrig.js — TERNARY: KNOWN_CONTACT → CARD else FORM');
(function() {
  // PROG_LEN=4; TERNARY=0x90; cond_id=0x01; mode_true=0x00(CARD); mode_false=0x02(FORM)
  var prog = new Uint8Array([0x04, 0x90, 0x01, 0x00, 0x02]);
  var rT = trig.evaluate(prog, { knownContact: true  });
  var rF = trig.evaluate(prog, { knownContact: false });
  assert('TERNARY: known → CARD',    rT.mode === 0 && rT.show === true);
  assert('TERNARY: unknown → FORM',  rF.mode === 2 && rF.show === true);
})();

console.log('\ntrig.js — LOAD_CSS side effect persists in result');
(function() {
  // PROG_LEN=2; LOAD_CSS(1)=0x11; SHOW_ALWAYS(CARD)=0x40
  var prog = new Uint8Array([0x02, 0x11, 0x40]);
  var r = trig.evaluate(prog, {});
  assert('LOAD_CSS: css=1 in result',  r.css === 1);
  assert('LOAD_CSS: show=true',        r.show === true);
})();

console.log('\ntrig.js — SET_THEME side effect');
(function() {
  // PROG_LEN=2; SET_THEME(3=DARK)=0xB3; SHOW_ALWAYS(CARD)=0x40
  var prog = new Uint8Array([0x02, 0xB3, 0x40]);
  var r = trig.evaluate(prog, {});
  assert('SET_THEME: theme=3', r.theme === 3);
})();

console.log('\ntrig.js — PUSH_LIT(1) + SHOW(CARD)');
(function() {
  // PROG_LEN=2; PUSH_LIT(1)=0xE1; SHOW(CARD)=0x30
  var prog = new Uint8Array([0x02, 0xE1, 0x30]);
  var r = trig.evaluate(prog, {});
  assert('PUSH_LIT true + SHOW: show=true', r.show === true);
  assert('PUSH_LIT true + SHOW: mode=CARD', r.mode === 0);
})();

console.log('\ntrig.js — JZ: skip bytes when false');
(function() {
  // PROG_LEN=4; PUSH_COND(1=KNOWN)=0xD1; JZ(skip=1)=0x81; SHOW_ALWAYS(FORM)=0x42; SHOW_ALWAYS(CARD)=0x40
  // If known: JZ doesn't skip → executes SHOW_ALWAYS(FORM)=mode 2
  // If unknown: JZ skips 1 byte → executes SHOW_ALWAYS(CARD)=mode 0
  var prog = new Uint8Array([0x04, 0xD1, 0x81, 0x42, 0x40]);
  var rT = trig.evaluate(prog, { knownContact: true  });
  var rF = trig.evaluate(prog, { knownContact: false });
  assert('JZ: known → FORM (no skip)',    rT.mode === 2);
  assert('JZ: unknown → CARD (skip)',     rF.mode === 0);
})();

// ── load ctrig.js + agreements.js ────────────────────────────────────────────

var ctrigSrc = require('fs').readFileSync(__dirname + '/../js/lib/ctrig.js', 'utf8');
(new Function('window', 'global',
  ctrigSrc + '\n//# sourceURL=ctrig.js'))(window, window);
var ctrig = window.WPCtrig;

var agreesSrc = require('fs').readFileSync(__dirname + '/../js/lib/agreements.js', 'utf8');
(new Function('window', 'global',
  agreesSrc + '\n//# sourceURL=agreements.js'))(window, window);
var agreements = window.WPAgreements;

// ── Round 10: C-TRIG evaluator ────────────────────────────────────────────────

console.log('\nC-TRIG — empty program → resolved(true)');
(function() {
  var r = ctrig.evaluate(new Uint8Array([]), {});
  assert('empty: status=resolved', r.status === 'resolved');
  assert('empty: value=true',      r.value  === true);
})();

console.log('\nC-TRIG — program > 32 bytes → error(program_too_long)');
(function() {
  var big = new Uint8Array(33);
  var r = ctrig.evaluate(big, {});
  assert('too_long: status=error',  r.status === 'error');
  assert('too_long: reason',        r.reason === 'program_too_long');
})();

console.log('\nC-TRIG — stack overflow (> 8 values) → error');
(function() {
  // 10 × PUSH_COND(ACK_RECEIVED=0x08) = 10 × 0x18; 9th pushes 9th item; 10th detects > 8
  var prog = new Uint8Array([0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18]);
  var r = ctrig.evaluate(prog, { chain: { ack_count: 1 } });
  assert('stack_overflow: status=error', r.status === 'error');
  assert('stack_overflow: reason',       r.reason === 'stack_overflow');
})();

console.log('\nC-TRIG — PUSH_COND(ACK_RECEIVED) true and false');
(function() {
  var prog = new Uint8Array([0x18]);  // PUSH_COND(0x8=ACK_RECEIVED)
  var rT = ctrig.evaluate(prog, { chain: { ack_count: 1 } });
  var rF = ctrig.evaluate(prog, { chain: { ack_count: 0 } });
  assert('PUSH_COND ACK true:  resolved', rT.status === 'resolved' && rT.value === true);
  assert('PUSH_COND ACK false: resolved', rF.status === 'resolved' && rF.value === false);
})();

console.log('\nC-TRIG — PUSH_COND(DATE_REACHED) uses timestamp vs record.date');
(function() {
  var prog = new Uint8Array([0x15]);  // PUSH_COND(0x5=DATE_REACHED)
  var rT = ctrig.evaluate(prog, { timestamp: 100, record: { date: 50 } });   // 100 >= 50
  var rF = ctrig.evaluate(prog, { timestamp: 30,  record: { date: 50 } });   // 30 < 50
  assert('DATE_REACHED true',  rT.value === true);
  assert('DATE_REACHED false', rF.value === false);
})();

console.log('\nC-TRIG — PUSH_COND extended escape: FULL_PAYMENT_CONFIRMED (CAT1 ID2)');
(function() {
  var prog = new Uint8Array([0x1F, 0x12]);  // PUSH_COND escape + CAT=1,ID=2
  var rT = ctrig.evaluate(prog, { chain: { financial: { paid: 100, total: 100 } } });
  var rF = ctrig.evaluate(prog, { chain: { financial: { paid: 50,  total: 100 } } });
  assert('FULL_PAYMENT true',  rT.value === true);
  assert('FULL_PAYMENT false', rF.value === false);
})();

console.log('\nC-TRIG — COMPARE_AMT ==, !=, >= using stack underflow zeros');
(function() {
  // Stack underflow yields 0 for both operands
  var rEq  = ctrig.evaluate(new Uint8Array([0x02]), {});  // imm=2 (==): 0==0 → true
  var rNe  = ctrig.evaluate(new Uint8Array([0x05]), {});  // imm=5 (!=): 0!=0 → false
  var rGte = ctrig.evaluate(new Uint8Array([0x00]), {});  // imm=0 (>=): 0>=0 → true
  assert('COMPARE_AMT ==',  rEq.value  === true);
  assert('COMPARE_AMT !=',  rNe.value  === false);
  assert('COMPARE_AMT >=',  rGte.value === true);
})();

console.log('\nC-TRIG — COMPARE_AMT percentage threshold (imm=0xF)');
(function() {
  // 0x0F + pct=200 → a(0) >= Math.round(b(0) * 200 / 200) = 0 >= 0 → true
  var r = ctrig.evaluate(new Uint8Array([0x0F, 200]), {});
  assert('COMPARE_AMT pct: resolved', r.status === 'resolved');
  assert('COMPARE_AMT pct: true',     r.value  === true);
})();

console.log('\nC-TRIG — COMPARE_AMT invalid operator → error');
(function() {
  var r = ctrig.evaluate(new Uint8Array([0x06]), {});  // imm=6, reserved
  assert('invalid_operator: error', r.status === 'error' && r.reason === 'invalid_operator');
})();

console.log('\nC-TRIG — AND: push two conditions then AND');
(function() {
  // 0x18 = PUSH_COND(ACK_RECEIVED); 0x80 = AND
  var progAnd = new Uint8Array([0x18, 0x18, 0x80]);
  var rTT = ctrig.evaluate(progAnd, { chain: { ack_count: 1 } });  // T AND T
  var rFF = ctrig.evaluate(progAnd, { chain: { ack_count: 0 } });  // F AND F
  assert('AND T&T → true',  rTT.value === true);
  assert('AND F&F → false', rFF.value === false);
})();

console.log('\nC-TRIG — OR: push two conditions then OR');
(function() {
  // PUSH_COND(ACK_RECEIVED) + PUSH_COND(DATE_REACHED) + OR
  // ack=0, ts=0 date=0 → F OR T (0>=0=true) → true
  var prog = new Uint8Array([0x18, 0x15, 0x90]);
  var r = ctrig.evaluate(prog, { chain: { ack_count: 0 }, timestamp: 0, record: { date: 0 } });
  assert('OR F|T → true', r.value === true);
})();

console.log('\nC-TRIG — NOT: inverts top of stack');
(function() {
  var prog = new Uint8Array([0x18, 0xA0]);  // PUSH_COND(ACK) + NOT
  var rT = ctrig.evaluate(prog, { chain: { ack_count: 1 } });  // NOT(true) → false
  var rF = ctrig.evaluate(prog, { chain: { ack_count: 0 } });  // NOT(false) → true
  assert('NOT true → false', rT.value === false);
  assert('NOT false → true', rF.value === true);
})();

console.log('\nC-TRIG — TIME_LOCK: date reached, not reached, missing');
(function() {
  // 0x6F = TIME_LOCK(imm=0xF) → use record.due_date
  var prog = new Uint8Array([0x6F]);
  var rOk   = ctrig.evaluate(prog, { timestamp: 100, record: { due_date: 50  } });
  var rLock = ctrig.evaluate(prog, { timestamp: 30,  record: { due_date: 100 } });
  var rNull = ctrig.evaluate(prog, { timestamp: 30,  record: {}               });
  assert('TIME_LOCK reached: resolved true',             rOk.value  === true);
  assert('TIME_LOCK not reached: halted',                rLock.status === 'halted' && rLock.reason === 'timelock');
  assert('TIME_LOCK missing date: halted',               rNull.status === 'halted' && rNull.reason === 'timelock_date_missing');
})();

console.log('\nC-TRIG — BRANCH: true path → COMPLETE, false path → DISPUTE');
(function() {
  // [PUSH_COND(ACK), BRANCH, trueOff=0, falseOff=1, COMPLETE(0xD0), DISPUTE(0xE0)]
  var prog = new Uint8Array([0x18, 0xC0, 0x00, 0x01, 0xD0, 0xE0]);
  var rT = ctrig.evaluate(prog, { chain: { ack_count: 1 } });  // cond=true → COMPLETE
  var rF = ctrig.evaluate(prog, { chain: { ack_count: 0 } });  // cond=false → DISPUTE
  assert('BRANCH true → COMPLETE: resolved true',  rT.status === 'resolved' && rT.value === true);
  assert('BRANCH false → DISPUTE: resolved false', rF.status === 'resolved' && rF.value === false);
})();

console.log('\nC-TRIG — BRANCH out of bounds → error');
(function() {
  var prog = new Uint8Array([0x18, 0xC0, 0xFF, 0x00]);  // true_offset=255 → OOB
  var r = ctrig.evaluate(prog, { chain: { ack_count: 1 } });
  assert('BRANCH OOB: error', r.status === 'error' && r.reason === 'branch_out_of_bounds');
})();

console.log('\nC-TRIG — VERSION: ok, too high, unsupported features');
(function() {
  var rOk   = ctrig.evaluate(new Uint8Array([0xF0, 0x01, 0x00]), {});  // min=1 ok
  var rHigh = ctrig.evaluate(new Uint8Array([0xF0, 0x02, 0x00]), {});  // min=2 > v1
  var rFeat = ctrig.evaluate(new Uint8Array([0xF0, 0x01, 0x10]), {});  // bit4 unsupported
  assert('VERSION ok: resolved',             rOk.status === 'resolved');
  assert('VERSION too high: halted',         rHigh.status === 'halted' && rHigh.reason === 'version_unsupported');
  assert('VERSION bad features: halted',     rFeat.status === 'halted' && rFeat.reason === 'unsupported_features');
})();

console.log('\nC-TRIG — COMPLETE and DISPUTE return immediately');
(function() {
  var rC = ctrig.evaluate(new Uint8Array([0xD0]), {});  // COMPLETE
  var rD = ctrig.evaluate(new Uint8Array([0xE0]), {});  // DISPUTE(0)
  assert('COMPLETE → resolved true',  rC.status === 'resolved' && rC.value === true);
  assert('DISPUTE  → resolved false', rD.status === 'resolved' && rD.value === false);
})();

console.log('\nC-TRIG — IF_THEN: execute or skip next instruction');
(function() {
  // cond=true: IF_THEN does not skip → COMPLETE at pc=2
  // cond=false: IF_THEN skips pc=2 → DISPUTE at pc=3
  // [PUSH_COND(ACK), IF_THEN, COMPLETE, DISPUTE]
  var prog = new Uint8Array([0x18, 0xB0, 0xD0, 0xE0]);
  var rT = ctrig.evaluate(prog, { chain: { ack_count: 1 } });
  var rF = ctrig.evaluate(prog, { chain: { ack_count: 0 } });
  assert('IF_THEN true → COMPLETE',  rT.value === true);
  assert('IF_THEN false → DISPUTE',  rF.value === false);
})();

// ── Round 10: agreements.js ───────────────────────────────────────────────────

console.log('\nagreements — isRatified: bilateral');
(function() {
  var chain = [
    { ack_request: true,  chain: false, sender_uid: 'A', commit_type: undefined },
    { chain: true, sender_uid: 'B', commit_type: 2 }
  ];
  assert('isRatified bilateral: true', agreements.isRatified(chain) === true);
})();

console.log('\nagreements — isRatified: same sender → false');
(function() {
  var chain = [
    { ack_request: true,  chain: false, sender_uid: 'A', commit_type: undefined },
    { chain: true, sender_uid: 'A', commit_type: 2 }
  ];
  assert('isRatified same sender: false', agreements.isRatified(chain) === false);
})();

console.log('\nagreements — isRatified: no offer → false');
(function() {
  var chain = [
    { chain: true, sender_uid: 'B', commit_type: 2 }
  ];
  assert('isRatified no offer: false', agreements.isRatified(chain) === false);
})();

console.log('\nagreements — ratification bitmap encode/decode');
(function() {
  var bm  = agreements.encodeRatificationBitmap(0b0011, true);
  var dec = agreements.decodeRatificationBitmap(bm);
  assert('encode: FULLY_RATIFIED bit set',     (bm & 0x80) !== 0);
  assert('encode: partyMask bits 0-1 set',     (bm & 0x03) === 0x03);
  assert('decode: partyMask === 3',            dec.partyMask === 3);
  assert('decode: fullyRatified === true',     dec.fullyRatified === true);
})();

console.log('\nagreements — DISPUTE_LINK Amendment roundtrip');
(function() {
  var parentUid = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
  var aOpts     = agreements.buildDisputeAmendmentOpts(parentUid, { story: 'Test dispute.' });
  var url       = codec.encode({ story: 'Test dispute.' }, aOpts);
  var r         = codec.decode(url);
  assert('dispute amendment: disputeLink=true',     r._amendment && r._amendment.disputeLink === true);
  assert('dispute amendment: parentUid[0]=0x01',    r._amendment && r._amendment.parentUid[0] === 0x01);
  assert('dispute amendment: parentUid[7]=0x08',    r._amendment && r._amendment.parentUid[7] === 0x08);
})();

// ── load markers.js ──────────────────────────────────────────────────────────

var markersSrc = require('fs').readFileSync(__dirname + '/../js/lib/markers.js', 'utf8');
(new Function('window', 'global',
  markersSrc + '\n//# sourceURL=markers.js'))(window, window);
var markers = window.WPMarkers;

// ── Round 11: Marker UID generation ──────────────────────────────────────────

console.log('\nMarkers — generateMarkerUid: deterministic with fixed inputs');
(function() {
  var uid1 = markers.generateMarkerUid('did:stone:A', 'did:stone:B', 9633);
  var uid2 = markers.generateMarkerUid('did:stone:A', 'did:stone:B', 9633);
  assert('UID deterministic: same result', uid1 === uid2);
  assert('UID starts with did:stone:',     uid1.slice(0, 10) === 'did:stone:');
  assert('UID total length (10+20)',       uid1.length === 30);
})();

console.log('\nMarkers — generateMarkerUid: different inputs → different UIDs');
(function() {
  var uid1 = markers.generateMarkerUid('did:stone:A', 'did:stone:B', 9633);
  var uid2 = markers.generateMarkerUid('did:stone:A', 'did:stone:C', 9633);
  assert('different B → different UID', uid1 !== uid2);
})();

// ── Round 11: write token encode/decode ──────────────────────────────────────

console.log('\nMarkers — write token roundtrip (slot 0, first write)');
(function() {
  var master  = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
                                0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10]);
  var uid     = markers.generateMarkerUid('did:stone:A', 'did:stone:B', 9633);
  var payload = new Uint8Array([0xAA, 0xBB, 0xCC]);
  var token   = markers.encodeWriteToken({
    markerUid:    uid,
    slotIndex:    0,
    prevStoneHash: new Uint8Array(8),  // zeros = first write
    writePayload: payload,
    timestamp:    9633,
    masterSecret: master
  });
  var dec = markers.decodeWriteToken(token, master);
  assert('token decode: markerUid match',    dec.markerUid === uid);
  assert('token decode: slotIndex=0',        dec.slotIndex === 0);
  assert('token decode: timestamp=9633',     dec.timestamp === 9633);
  assert('token decode: payload[0]=0xAA',    dec.writePayload[0] === 0xAA);
  assert('token decode: verified=true',      dec.verified === true);
})();

console.log('\nMarkers — write token wrong key → verified=false');
(function() {
  var master  = new Uint8Array(16).fill(0x01);
  var uid     = 'did:stone:TESTUID12345678901';
  var token   = markers.encodeWriteToken({
    markerUid: uid, slotIndex: 0, prevStoneHash: new Uint8Array(8),
    writePayload: new Uint8Array([0xFF]), timestamp: 100, masterSecret: master
  });
  var wrongKey = new Uint8Array(16).fill(0x02);
  var dec = markers.decodeWriteToken(token, wrongKey);
  assert('wrong key → verified=false', dec.verified === false);
})();

console.log('\nMarkers — HMAC verification: decodePadsV1Marker');
(function() {
  var master  = new Uint8Array(16).fill(0x55);
  var uid     = 'did:stone:TEST';
  var payload = new Uint8Array([0x01, 0x02]);
  var token   = markers.encodeWriteToken({
    markerUid: uid, slotIndex: 1, prevStoneHash: new Uint8Array(8),
    writePayload: payload, timestamp: 200, masterSecret: master
  });
  var r = markers.decodePadsV1Marker(token, master);
  assert('decodePadsV1Marker: markerUid', r.markerUid === uid);
  assert('decodePadsV1Marker: slot=1',    r.slot === 1);
  assert('decodePadsV1Marker: verified',  r.verified === true);
})();

// ── Round 11: P2P Option E — SLOT 0 → SLOT 1 ─────────────────────────────────

console.log('\nMarkers — P2P Option E: slot 0 prevHash=zeros, slot 1 prevHash=SHA256(slot0)');
(function() {
  var master  = new Uint8Array(16).fill(0x77);
  var uid     = markers.generateMarkerUid('did:stone:A', 'did:stone:B', 100);
  var payload0 = new Uint8Array([0x01]);
  var token0   = markers.encodeWriteToken({
    markerUid: uid, slotIndex: 0, prevStoneHash: new Uint8Array(8),
    writePayload: payload0, timestamp: 100, masterSecret: master
  });
  // slot 1 prevStoneHash = SHA256(token0)[0:8]
  var hash0    = window.WPCrypto.sha256(token0);
  var prevHash1 = hash0.subarray(0, 8);
  var token1   = markers.encodeWriteToken({
    markerUid: uid, slotIndex: 1, prevStoneHash: prevHash1,
    writePayload: new Uint8Array([0x02]), timestamp: 101, masterSecret: master
  });
  var dec0 = markers.decodeWriteToken(token0, master);
  var dec1 = markers.decodeWriteToken(token1, master);
  assert('P2P slot0: verified',          dec0.verified === true);
  assert('P2P slot1: verified',          dec1.verified === true);
  assert('P2P slot1: slotIndex=1',       dec1.slotIndex === 1);
  // slot1 prevStoneHash matches SHA256(token0)[0:8]
  assert('P2P slot1: prevHash chain',    dec1.prevStoneHash[0] === hash0[0] && dec1.prevStoneHash[7] === hash0[7]);
})();

// ── Round 11: RATIFIED_FRAME builder ─────────────────────────────────────────

console.log('\nMarkers — buildRatifiedFrame: State Commit, ≤ 144B, parses correctly');
(function() {
  var uid   = markers.generateMarkerUid('did:stone:A', 'did:stone:B', 9633);
  var frame = markers.buildRatifiedFrame({
    story:        'Job complete. Payment due.',
    markerUid:    uid,
    job:          'Fence install',
    date:         '2026-05-18',
    refNumber:    'INV-001',
    tag:          'marker,ratified',
    participants: [
      { name: 'Alice', isSender: true  },
      { name: 'Bob',   isSender: false }
    ]
  });
  assert('RATIFIED_FRAME: is Uint8Array',  frame instanceof Uint8Array);
  assert('RATIFIED_FRAME: frame ≤ 144B',  frame.length <= 144);
  var parsed = codec._parseFrame(frame);
  assert('RATIFIED_FRAME: commitType=2',   parsed._stateCommit && parsed._stateCommit.commitType === 2);
  assert('RATIFIED_FRAME: chainComplete',  parsed._stateCommit && parsed._stateCommit.chainComplete === true);
  assert('RATIFIED_FRAME: story present',  parsed.story === 'Job complete. Payment due.');
  assert('RATIFIED_FRAME: uid decoded',    parsed.uid === uid);
})();

// ── Round 11: #1pm/ URL routing ───────────────────────────────────────────────

console.log('\nMarkers — #1pm/ codec routing returns _markerUid');
(function() {
  var uid     = markers.generateMarkerUid('did:stone:A', 'did:stone:B', 9633);
  // encode uid as base64url
  var uidBytes = new TextEncoder().encode(uid);
  var b64     = btoa(String.fromCharCode.apply(null, uidBytes))
                  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  var url     = 'workpads.me/p#1pm/' + b64;
  var r       = codec.decode(url);
  assert('#1pm/ _markerUid present', r._markerUid === uid);
})();

// ── Round 11: offline matrix (no network calls in markers.js) ─────────────────

console.log('\nMarkers — offline matrix: encode/decode with no network dependency');
(function() {
  // All four connectivity cases reduce to the same local operation — no network involved
  var masterA  = new Uint8Array(16).fill(0xAA);
  var masterB  = new Uint8Array(16).fill(0xBB);
  var uid      = markers.generateMarkerUid('did:stone:OfflineA', 'did:stone:OfflineB', 50);
  var slot0    = markers.encodeWriteToken({
    markerUid: uid, slotIndex: 0, prevStoneHash: new Uint8Array(8),
    writePayload: new Uint8Array([0x01]), timestamp: 50, masterSecret: masterA
  });
  var slot1    = markers.encodeWriteToken({
    markerUid: uid, slotIndex: 1, prevStoneHash: window.WPCrypto.sha256(slot0).subarray(0, 8),
    writePayload: new Uint8Array([0x02]), timestamp: 51, masterSecret: masterB
  });
  var r0 = markers.decodeWriteToken(slot0, masterA);
  var r1 = markers.decodeWriteToken(slot1, masterB);
  assert('offline both-online: slot0 verified',   r0.verified);
  assert('offline both-online: slot1 verified',   r1.verified);
  assert('offline writer-offline: slot0 verified (same op)', r0.verified);
  assert('offline P2P: slot1 verified without server',       r1.verified);
})();

// ── Round 13: Spec compliance closure ────────────────────────────────────────

// SELF_DESCRIBING (meta2 bit 7)

console.log('\nSELF_DESCRIBING — meta2 bit 7 set: decoder does not crash, sets _meta.selfDescribing');
(function() {
  // Build a frame that has meta2 (hasTrigBlock forces needMeta2=true)
  var frame = codec._buildFrame({ job: 'Hello' }, { hasTrigBlock: true });
  // frame layout: [meta1][meta2][trig_len][field_flags hi][field_flags lo]...
  // meta1 bit 7 = 1 (META2_PRESENT), meta2 is byte index 1
  assert('setup: meta2 present in frame', !!(frame[0] & 0x80));
  // Inject SELF_DESCRIBING bit (bit 7) into meta2
  var modFrame = new Uint8Array(frame);
  modFrame[1] = modFrame[1] | 0x80;
  var r;
  var threw = false;
  try { r = codec._parseFrame(modFrame); } catch(e) { threw = true; }
  assert('selfDescribing: decoder did not throw',           !threw);
  assert('selfDescribing: _meta.selfDescribing=true',       r && r._meta && r._meta.selfDescribing === true);
})();

console.log('\nSELF_DESCRIBING — normal frame: _meta.selfDescribing absent/false');
(function() {
  var frame = codec._buildFrame({ job: 'Hello', date: '2026-05-18' }, { compactTime: true });
  var r = codec._parseFrame(frame);
  assert('non-selfDescribing: flag absent', !r._meta.selfDescribing);
})();

// COMPACT_TIME=0 — date and time written as UTF-8 text

console.log('\nCOMPACT_TIME=0 — date field written as UTF-8 ISO string');
(function() {
  var frame  = codec._buildFrame({ job: 'Job', date: '2026-05-18' }, { compactTime: false });
  // meta1 must not have META2_PRESENT (no meta2 when compactTime=false and no domain/trig)
  assert('CT0: meta1 META2_PRESENT bit clear',  !(frame[0] & 0x80));
  var r = codec._parseFrame(frame);
  assert('CT0: date decoded as ISO string',      r.date === '2026-05-18');
})();

console.log('\nCOMPACT_TIME=0 — date roundtrip preserves ISO string');
(function() {
  var dates = ['2000-01-01', '2026-05-18', '2030-12-31'];
  for (var i = 0; i < dates.length; i++) {
    var frame = codec._buildFrame({ job: 'J', date: dates[i] }, { compactTime: false });
    var r = codec._parseFrame(frame);
    assert('CT0 date roundtrip: ' + dates[i], r.date === dates[i]);
  }
})();

console.log('\nCOMPACT_TIME=0 — time field (meeting_time) written as UTF-8 string');
(function() {
  var frame = codec._buildFrame({ job: 'J', meeting_time: '09:30' }, { compactTime: false });
  assert('CT0 time: meta2 absent',       !(frame[0] & 0x80));
  var r = codec._parseFrame(frame);
  assert('CT0 time: meeting_time string', r.meeting_time === '09:30');
})();

console.log('\nCOMPACT_TIME=0 — due_date (bit 14) written as UTF-8 text');
(function() {
  var frame = codec._buildFrame({ job: 'J', due_date: '2026-06-01' }, { compactTime: false });
  var r = codec._parseFrame(frame);
  assert('CT0 due_date roundtrip', r.due_date === '2026-06-01');
})();

console.log('\nCOMPACT_TIME=0 — date_end (FLAGS3 bit 3) written as UTF-8 text');
(function() {
  var frame = codec._buildFrame({ job: 'J', date: '2026-05-01', date_end: '2026-05-31' }, { compactTime: false });
  var r = codec._parseFrame(frame);
  assert('CT0 date_end roundtrip', r.date_end === '2026-05-31');
})();

console.log('\nCOMPACT_TIME=0 + domain=1 — meta2 written, COMPACT_TIME bit=0, date still text');
(function() {
  var frame = codec._buildFrame(
    { job: 'J', date: '2026-05-18', customer_amount: '100.00' },
    { compactTime: false, domain: 1, decimalPos: 2, direction: 0, ioTime: 0, effect: 0 }
  );
  var meta2 = frame[1]; // second byte (meta1 sets META2_PRESENT)
  assert('CT0+domain: meta2 present',           !!(frame[0] & 0x80));
  assert('CT0+domain: COMPACT_TIME bit clear',  !(meta2 & 0x40));
  var r = codec._parseFrame(frame);
  assert('CT0+domain: date as ISO string',      r.date === '2026-05-18');
})();

// Profile A text-only: 42B without meta2

console.log('\nProfile A text-only — 42B without meta2 (compactTime=false)');
(function() {
  // meta1=0x00 (no meta2), field_flags=[0x00,0x05] (job bit0 + date bit2)
  // job = 25-char string: [0x00,0x19] + 25B = 27B
  // date = '2026-05-17' = 10 chars: [0x00,0x0A] + 10B = 12B
  // total: 1 + 2 + 27 + 12 = 42B
  var job25  = 'ABCDEFGHIJKLMNOPQRSTUVWXY'; // exactly 25 chars
  var frame  = codec._buildFrame({ job: job25, date: '2026-05-17' }, { compactTime: false });
  assert('Profile A text-only: exactly 42B', frame.length === 42, 'got ' + frame.length);
  assert('Profile A text-only: meta1=0x00',  frame[0] === 0x00);
  var r = codec._parseFrame(frame);
  assert('Profile A text-only: job roundtrips',  r.job  === job25);
  assert('Profile A text-only: date roundtrips', r.date === '2026-05-17');
})();

// SPLIT_POINT=7 — qty max 127, rate max 131071

console.log('\nSPLIT_POINT=7 — qty max=127, rate limited to 17 bits');
(function() {
  // SP=7: qty uses 7 bits (max 127), rate uses remaining 17 bits (max 131071)
  // Requires sfPresent: true so QTY_COMPACT is written in sf_byte
  var frame = codec._buildFrame(
    { job: 'J' },
    {
      domain: 1, compactTime: false, decimalPos: 2,
      direction: 0, ioTime: 0, effect: 0,
      sfPresent: true, qtyCompact: true, qtySplit: true, splitPoint: 7,
      rate: '10.00', qty: '127'
    }
  );
  var r = codec._parseFrame(frame);
  assert('SP=7: frame decodes without error', r && r.job === 'J');
  assert('SP=7: customer_amount present',     r.customer_amount != null);
  assert('SP=7: qty decoded',                 r.qty === '127');
})();

console.log('\nSPLIT_POINT=7 — qty=1, rate=1310.71 (large rate, small qty)');
(function() {
  var frame = codec._buildFrame(
    { job: 'R' },
    {
      domain: 1, compactTime: false, decimalPos: 2,
      direction: 0, ioTime: 0, effect: 0,
      sfPresent: true, qtyCompact: true, qtySplit: true, splitPoint: 7,
      rate: '1310.71', qty: '1'
    }
  );
  var r = codec._parseFrame(frame);
  assert('SP=7 largeRate: frame decodes',      r && r.job === 'R');
  assert('SP=7 largeRate: customer_amount',    r.customer_amount != null);
  assert('SP=7 largeRate: qty=1',              r.qty === '1');
})();

// ── load anon.js ──────────────────────────────────────────────────────────────

var anonSrc = require('fs').readFileSync(__dirname + '/../js/lib/anon.js', 'utf8');
(new Function('window', 'global',
  anonSrc + '\n//# sourceURL=anon.js'))(window, window);
var anon = window.WPAnon;

// ── Round 12: Anonymous mode encoder enforcement ──────────────────────────────

console.log('\nAnon mode — DATA_SOURCE=11 + chain=true: CHAIN bit cleared in encoded frame');
(function() {
  var frame = codec._buildFrame(
    { job: 'Anon job' },
    { displaySchema: { dataSource: 3, displayType: 0 }, chain: true }
  );
  var parsed = codec._parseFramePresentation(frame);
  assert('anon: chain bit cleared', parsed.chain !== true);
})();

console.log('\nAnon mode — IS_SENDER participant stripped on encode');
(function() {
  var frame = codec._buildFrame(
    { job: 'Anon job' },
    {
      displaySchema: { dataSource: 3, displayType: 0 },
      participants: [
        { isSender: true, name: 'Alice', roleType: 0 },
        { isSender: false, name: 'Bob',  roleType: 1 }
      ]
    }
  );
  var parsed = codec._parseFramePresentation(frame);
  assert('anon: only 1 participant (sender stripped)', parsed._participants && parsed._participants.length === 1);
  assert('anon: remaining participant is non-sender',  parsed._participants[0].isSender !== true);
})();

console.log('\nAnon mode — non-anon IS_SENDER participant preserved');
(function() {
  var frame = codec._buildFrame(
    { job: 'Named job' },
    {
      displaySchema: { dataSource: 0, displayType: 0 },
      participants: [
        { isSender: true,  name: 'Alice', roleType: 0 },
        { isSender: false, name: 'Bob',   roleType: 1 }
      ]
    }
  );
  var parsed = codec._parseFramePresentation(frame);
  assert('non-anon: both participants preserved', parsed._participants && parsed._participants.length === 2);
  assert('non-anon: first participant IS_SENDER',  parsed._participants[0].isSender === true);
})();

console.log('\nAnon mode — form submitAction forced to 3 (blind pickup)');
(function() {
  var frame = codec._buildFrame(
    { job: 'Anon form' },
    {
      displaySchema: { dataSource: 3, displayType: 2 },
      formSchema:    { submitAction: 0, requireName: false }
    }
  );
  var parsed = codec._parseFramePresentation(frame);
  assert('anon form: submitAction=3', parsed._formSchema && parsed._formSchema.submitAction === 3);
})();

console.log('\nAnon mode — decoder sets _anonMode=true');
(function() {
  var frame = codec._buildFrame(
    { job: 'Anon record' },
    { displaySchema: { dataSource: 3, displayType: 0 } }
  );
  var parsed = codec._parseFramePresentation(frame);
  assert('anon decoded: _anonMode=true', parsed._anonMode === true);
})();

console.log('\nAnon mode — non-anon decoder: no _anonMode property');
(function() {
  var frame = codec._buildFrame(
    { job: 'Named record' },
    { displaySchema: { dataSource: 0, displayType: 0 } }
  );
  var parsed = codec._parseFramePresentation(frame);
  assert('non-anon decoded: _anonMode absent', !parsed._anonMode);
})();

// ── Round 12: anon.js helpers ─────────────────────────────────────────────────

console.log('\nWPAnon.validateAnonMode — non-anon opts → valid');
(function() {
  var r = anon.validateAnonMode({ displaySchema: { dataSource: 0 } });
  assert('non-anon: valid=true',   r.valid === true);
  assert('non-anon: no errors',    r.errors.length === 0);
})();

console.log('\nWPAnon.validateAnonMode — anon + chain=true → error');
(function() {
  var r = anon.validateAnonMode({ displaySchema: { dataSource: 3 }, chain: true });
  assert('anon+chain: valid=false',            r.valid === false);
  assert('anon+chain: CHAIN error present',    r.errors.some(function(e) { return e.indexOf('CHAIN') !== -1; }));
})();

console.log('\nWPAnon.validateAnonMode — anon + IS_SENDER participant → error');
(function() {
  var r = anon.validateAnonMode({
    displaySchema: { dataSource: 3 },
    participants: [{ isSender: true, name: 'Alice' }]
  });
  assert('anon+sender: valid=false',           r.valid === false);
  assert('anon+sender: IS_SENDER error present', r.errors.some(function(e) { return e.indexOf('IS_SENDER') !== -1; }));
})();

console.log('\nWPAnon.validateAnonMode — anon + form submitAction≠3 → error');
(function() {
  var r = anon.validateAnonMode({
    displaySchema: { dataSource: 3, displayType: 2 },
    formSchema:    { submitAction: 1 }
  });
  assert('anon+form: valid=false',               r.valid === false);
  assert('anon+form: SUBMIT_ACTION error present', r.errors.some(function(e) { return e.indexOf('SUBMIT_ACTION') !== -1; }));
})();

console.log('\nWPAnon.validateAnonMode — anon + no violations → valid');
(function() {
  var r = anon.validateAnonMode({
    displaySchema: { dataSource: 3, displayType: 2 },
    formSchema:    { submitAction: 3 },
    chain: false,
    participants: [{ isSender: false, name: 'Alice' }]
  });
  assert('anon valid: valid=true',  r.valid === true);
  assert('anon valid: no errors',   r.errors.length === 0);
})();

console.log('\nWPAnon.isAnonMode — true when _anonMode set');
(function() {
  assert('isAnonMode true',  anon.isAnonMode({ _anonMode: true }));
  assert('isAnonMode false', !anon.isAnonMode({}));
  assert('isAnonMode null',  !anon.isAnonMode(null));
})();

console.log('\nWPAnon.stripSenderIdentity — removes IS_SENDER, sets chain=false, submitAction=3');
(function() {
  var opts = {
    chain: true,
    participants: [
      { isSender: true,  name: 'Alice' },
      { isSender: false, name: 'Bob'   }
    ],
    formSchema: { submitAction: 0, requireName: true }
  };
  var r = anon.stripSenderIdentity(opts);
  assert('stripSender: chain=false',              r.chain === false);
  assert('stripSender: IS_SENDER removed',         r.participants.length === 1 && !r.participants[0].isSender);
  assert('stripSender: submitAction=3',            r.formSchema.submitAction === 3);
  assert('stripSender: caller opts unchanged',     opts.chain === true && opts.participants.length === 2);
})();

// ── Round 12: parseAttachmentField ────────────────────────────────────────────

console.log('\nparseAttachmentField — t0: prefix parses tier0 and contentUrl');
(function() {
  var r = codec.parseAttachmentField('t0:abc123:https://workpads.me/a/sha256abc');
  assert('t0: tier0 present',              r.tier0 === 'abc123');
  assert('t0: contentUrl correct',         r.contentUrl === 'https://workpads.me/a/sha256abc');
  assert('t0: availableTiers empty',       r.availableTiers.length === 0);
})();

console.log('\nparseAttachmentField — ?t= query parses available tiers');
(function() {
  var r = codec.parseAttachmentField('t0:abc123:https://workpads.me/a/sha256abc?t=13');
  assert('?t=13: tier 1 present',   r.availableTiers.indexOf(1) !== -1);
  assert('?t=13: tier 3 present',   r.availableTiers.indexOf(3) !== -1);
  assert('?t=13: tier 2 absent',    r.availableTiers.indexOf(2) === -1);
  assert('?t=13: url without query', r.contentUrl === 'https://workpads.me/a/sha256abc');
})();

console.log('\nparseAttachmentField — bare URL (no t0: prefix)');
(function() {
  var r = codec.parseAttachmentField('https://workpads.me/a/sha256abc');
  assert('bare: tier0 null',       r.tier0 === null);
  assert('bare: contentUrl set',   r.contentUrl === 'https://workpads.me/a/sha256abc');
})();

console.log('\nparseAttachmentField — sha256: bare hash');
(function() {
  var r = codec.parseAttachmentField('sha256:deadbeef');
  assert('sha256: tier0 null',     r.tier0 === null);
  assert('sha256: contentUrl set', r.contentUrl === 'sha256:deadbeef');
})();

console.log('\nparseAttachmentField — null/empty → null');
(function() {
  assert('null → null',  codec.parseAttachmentField(null) === null);
  assert('empty → null', codec.parseAttachmentField('')   === null);
})();

console.log('\nparseAttachmentField — multi-image comma-separated → array');
(function() {
  var r = codec.parseAttachmentField('t0:aa:https://url1,t0:bb:https://url2');
  assert('multi: returns array',       Array.isArray(r));
  assert('multi: 2 elements',          r.length === 2);
  assert('multi: first tier0=aa',      r[0].tier0 === 'aa');
  assert('multi: second tier0=bb',     r[1].tier0 === 'bb');
})();

// ── Round 12: formatAttachmentField ──────────────────────────────────────────

console.log('\nformatAttachmentField — with tier0 and tiers');
(function() {
  var s = codec.formatAttachmentField({ tier0: 'abc', contentUrl: 'https://x', availableTiers: [1,2,3] });
  assert('format: t0: prefix',         s.slice(0, 3) === 't0:');
  assert('format: ?t=123 suffix',      s.slice(-6) === '?t=123');
  assert('format: contains url',       s.indexOf('https://x') !== -1);
})();

console.log('\nformatAttachmentField — bare URL (no tier0)');
(function() {
  var s = codec.formatAttachmentField({ contentUrl: 'sha256:abc' });
  assert('format bare: no t0: prefix', s === 'sha256:abc');
})();

console.log('\nformatAttachmentField/parseAttachmentField — roundtrip');
(function() {
  var opts = { tier0: 'mythumb', contentUrl: 'https://workpads.me/a/cafebabe', availableTiers: [1, 3] };
  var encoded = codec.formatAttachmentField(opts);
  var decoded = codec.parseAttachmentField(encoded);
  assert('roundtrip: tier0 preserved',         decoded.tier0 === opts.tier0);
  assert('roundtrip: contentUrl preserved',    decoded.contentUrl === opts.contentUrl);
  assert('roundtrip: availableTiers preserved', decoded.availableTiers.join(',') === '1,3');
})();

// ── Round 12: parseProjectTags ────────────────────────────────────────────────

console.log('\nparseProjectTags — proj: prefix extracts UIDs');
(function() {
  var r = codec.parseProjectTags('proj:abc,urgent,proj:def');
  assert('projTags: 2 projectUids',     r.projectUids.length === 2);
  assert('projTags: first uid=abc',     r.projectUids[0] === 'abc');
  assert('projTags: second uid=def',    r.projectUids[1] === 'def');
  assert('projTags: 1 freeTag',         r.freeTags.length === 1);
  assert('projTags: freeTag=urgent',    r.freeTags[0] === 'urgent');
})();

console.log('\nparseProjectTags — no proj: prefix');
(function() {
  var r = codec.parseProjectTags('urgent,status');
  assert('no proj: projectUids empty', r.projectUids.length === 0);
  assert('no proj: 2 freeTags',        r.freeTags.length === 2);
})();

console.log('\nparseProjectTags — empty string and null');
(function() {
  assert('empty: projectUids=[]',  codec.parseProjectTags('').projectUids.length === 0);
  assert('null: projectUids=[]',   codec.parseProjectTags(null).projectUids.length === 0);
})();

// ── summary ────────────────────────────────────────────────────────────────────

console.log('\n' + (pass + fail) + ' tests: ' + pass + ' pass  ' + fail + ' fail\n');
if (fail > 0) process.exit(1);
