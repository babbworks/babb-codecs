// pads-v1 frame encoder/decoder (Node.js)
// Ported from workpadskaios/js/lib/codec.js
// Spec: workpads-standard/codec.md  Scheme tag: 1pa

'use strict';

// ── UTF-8 helpers (Node.js Buffer) ────────────────────────────────────────────

function toUtf8(str)  { return Buffer.from(String(str), 'utf8'); }
function fromUtf8(b)  { return (Buffer.isBuffer(b) ? b : Buffer.from(b)).toString('utf8'); }

// ── Binary read helpers ───────────────────────────────────────────────────────

function readU16(b, p) { return ((b[p] & 0xff) << 8) | (b[p+1] & 0xff); }
function readU24(b, p) { return ((b[p] & 0xff) << 16) | ((b[p+1] & 0xff) << 8) | (b[p+2] & 0xff); }
function readI16(b, p) { var v = readU16(b, p); return v > 32767 ? v - 65536 : v; }

// ── COMPACT_TIME helpers — epoch 2000-01-01 ───────────────────────────────────

var DATE_EPOCH_MS = Date.UTC(2000, 0, 1);
var MS_PER_DAY   = 86400000;

function dateToDays(iso) {
  try {
    var ms = Date.UTC(+iso.slice(0,4), +iso.slice(5,7)-1, +iso.slice(8,10));
    return Math.max(0, Math.min(65535, Math.round((ms - DATE_EPOCH_MS) / MS_PER_DAY)));
  } catch(e) { return 0; }
}

function daysToDate(days) {
  var d  = new Date(DATE_EPOCH_MS + days * MS_PER_DAY);
  var y  = d.getUTCFullYear();
  var mo = ('0' + (d.getUTCMonth() + 1)).slice(-2);
  var dy = ('0' + d.getUTCDate()).slice(-2);
  return y + '-' + mo + '-' + dy;
}

function timeToMinutes(hhmm) {
  if (!hhmm) return 0;
  var s = String(hhmm), col = s.indexOf(':');
  if (col === -1) return 0;
  return parseInt(s.slice(0, col), 10) * 60 + parseInt(s.slice(col + 1), 10);
}

function minutesToTime(m) {
  var h = Math.floor(m / 60), mn = m % 60;
  return (h < 10 ? '0' : '') + h + ':' + (mn < 10 ? '0' : '') + mn;
}

// ── Financial helpers ─────────────────────────────────────────────────────────

var SF_MULTIPLIERS = [1, 10, 100, 1000, 10000, 100000, 1000000, 1000000000];

function amountToU24(val, dp, sfIdx) {
  if (val == null || val === '') return 0;
  var n = parseFloat(val);
  if (isNaN(n)) return 0;
  if (dp === 7) return Math.min(0xFFFFFF, Math.max(0, Math.round(n)));
  return Math.min(0xFFFFFF, Math.max(0, Math.round(n * Math.pow(10, dp) / (SF_MULTIPLIERS[sfIdx] || 1))));
}

function u24ToAmount(u, dp, sfIdx) {
  var n = u >>> 0;
  if (dp === 7) return String(n);
  var val = (n * (SF_MULTIPLIERS[sfIdx] || 1)) / Math.pow(10, dp);
  return val.toFixed(dp > 6 ? 6 : dp);
}

// ── Field definitions ─────────────────────────────────────────────────────────

var FIELDS = [
  { id: 'job',            bit:  0, type: 'text'    },
  { id: 'customer',       bit:  1, type: 'text'    },
  { id: 'date',           bit:  2, type: 'date'    },
  { id: 'location',       bit:  3, type: 'text'    },
  { id: 'meeting_time',   bit:  4, type: 'time'    },
  { id: 'start_time',     bit:  5, type: 'time'    },
  { id: 'end_time',       bit:  6, type: 'time'    },
  { id: 'customer_phone', bit:  7, type: 'text'    },
  { id: 'worker',         bit:  8, type: 'text'    },
  { id: 'actions',        bit:  9, type: 'text'    }, // array coerced to \n-joined string
  { id: 'details',        bit: 10, type: 'text'    },
  { id: 'story',          bit: 11, type: 'text'    },
  { id: '_financial',     bit: 12, type: 'fin'     },
  { id: 'ref_number',     bit: 13, type: 'compact' },
  { id: 'due_date',       bit: 14, type: 'date'    },
  // bit 15: FLAGS3_PRESENT — no data block
];

var FIELDS3 = [
  { id: 'context_label', bit: 0, type: 'compact' },
  { id: 'tag',           bit: 1, type: 'compact' },
  { id: 'qty_unit',      bit: 2, type: 'compact' },
  { id: 'date_end',      bit: 3, type: 'date'    },
  { id: 'attachment',    bit: 4, type: 'text'    },
  { id: 'uid',           bit: 5, type: 'text'    },
  { id: 'url',           bit: 6, type: 'text'    },
  // bit 7: FLAGS4_PRESENT — no data block
];

var FIELDS4_CONTACT   = [
  { id: 'website',          bit: 0, type: 'text'    },
  { id: 'social_handle',    bit: 1, type: 'compact' },
  { id: 'business_hours',   bit: 2, type: 'text'    },
  { id: 'category',         bit: 3, type: 'u8enum'  },
  { id: 'alt_phone',        bit: 4, type: 'text'    },
  { id: 'meeting_location', bit: 5, type: 'text'    },
];

var FIELDS4_FINANCIAL = [
  { id: 'service_ref', bit: 0, type: 'compact' },
  { id: 'expiry_date', bit: 1, type: 'date'    },
  { id: 'gps_binary',  bit: 2, type: 'gps'     },
];

// ── Frame encoder ─────────────────────────────────────────────────────────────
//
// opts: {
//   compactTime:   boolean  (default true — use uint16 days/minutes for date/time)
//   baseTemplate:  0–6      (default 0 = service record)
//   domain:        0–3      (default 0 = no financial context)
//   ackRequest:    boolean
//   chain:         boolean
//   recipientType: boolean
//   draft:         boolean
//   restrictForward: boolean
//   participants:  array of participant objects
//   hasTrigBlock:  boolean
//   trigBytes:     Uint8Array (max 20 bytes)
//   // Financial opts (domain > 0):
//   decimalPos, currency, currencyCode, taxCode, scalingFactor, compoundValue
//   ioDirection, ioTime, ioEffect, ioSubtype, qtySplit, rounding
//   customerAmount, workerAmount, billed, expenseCat, qtyType
//   accountPair, apDirection, apStatus, apCompleteness
// }

function encodeFrame(record, opts) {
  opts = opts || {};
  var compactTime  = opts.compactTime !== false;
  var baseTemplate = opts.baseTemplate != null ? opts.baseTemplate : 0;
  var domain       = opts.domain || 0;

  var decimalPos = opts.decimalPos   || 0;
  var currency   = opts.currency     || 0;
  var taxCode    = opts.taxCode      || 0;
  var sfPresent  = !!(opts.scalingFactor != null && opts.scalingFactor !== 0);
  var sfIdx      = opts.scalingFactor  || 0;
  var compoundVal = !!(opts.compoundValue);
  var qtyCompact = !!(opts.qtyCompact);
  var qtySplit   = !!(opts.qtySplit);
  var splitPoint = opts.splitPoint   || 0;

  var ioDirection = opts.ioDirection || 0;
  var ioTime      = opts.ioTime      || 0;
  var ioEffect    = opts.ioEffect    || 0;
  var ioSubtype   = opts.ioSubtype   || 0;
  var rounding    = opts.rounding    || 0;
  var accountPair = opts.accountPair || 0;
  var apDirection = opts.apDirection || 0;
  var apStatus    = opts.apStatus    || 0;
  var apCompleteness = opts.apCompleteness || 0;

  var billed      = !!(opts.billed);
  var expenseCat  = opts.expenseCat  || 0;
  var qtyType     = !!(opts.qtyType);

  var hasFinancial = domain > 0 && baseTemplate !== 5;
  var isStateCommit = baseTemplate === 5;
  var scCommitType    = opts.scCommitType   || 0;
  var scPeriodType    = opts.scPeriodType   || 0;
  var scChainComplete = !!(opts.scChainComplete);
  var scDisputeFlag   = !!(opts.scDisputeFlag);
  var scTotalAmount   = opts.scTotalAmount  || 0;
  var scLineCount     = opts.scLineCount    || 0;

  var compoundLines = Array.isArray(opts.compoundLines) ? opts.compoundLines : [];

  var currencyCode = opts.currencyCode || 0;

  var participants = Array.isArray(opts.participants) ? opts.participants : [];
  var hasParticipants = participants.length > 0;

  // ── build flag bytes ─────────────────────────────────────────────────────────

  var fieldFlags = 0, flags3 = 0, fi;

  for (fi = 0; fi < FIELDS.length; fi++) {
    var f = FIELDS[fi];
    if (f.type === 'fin') continue;
    var val = record[f.id];
    if (val == null || val === '')              continue;
    if (Array.isArray(val) && !val.length)     continue;
    fieldFlags |= (1 << f.bit);
  }

  var hasFlags3 = false;
  for (fi = 0; fi < FIELDS3.length; fi++) {
    var f3 = FIELDS3[fi];
    var v3 = record[f3.id];
    if (v3 == null || v3 === '') continue;
    flags3    |= (1 << f3.bit);
    hasFlags3  = true;
  }
  if (hasFlags3) fieldFlags |= (1 << 15);

  var flags4 = 0;
  if (baseTemplate === 3) {
    for (fi = 0; fi < FIELDS4_CONTACT.length; fi++) {
      var f4c = FIELDS4_CONTACT[fi], v4c = record[f4c.id];
      if (v4c != null && v4c !== '') flags4 |= (1 << f4c.bit);
    }
  } else if (baseTemplate === 1 || baseTemplate === 2) {
    for (fi = 0; fi < FIELDS4_FINANCIAL.length; fi++) {
      var f4f = FIELDS4_FINANCIAL[fi], v4f = record[f4f.id];
      if (f4f.type === 'gps' ? v4f != null : (v4f != null && v4f !== '')) flags4 |= (1 << f4f.bit);
    }
  }
  if (flags4) { flags3 |= (1 << 7); hasFlags3 = true; fieldFlags |= (1 << 15); }

  if (hasFinancial || isStateCommit) fieldFlags |= (1 << 12);

  // ── determine meta2 need ─────────────────────────────────────────────────────

  var DATE_TIME_MASK  = (1<<2)|(1<<4)|(1<<5)|(1<<6)|(1<<14);
  var FLAGS3_DATE_MASK = (1<<3);
  var hasDateOrTime   = !!(fieldFlags & DATE_TIME_MASK) || !!(flags3 & FLAGS3_DATE_MASK);
  var hasDisplayCtrl = opts.displayDataSource != null;
  var needMeta2 = (compactTime && hasDateOrTime) || opts.hasTrigBlock || hasDisplayCtrl ||
                  domain > 0 || opts.draft || opts.restrictForward || hasParticipants;

  // ── write ─────────────────────────────────────────────────────────────────────

  var out = [];
  function wb(v)    { out.push(v & 0xff); }
  function wu16(v)  { out.push((v >> 8) & 0xff, v & 0xff); }
  function wu24(v)  { out.push((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff); }
  function wtext(s) {
    var x = toUtf8(s); wu16(x.length);
    for (var i = 0; i < x.length; i++) out.push(x[i]);
  }
  function wcompact(s) {
    var x = toUtf8(s), l = Math.min(x.length, 255);
    wb(l); for (var i = 0; i < l; i++) out.push(x[i]);
  }

  // meta1
  var meta1 = 0;
  if (needMeta2)          meta1 |= 0x80;
  if (opts.extTemplate)   meta1 |= 0x40;
  meta1 |= (opts.extTemplate ? (opts.extTemplate.signal & 0x7) : baseTemplate) << 3;
  if (opts.ackRequest)    meta1 |= 0x04;
  if (opts.chain)         meta1 |= 0x02;
  if (opts.recipientType) meta1 |= 0x01;
  wb(meta1);

  if (opts.extTemplate) {
    var eb = opts.extTemplate.bytes;
    for (var ei = 0; ei < eb.length; ei++) out.push(eb[ei]);
  }

  // meta2
  if (needMeta2) {
    var meta2 = 0;
    if (compactTime)                         meta2 |= 0x40;
    if (opts.hasTrigBlock || hasDisplayCtrl) meta2 |= 0x20;
    if (hasParticipants)       meta2 |= 0x10;
    meta2 |= (domain & 0x3) << 2;
    if (opts.draft)            meta2 |= 0x02;
    if (opts.restrictForward)  meta2 |= 0x01;
    wb(meta2);
  }

  // financial context bytes
  if (hasFinancial || isStateCommit) {
    wb((decimalPos << 5) | (currency << 3) | (taxCode << 1) | (sfPresent ? 1 : 0));
    if (currency === 3) wb(currencyCode);
    if (sfPresent) {
      wb((sfIdx << 5) | (compoundVal ? 0x10 : 0) | (qtyCompact ? 0x08 : 0) | splitPoint);
    }
    if (isStateCommit) {
      wb((scCommitType << 6) | (scPeriodType << 4) | (scChainComplete ? 0x08 : 0) | (scDisputeFlag ? 0x04 : 0));
    } else if (domain === 2) {
      wb((accountPair << 4) | (apDirection << 3) | (apStatus << 2) | (qtySplit ? 0x02 : 0) | (rounding & 0x1));
    } else {
      wb((ioDirection << 7) | (ioTime << 6) | (ioEffect << 5) | (ioSubtype << 3) | (qtySplit ? 0x04 : 0) | (rounding & 0x3));
      if (domain === 3) {
        wb(((accountPair & 0xF) << 4) | ((apDirection & 1) << 3) | ((apStatus & 1) << 2) | ((apCompleteness & 1) << 1));
      }
    }
  }

  // field_flags (2 bytes)
  wu16(fieldFlags);
  if (hasFlags3) wb(flags3);
  if (flags4)    wb(flags4);

  // data blocks: FIELDS in ascending bit order
  for (fi = 0; fi < FIELDS.length; fi++) {
    var f = FIELDS[fi];
    if (!(fieldFlags & (1 << f.bit))) continue;
    if (f.bit === 15) continue;

    if (f.type === 'fin') {
      if (isStateCommit) {
        wu24(amountToU24(scTotalAmount, decimalPos, sfIdx));
        wb(scLineCount);
        continue;
      }
      var hasCustAmt = opts.customerAmount != null && opts.customerAmount !== '';
      var hasWorkAmt = opts.workerAmount  != null && opts.workerAmount  !== '';
      var custBit = hasCustAmt ? 1 : 0, workBit = hasWorkAmt ? 1 : 0, billedBit = billed ? 1 : 0;

      if (domain === 2) {
        wb((billedBit << 7) | 0x40 | ((accountPair & 0xF) << 2) | (custBit << 1) | workBit);
      } else {
        var qtyTypeBit = qtyType ? 1 : 0;
        var ec1 = (expenseCat >> 1) & 1, ec0 = expenseCat & 1;
        var parity = billedBit ^ qtyTypeBit ^ ec1 ^ ec0 ^ custBit ^ workBit;
        wb((billedBit << 7) | (qtyTypeBit << 5) | (parity << 4) | (expenseCat << 2) | (custBit << 1) | workBit);
      }

      if (hasCustAmt) wu24(amountToU24(opts.customerAmount, decimalPos, sfIdx));
      if (hasWorkAmt) wu24(amountToU24(opts.workerAmount,   decimalPos, sfIdx));
      if (taxCode > 0) {
        wb((opts.taxRate   || 0) & 0xFF);
        wu16((opts.taxAmount || 0) & 0xFFFF);
      }
      if (qtySplit && !qtyCompact) {
        wu24(amountToU24(opts.qty  || 0, decimalPos, sfIdx));
        wu24(amountToU24(opts.rate || 0, decimalPos, sfIdx));
      }
      if (compoundVal && compoundLines.length > 0) {
        var cCount = Math.min(31, compoundLines.length);
        var cLFP = false;
        for (var cIdx = 0; cIdx < cCount; cIdx++) {
          var cL = compoundLines[cIdx];
          if ((cL.lineType || 0) || (cL.taxMode || 0)) { cLFP = true; break; }
        }
        wb((cCount << 3) | (cLFP ? 1 : 0));
        wb(((opts.hasTotalSummary ? 1 : 0) << 7) | ((opts.hasSubtotals ? 1 : 0) << 6));
        for (var cIdx2 = 0; cIdx2 < cCount; cIdx2++) {
          var cLine = compoundLines[cIdx2];
          var cType = (cLine.lineType || 0) & 0x3, cTaxM = (cLine.taxMode || 0) & 0x3;
          var cHasQR = cType !== 3 && cLine.qty != null && cLine.rate != null;
          if (cLFP) wb((cType << 6) | (cTaxM << 4) | (cHasQR ? 0x08 : 0));
          wcompact(cLine.name || '');
          wu24(amountToU24(cLine.amount || 0, decimalPos, sfIdx));
          if (cHasQR) {
            wu24(amountToU24(cLine.qty,  decimalPos, sfIdx));
            wu24(amountToU24(cLine.rate, decimalPos, sfIdx));
          }
        }
      }
      continue;
    }

    var v = record[f.id];
    if (f.id === 'actions' && Array.isArray(v)) {
      v = v.map(function(a) { return a.title ? String(a.title) : String(a); }).join('\n');
    }
    var s = String(v);
    if      (f.type === 'text')    { wtext(s); }
    else if (f.type === 'compact') { wcompact(s); }
    else if (f.type === 'date') {
      if (compactTime) wu16(dateToDays(s)); else wtext(s);
    }
    else if (f.type === 'time') {
      if (compactTime) wu16(timeToMinutes(s)); else wtext(s);
    }
  }

  // FIELDS3 data blocks
  if (hasFlags3) {
    for (fi = 0; fi < FIELDS3.length; fi++) {
      var f3d = FIELDS3[fi]; if (!(flags3 & (1 << f3d.bit))) continue;
      var v3d = String(record[f3d.id]);
      if      (f3d.type === 'text')    { wtext(v3d); }
      else if (f3d.type === 'compact') { wcompact(v3d); }
      else if (f3d.type === 'date') {
        if (compactTime) wu16(dateToDays(v3d)); else wtext(v3d);
      }
    }
  }

  // FLAGS4 data blocks
  if (flags4) {
    var f4defs = (baseTemplate === 3) ? FIELDS4_CONTACT : FIELDS4_FINANCIAL;
    for (fi = 0; fi < f4defs.length; fi++) {
      var f4 = f4defs[fi]; if (!(flags4 & (1 << f4.bit))) continue;
      var v4 = record[f4.id];
      if      (f4.type === 'text')    { wtext(String(v4)); }
      else if (f4.type === 'compact') { wcompact(String(v4)); }
      else if (f4.type === 'u8enum')  { wb(v4 & 0xFF); }
      else if (f4.type === 'date')    { wu16(dateToDays(String(v4))); }
      else if (f4.type === 'gps') {
        var lat4 = Math.round(v4.lat * 100); if (lat4 < 0) lat4 += 65536;
        var lon4 = Math.round(v4.lon * 100); if (lon4 < 0) lon4 += 65536;
        wu16(lat4); wu16(lon4);
      }
    }
  }

  // participants block
  if (hasParticipants) {
    var partCount = Math.min(7, participants.length);
    wb((partCount << 5) & 0xFF);
    for (var pti = 0; pti < partCount; pti++) {
      var p = participants[pti];
      var pRoleType = (p.roleType || 0) & 0x3;
      var pHasPhone = !!(p.phone && p.phone !== '');
      var pHasEmail = !!(p.email && p.email !== '');
      var pHasAltId = !!(p.altId);
      var pBit1 = (pRoleType === 3)
        ? !!(p.roleText && p.roleText !== '')
        : !!(p.tradingName && p.tradingName !== '');
      var pf = 0;
      if (p.isSender)  pf |= 0x80;
      pf |= (pRoleType << 5);
      if (pHasAltId)   pf |= 0x10;
      if (pHasPhone)   pf |= 0x08;
      if (pHasEmail)   pf |= 0x04;
      if (pBit1)       pf |= 0x02;
      if (p.isOrg)     pf |= 0x01;
      wb(pf);
      wtext(p.name || '');
      if (pRoleType !== 3 && pBit1) wtext(p.tradingName);
      if (pHasPhone) wtext(p.phone);
      if (pHasEmail) wtext(p.email);
      if (pRoleType === 3) {
        if (pBit1) {
          wtext(p.roleText);
        } else {
          var rcSlot = (p.roleSlot    || 0) & 0x1F;
          var rcSig  = (p.roleSignals || 0) & 0x7;
          wb((rcSlot << 3) | rcSig);
          if (rcSlot === 31) wb((p.roleCode2 || 0) & 0xFF);
        }
      }
      if (pHasAltId) {
        wb((p.altId.type || 0x01) & 0xFF);
        wcompact(p.altId.value || '');
      }
    }
  }

  // TRIG / display_schema block
  // Optional DISPLAY_CONTROL prefix byte carries DATA_SOURCE (bits 5-4)
  if (opts.hasTrigBlock || hasDisplayCtrl) {
    var tb  = opts.trigBytes || [];
    var tbl = Math.min(tb.length, 20);
    var dc  = hasDisplayCtrl ? ((opts.displayDataSource & 0x3) << 4) : -1;
    wb(tbl + (dc >= 0 ? 1 : 0));
    if (dc >= 0) wb(dc);
    for (var tbi = 0; tbi < tbl; tbi++) out.push(tb[tbi]);
  }

  return new Uint8Array(out);
}

// ── Frame decoder ─────────────────────────────────────────────────────────────

function decodeFrame(bytes) {
  if (bytes.length < 3) throw new Error('@workpads/codec: frame too short');
  var pos = 0, record = {};

  // meta1
  var meta1        = bytes[pos++];
  var meta2Present = !!(meta1 & 0x80);
  var extTemplate  = !!(meta1 & 0x40);
  var baseOrSig    = (meta1 >> 3) & 0x07;
  var ackRequest   = !!(meta1 & 0x04);
  var chain        = !!(meta1 & 0x02);
  var recipType    = !!(meta1 & 0x01);

  record._meta = {
    baseTemplate:  extTemplate ? null : baseOrSig,
    extSignal:     extTemplate ? baseOrSig : null,
    ackRequest:    ackRequest,
    chain:         chain,
    recipientType: recipType
  };

  if (extTemplate) {
    if      (baseOrSig === 1) { record._extTemplateId = bytes[pos++]; }
    else if (baseOrSig === 2) { record._extTemplateId = readU16(bytes, pos); pos += 2; }
    else if (baseOrSig === 3) { record._extTemplateId = readU24(bytes, pos); pos += 3; }
    else if (baseOrSig === 4) { record._extTemplateId = { ns: bytes[pos], id: readU16(bytes, pos+1) }; pos += 3; }
  }

  var compactTime = false, domain = 0;
  if (meta2Present) {
    var meta2    = bytes[pos++];
    compactTime  = !!(meta2 & 0x40);
    domain       = (meta2 >> 2) & 0x03;
    record._meta.compactTime     = compactTime;
    record._meta.domain          = domain;
    record._meta.hasTrigBlock    = !!(meta2 & 0x20);
    record._meta.hasParticipants = !!(meta2 & 0x10);
    record._meta.draft           = !!(meta2 & 0x02);
    record._meta.restrictForward = !!(meta2 & 0x01);
  }

  var isStateCommit = (!extTemplate && baseOrSig === 5);
  var isAmendment   = (!extTemplate && baseOrSig === 6);

  if (isAmendment) return decodeAmendmentFrame(bytes, pos, record, compactTime);

  var finDp = 0, finTax = 0, finSf = 0, finQtyC = false, finQtyS = false, finSp = 0, finCmpd = false;

  if (domain > 0 || isStateCommit) {
    if (pos >= bytes.length) throw new Error('@workpads/codec: truncated at setup_byte');
    var sb   = bytes[pos++];
    finDp    = (sb >> 5) & 0x7;
    var finCur = (sb >> 3) & 0x3;
    finTax   = (sb >> 1) & 0x3;
    var finSfP = !!(sb & 0x1);
    var finCC = 0;
    if (finCur === 3) { if (pos >= bytes.length) throw new Error('@workpads/codec: truncated at currency_ext'); finCC = bytes[pos++]; }
    if (finSfP) {
      if (pos >= bytes.length) throw new Error('@workpads/codec: truncated at sf_byte');
      var sfb = bytes[pos++];
      finSf   = (sfb >> 5) & 0x7;
      finCmpd = !!(sfb & 0x10);
      finQtyC = !!(sfb & 0x08);
      finSp   =   sfb      & 0x7;
    }

    if (isStateCommit) {
      if (pos >= bytes.length) throw new Error('@workpads/codec: truncated at state_commit_byte');
      var scb = bytes[pos++];
      record._stateCommit = { commitType: (scb >> 6) & 0x3, periodType: (scb >> 4) & 0x3,
                              chainComplete: !!(scb & 0x08), disputeFlag: !!(scb & 0x04) };
      record._fin = { decimalPos: finDp, currency: finCur, currencyCode: finCC, taxCode: finTax };
    } else {
      if (pos >= bytes.length) throw new Error('@workpads/codec: truncated at transaction_byte');
      var txb = bytes[pos++];
      if (domain === 2) {
        finQtyS = !!(txb & 0x02);
        record._fin = { decimalPos: finDp, currency: finCur, currencyCode: finCC, taxCode: finTax,
                        sfPresent: finSfP, scalingFactor: finSf, compoundValue: finCmpd,
                        accountPair: (txb >> 4) & 0xF, apDirection: (txb >> 3) & 1,
                        apStatus: (txb >> 2) & 1, qtySplit: finQtyS, rounding: txb & 1 };
      } else {
        finQtyS = !!(txb & 0x04);
        record._fin = { decimalPos: finDp, currency: finCur, currencyCode: finCC, taxCode: finTax,
                        sfPresent: finSfP, scalingFactor: finSf, compoundValue: finCmpd,
                        direction: (txb >> 7) & 1, time: (txb >> 6) & 1, effect: (txb >> 5) & 1,
                        subtype: (txb >> 3) & 3, qtySplit: finQtyS, rounding: txb & 3 };
        if (domain === 3) {
          if (pos >= bytes.length) throw new Error('@workpads/codec: truncated at account_pair_byte');
          var apb = bytes[pos++];
          record._ap = { accountPair: (apb >> 4) & 0xF, apDirection: (apb >> 3) & 1,
                         apStatus: (apb >> 2) & 1, apCompleteness: (apb >> 1) & 1, apExtension: apb & 1 };
          if ((apb & 1) && pos < bytes.length) pos++;
        }
      }
    }
  }

  if (pos + 2 > bytes.length) throw new Error('@workpads/codec: truncated at field_flags');
  var fieldFlags = readU16(bytes, pos); pos += 2;
  var flags3 = 0;
  if (fieldFlags & (1 << 15)) { if (pos >= bytes.length) throw new Error('@workpads/codec: truncated at flags3'); flags3 = bytes[pos++]; }
  var flags4d = 0;
  if (flags3 & (1 << 7)) {
    if (pos >= bytes.length) throw new Error('@workpads/codec: truncated at flags4');
    flags4d = bytes[pos++];
    if (flags4d & (1 << 7)) { if (pos >= bytes.length) throw new Error('@workpads/codec: truncated at flags5'); pos++; }
  }

  function rtext()   { var len = readU16(bytes, pos); pos += 2; var s = fromUtf8(bytes.subarray(pos, pos + len)); pos += len; return s; }
  function rcompact(){ var len = bytes[pos++]; var s = fromUtf8(bytes.subarray(pos, pos + len)); pos += len; return s; }

  var fi;
  for (fi = 0; fi < FIELDS.length; fi++) {
    var f = FIELDS[fi];
    if (!(fieldFlags & (1 << f.bit))) continue;
    if (f.bit === 15) continue;

    if (f.type === 'fin') {
      if (isStateCommit) {
        record.sc_total_amount = u24ToAmount(readU24(bytes, pos), finDp, finSf); pos += 3;
        record.sc_line_count   = bytes[pos++];
        continue;
      }
      if (pos >= bytes.length) throw new Error('@workpads/codec: truncated at fin_control');
      var fc = bytes[pos++];
      var fcBit6 = (fc >> 6) & 1, fcBld = (fc >> 7) & 1, fcCust = (fc >> 1) & 1, fcWork = fc & 1;
      if (domain === 2) {
        if (!fcBit6) throw new Error('@workpads/codec: fin_control mode bit error');
        record.billed = !!fcBld; record.account_pair = (fc >> 2) & 0xF;
      } else {
        if (fcBit6) throw new Error('@workpads/codec: fin_control mode bit error');
        var fcQtyT = (fc >> 5) & 1, fcPar = (fc >> 4) & 1, fcEc = (fc >> 2) & 3;
        if (fcEc === 3) throw new Error('@workpads/codec: fin_control EXPENSE_CAT=11 reserved');
        var fcPexp = fcBld ^ fcQtyT ^ ((fcEc >> 1) & 1) ^ (fcEc & 1) ^ fcCust ^ fcWork;
        if (fcPar !== fcPexp) throw new Error('@workpads/codec: fin_control parity error');
        record.billed = !!fcBld; record.qty_type = fcQtyT; record.expense_cat = fcEc;
      }
      if (fcCust) {
        if (finQtyC && finQtyS) {
          var sp = finSp === 0 ? 8 : finSp;
          var cuRaw = readU24(bytes, pos); pos += 3;
          var qtyU = cuRaw & ((1 << sp) - 1), rateU = cuRaw >> sp;
          var sfMul = SF_MULTIPLIERS[finSf] || 1, dp = finDp > 6 ? 6 : finDp;
          record.qty  = String(qtyU);
          record.rate = u24ToAmount(rateU, finDp, finSf);
          record.customer_amount = ((rateU * qtyU * sfMul) / Math.pow(10, dp)).toFixed(dp);
        } else {
          record.customer_amount = u24ToAmount(readU24(bytes, pos), finDp, finSf); pos += 3;
        }
      }
      if (fcWork) { record.worker_amount = u24ToAmount(readU24(bytes, pos), finDp, finSf); pos += 3; }
      if (finTax > 0) {
        if (pos + 3 > bytes.length) throw new Error('@workpads/codec: truncated at tax_block');
        record.tax_rate = bytes[pos++]; record.tax_amount = u24ToAmount(readU16(bytes, pos), finDp, finSf); pos += 2;
      }
      if (finQtyS && !finQtyC) {
        if (pos + 6 > bytes.length) throw new Error('@workpads/codec: truncated at qty_rate_block');
        record.qty  = u24ToAmount(readU24(bytes, pos), finDp, finSf); pos += 3;
        record.rate = u24ToAmount(readU24(bytes, pos), finDp, finSf); pos += 3;
      }
      if (finCmpd) {
        var chdr1 = bytes[pos++], chdr2 = bytes[pos++];
        var cLineCount = (chdr1 >> 3) & 0x1F, cLFP = !!(chdr1 & 0x01);
        var cLines = [];
        for (var dcIdx = 0; dcIdx < cLineCount; dcIdx++) {
          var dType = 0, dTaxM = 0, dHasQR = false;
          if (cLFP) { var clf = bytes[pos++]; dType = (clf >> 6) & 0x3; dTaxM = (clf >> 4) & 0x3; dHasQR = !!(clf & 0x08) && dType !== 3; }
          var dName = rcompact(), dAmt = u24ToAmount(readU24(bytes, pos), finDp, finSf); pos += 3;
          var dcLine = { name: dName, amount: dAmt, lineType: dType, taxMode: dTaxM };
          if (dHasQR) {
            dcLine.qty  = u24ToAmount(readU24(bytes, pos), finDp, finSf); pos += 3;
            dcLine.rate = u24ToAmount(readU24(bytes, pos), finDp, finSf); pos += 3;
          }
          cLines.push(dcLine);
        }
        record._compound = { lines: cLines, hasTotalSummary: !!(chdr2 & 0x80), hasSubtotals: !!(chdr2 & 0x40) };
      }
      continue;
    }

    if      (f.type === 'text')    { record[f.id] = rtext(); }
    else if (f.type === 'compact') { record[f.id] = rcompact(); }
    else if (f.type === 'date') {
      if (compactTime) { record[f.id] = daysToDate(readU16(bytes, pos)); pos += 2; } else { record[f.id] = rtext(); }
    }
    else if (f.type === 'time') {
      if (compactTime) { record[f.id] = minutesToTime(readU16(bytes, pos)); pos += 2; } else { record[f.id] = rtext(); }
    }
  }

  for (var f3i = 0; f3i < FIELDS3.length; f3i++) {
    var f3 = FIELDS3[f3i]; if (!(flags3 & (1 << f3.bit))) continue;
    if      (f3.type === 'text')    { record[f3.id] = rtext(); }
    else if (f3.type === 'compact') { record[f3.id] = rcompact(); }
    else if (f3.type === 'date') {
      if (compactTime) { record[f3.id] = daysToDate(readU16(bytes, pos)); pos += 2; } else { record[f3.id] = rtext(); }
    }
  }

  if (flags4d) {
    var btd = record._meta.baseTemplate;
    var f4def = (btd === 3) ? FIELDS4_CONTACT : (btd === 1 || btd === 2) ? FIELDS4_FINANCIAL : null;
    if (f4def) {
      for (var f4i = 0; f4i < f4def.length; f4i++) {
        var f4d = f4def[f4i]; if (!(flags4d & (1 << f4d.bit))) continue;
        if      (f4d.type === 'text')    { record[f4d.id] = rtext(); }
        else if (f4d.type === 'compact') { record[f4d.id] = rcompact(); }
        else if (f4d.type === 'u8enum')  { record[f4d.id] = bytes[pos++]; }
        else if (f4d.type === 'date')    { record[f4d.id] = daysToDate(readU16(bytes, pos)); pos += 2; }
        else if (f4d.type === 'gps')     {
          record.gps_binary = { lat: readI16(bytes, pos) / 100, lon: readI16(bytes, pos + 2) / 100 }; pos += 4;
        }
      }
    }
  }

  if (record._meta.hasParticipants && pos < bytes.length) {
    var bh = bytes[pos++], pCount = (bh >> 5) & 0x7;
    var ptArr = [];
    for (var pti = 0; pti < pCount && pos < bytes.length; pti++) {
      var pf2 = bytes[pos++];
      var part = { isSender: !!(pf2 & 0x80), roleType: (pf2 >> 5) & 0x3, isOrg: !!(pf2 & 0x01), name: rtext() };
      if (part.roleType !== 3 && (pf2 & 0x02)) part.tradingName = rtext();
      if (pf2 & 0x08) part.phone = rtext();
      if (pf2 & 0x04) part.email = rtext();
      if (part.roleType === 3) {
        if (pf2 & 0x02) {
          part.roleText = rtext();
        } else {
          var rc = bytes[pos++]; part.roleSlot = (rc >> 3) & 0x1F; part.roleSignals = rc & 0x7;
          if (part.roleSlot === 31) part.roleCode2 = bytes[pos++];
        }
      }
      if (pf2 & 0x10) { var aidType = bytes[pos++]; part.altId = { type: aidType, value: rcompact() }; }
      ptArr.push(part);
    }
    record._participants = ptArr;
  }

  if (record._meta.hasTrigBlock && pos < bytes.length) {
    var tLen = bytes[pos++];
    if (tLen <= 32) {
      var trigRaw = bytes.subarray(pos, pos + tLen);
      record._trig = { bytes: trigRaw };
      // If first byte has DATA_SOURCE bits (bits 5-4) set and no valid TRIG header, it's a display control byte
      if (tLen >= 1) {
        var possibleDc = trigRaw[0];
        var dataSource = (possibleDc >> 4) & 0x3;
        // DISPLAY_CONTROL byte: bits 7-6 = 00 (VER), bit 5-4 = DATA_SOURCE, bits 3-0 = 0 (no TRIG prog)
        if ((possibleDc & 0xCF) === 0) record._meta.displayDataSource = dataSource;
      }
    } else {
      record._trig = { trig_violation: true };
    }
    pos += tLen;
  }

  return record;
}

// ── Amendment frame decoder ───────────────────────────────────────────────────

function decodeAmendmentFrame(bytes, pos, record, compactTime) {
  if (pos + 2 > bytes.length) throw new Error('@workpads/codec: truncated at amendment_header');
  var changedMask  = readU16(bytes, pos); pos += 2;
  var hasCM3       = !!(changedMask & 0x8000);
  var hasAFBit     = !!(changedMask & 0x4000);
  var changedMask3 = 0, disputeLink = false, parentUidArr = null;

  if (hasCM3) {
    changedMask3 = bytes[pos++];
  } else if (hasAFBit) {
    var af = bytes[pos++];
    disputeLink = !!(af & 0x40);
    if (af & 0x80) { parentUidArr = Array.from(bytes.subarray(pos, pos + 8)); pos += 8; }
  }

  record._amendment = { changedMask: changedMask & ~0xC000, changedMask3: changedMask3, disputeLink: disputeLink };
  if (parentUidArr) record._amendment.parentUid = parentUidArr;

  function rtext()   { var len = readU16(bytes, pos); pos += 2; var s = fromUtf8(bytes.subarray(pos, pos + len)); pos += len; return s; }
  function rcompact(){ var len = bytes[pos++]; var s = fromUtf8(bytes.subarray(pos, pos + len)); pos += len; return s; }

  for (var fi = 0; fi < FIELDS.length; fi++) {
    var f = FIELDS[fi]; if (!(changedMask & (1 << f.bit))) continue;
    if (f.bit === 15 || f.type === 'fin') continue;
    if      (f.type === 'text')    { record[f.id] = rtext(); }
    else if (f.type === 'compact') { record[f.id] = rcompact(); }
    else if (f.type === 'date') {
      if (compactTime) { record[f.id] = daysToDate(readU16(bytes, pos)); pos += 2; } else { record[f.id] = rtext(); }
    }
    else if (f.type === 'time') {
      if (compactTime) { record[f.id] = minutesToTime(readU16(bytes, pos)); pos += 2; } else { record[f.id] = rtext(); }
    }
  }

  if (hasCM3) {
    for (var f3i = 0; f3i < FIELDS3.length; f3i++) {
      var f3 = FIELDS3[f3i]; if (!(changedMask3 & (1 << f3.bit))) continue;
      if      (f3.type === 'text')    { record[f3.id] = rtext(); }
      else if (f3.type === 'compact') { record[f3.id] = rcompact(); }
      else if (f3.type === 'date') {
        if (compactTime) { record[f3.id] = daysToDate(readU16(bytes, pos)); pos += 2; } else { record[f3.id] = rtext(); }
      }
    }
  }

  return record;
}

// ── Validation ────────────────────────────────────────────────────────────────

function validate(record) {
  var errors = [];
  if (!record || typeof record !== 'object') return { valid: false, errors: ['record must be an object'] };
  if (!record.job || typeof record.job !== 'string' || !record.job.trim()) errors.push('job is required');
  var SCALAR_IDS = ['job','customer','date','location','meeting_time','start_time','end_time','customer_phone','worker','details','story'];
  SCALAR_IDS.forEach(function(id) {
    if (record[id] != null && typeof record[id] !== 'string') errors.push(id + ' must be a string');
  });
  if (record.actions != null) {
    if (!Array.isArray(record.actions)) {
      errors.push('actions must be an array');
    } else {
      record.actions.forEach(function(a, i) {
        if (!a || typeof a !== 'object') errors.push('actions[' + i + '] must be an object');
        else if (!a.title || typeof a.title !== 'string' || !a.title.trim()) errors.push('actions[' + i + '].title is required');
      });
    }
  }
  return { valid: errors.length === 0, errors: errors };
}

module.exports = { encodeFrame: encodeFrame, decodeFrame: decodeFrame, validate: validate };
