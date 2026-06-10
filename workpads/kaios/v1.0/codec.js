// WPCodec — workpadskaios codec
// Encode target: pads-v1 (#1pa/) — FRAME-SPEC v1.0
// Decode: #1pa/ + legacy #1eg/ #1cg/ #1dg/ #1ag/ #1bg/ alg=bitpad-v1
//
// Frame layout (#1pa/):
//   [meta1][ext_template?][meta2?]
//   [setup_byte?...(Round 2+)][field_flags 2B][field_flags3?][field_flags4?]
//   [data blocks in ascending bit order][financial block? (Round 2)]
//   [participants? (Round 4)][TRIG block? (Round 9)]
//
// Depends on: fflate UMD (window.fflate must be present before this file).
// Exposes: window.WPCodec = { encode, decode, validate }

(function(global) {
  'use strict';

  var URL_PREFIX = 'workpads.me/p#';
  var CODEBOOK   = '1pa';
  var CODEBOOK_V2 = '1pv';

  // ── base64url ──────────────────────────────────────────────────────────────────

  function toBase64Url(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  function fromBase64Url(str) {
    var padded = str + '=='.slice(0, (4 - str.length % 4) % 4);
    var bin    = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    var out    = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ── UTF-8 helpers ──────────────────────────────────────────────────────────────

  function toUtf8(str)   { return new TextEncoder().encode(str); }
  function fromUtf8(buf) { return new TextDecoder().decode(buf); }

  // ── Binary read helpers ────────────────────────────────────────────────────────

  function readU16(buf, pos) {
    return ((buf[pos] & 0xff) << 8) | (buf[pos + 1] & 0xff);
  }

  function readU24(buf, pos) {
    return ((buf[pos] & 0xff) << 16) | ((buf[pos + 1] & 0xff) << 8) | (buf[pos + 2] & 0xff);
  }

  function readI16(buf, pos) {
    var v = readU16(buf, pos);
    return v > 32767 ? v - 65536 : v;
  }

  function readU32(buf, pos) {
    return ((buf[pos] & 0xff) * 0x1000000) +
           ((buf[pos + 1] & 0xff) << 16)  +
           ((buf[pos + 2] & 0xff) << 8)   +
            (buf[pos + 3] & 0xff);
  }

  // writeU16/writeU24/writeU32 kept for legacy decoders and Round 2+
  function writeU16(buf, off, v) { buf[off] = (v >> 8) & 0xff; buf[off+1] = v & 0xff; }
  function writeU32(buf, off, v) {
    buf[off]   = (v >>> 24) & 0xff; buf[off+1] = (v >>> 16) & 0xff;
    buf[off+2] = (v >>> 8)  & 0xff; buf[off+3] =  v         & 0xff;
  }

  // ── COMPACT_TIME helpers — epoch 2000-01-01 (FRAME-SPEC OQ-2) ─────────────────

  var DATE_EPOCH_MS  = Date.UTC(2000, 0, 1);
  var MS_PER_DAY     = 86400000;

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
    var s   = String(hhmm);
    var col = s.indexOf(':');
    if (col === -1) return 0;
    return parseInt(s.slice(0, col), 10) * 60 + parseInt(s.slice(col + 1), 10);
  }

  function minutesToTime(mins) {
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  // Legacy epoch: 1eg/ dates used 2020-01-01
  var LEGACY_DATE_EPOCH_MS = Date.UTC(2020, 0, 1);

  // ── Financial helpers ──────────────────────────────────────────────────────────

  var SF_MULTIPLIERS = [1, 10, 100, 1000, 10000, 100000, 1000000, 1000000000];

  function amountToU24(val, dp, sfIdx) {
    if (val == null || val === '') return 0;
    var n = parseFloat(val);
    if (isNaN(n)) return 0;
    if (dp === 7) return Math.min(0xFFFFFF, Math.max(0, Math.round(n)));
    var sf = SF_MULTIPLIERS[sfIdx] || 1;
    return Math.min(0xFFFFFF, Math.max(0, Math.round(n * Math.pow(10, dp) / sf)));
  }

  function u24ToAmount(u, dp, sfIdx) {
    var n = u >>> 0;
    if (dp === 7) return String(n);
    var sf   = SF_MULTIPLIERS[sfIdx] || 1;
    var val  = (n * sf) / Math.pow(10, dp);
    var digs = dp > 6 ? 6 : dp;
    return val.toFixed(digs);
  }

  function legacyU16ToDate(days) {
    var d  = new Date(LEGACY_DATE_EPOCH_MS + days * MS_PER_DAY);
    var y  = d.getUTCFullYear();
    var mo = ('0' + (d.getUTCMonth() + 1)).slice(-2);
    var dy = ('0' + d.getUTCDate()).slice(-2);
    return y + '-' + mo + '-' + dy;
  }

  // ── Field definitions ──────────────────────────────────────────────────────────
  // type: 'text'    = [uint16 BE len][UTF-8]
  //       'compact' = [uint8 len][UTF-8]   (max 255 B)
  //       'date'    = uint16 days (COMPACT_TIME=1) or 'text' (COMPACT_TIME=0)
  //       'time'    = uint16 minutes (COMPACT_TIME=1) or 'text' (COMPACT_TIME=0)
  //       'fin'     = financial block trigger — Round 2 (bit 12)

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
    { id: 'actions',        bit:  9, type: 'text'    }, // plain text in pads-v1; array coerced on encode
    { id: 'details',        bit: 10, type: 'text'    },
    { id: 'story',          bit: 11, type: 'text'    },
    { id: '_financial',     bit: 12, type: 'fin'     }, // Round 2
    { id: 'ref_number',     bit: 13, type: 'compact' },
    { id: 'due_date',       bit: 14, type: 'date'    },
    // bit 15: FLAGS3_PRESENT — meta-flag, no data block
  ];

  var FIELDS3 = [
    { id: 'context_label', bit: 0, type: 'compact' },
    { id: 'tag',           bit: 1, type: 'compact' },
    { id: 'qty_unit',      bit: 2, type: 'compact' },
    { id: 'date_end',      bit: 3, type: 'date'    },
    { id: 'attachment',    bit: 4, type: 'text'    },
    { id: 'uid',           bit: 5, type: 'text'    },
    { id: 'url',           bit: 6, type: 'text'    },
    // bit 7: FLAGS4_PRESENT — meta-flag, no data block
  ];

  // FLAGS4: Contact template (BASE_TEMPLATE=011)
  var FIELDS4_CONTACT = [
    { id: 'website',          bit: 0, type: 'text'    },
    { id: 'social_handle',    bit: 1, type: 'compact' },
    { id: 'business_hours',   bit: 2, type: 'text'    },
    { id: 'category',         bit: 3, type: 'u8enum'  },
    { id: 'alt_phone',        bit: 4, type: 'text'    },
    { id: 'meeting_location', bit: 5, type: 'text'    },
  ];

  // FLAGS4: Financial template (BASE_TEMPLATE=001 or 010)
  var FIELDS4_FINANCIAL = [
    { id: 'service_ref', bit: 0, type: 'compact' },
    { id: 'expiry_date', bit: 1, type: 'date'    },
    { id: 'gps_binary',  bit: 2, type: 'gps'     },
  ];

  // ── Amendment frame encoder (BASE_TEMPLATE=110) ───────────────────────────────

  function buildAmendmentFrame(record, opts) {
    opts = opts || {};
    var compactTime = opts.compactTime !== false;
    var out = [];
    function wb(v)    { out.push(v & 0xff); }
    function wu16(v)  { out.push((v >> 8) & 0xff, v & 0xff); }
    function wtext(s) {
      var x = toUtf8(String(s)); wu16(x.length);
      for (var i = 0; i < x.length; i++) out.push(x[i]);
    }
    function wcompact(s) {
      var x = toUtf8(String(s)); var l = Math.min(x.length, 255);
      wb(l); for (var i = 0; i < l; i++) out.push(x[i]);
    }

    // Build changed masks from record content
    var changedMask  = 0;   // uint16 (mirrors field_flags bit layout)
    var changedMask3 = 0;   // uint8 (mirrors field_flags3 bit layout)
    var fi;
    for (fi = 0; fi < FIELDS.length; fi++) {
      var f = FIELDS[fi]; if (f.type === 'fin') continue;
      var val = record[f.id];
      if (val != null && val !== '') changedMask |= (1 << f.bit);
    }
    for (fi = 0; fi < FIELDS3.length; fi++) {
      var f3 = FIELDS3[fi];
      var val3 = record[f3.id];
      if (val3 != null && val3 !== '') changedMask3 |= (1 << f3.bit);
    }
    var hasCM3 = changedMask3 !== 0;
    if (hasCM3) changedMask |= 0x8000;  // CHANGED_MASK_3_PRESENT in bit 15

    // amendment_flags: present when CHANGED_MASK_3_PRESENT=0 AND bit 14 set
    var parentUid   = opts.parentUid;      // Uint8Array(8) or null/undefined
    var disputeLink = !!(opts.disputeLink);
    var hasAmendFlags = !hasCM3 && !!(parentUid || disputeLink);
    if (hasAmendFlags) changedMask |= 0x4000;  // set bit 14 to signal amendment_flags presence

    // meta1
    var needMeta2 = opts.hasTrigBlock || opts.draft || opts.restrictForward ||
                    !!(opts.participants && opts.participants.length > 0);
    var meta1 = 0;
    if (needMeta2)         meta1 |= 0x80;
    meta1 |= (6 << 3);   // BASE_TEMPLATE=110
    if (opts.ackRequest)   meta1 |= 0x04;
    if (opts.chain)        meta1 |= 0x02;
    if (opts.recipientType) meta1 |= 0x01;
    wb(meta1);

    if (needMeta2) {
      var m2 = 0;
      if (opts.hasTrigBlock)    m2 |= 0x20;
      if (opts.draft)           m2 |= 0x02;
      if (opts.restrictForward) m2 |= 0x01;
      wb(m2);
    }

    // amendment_header (2 bytes)
    wu16(changedMask);

    // changed_mask_3 or amendment_flags
    if (hasCM3) {
      wb(changedMask3);
    } else if (hasAmendFlags) {
      var af = 0;
      if (parentUid)   af |= 0x80;
      if (disputeLink) af |= 0x40;
      wb(af);
      if (parentUid) {
        for (var pi = 0; pi < 8 && pi < parentUid.length; pi++) wb(parentUid[pi]);
      }
    }

    // Changed FIELDS in ascending bit order
    for (fi = 0; fi < FIELDS.length; fi++) {
      var f = FIELDS[fi];
      if (!(changedMask & (1 << f.bit))) continue;
      if (f.bit === 15) continue;
      if (f.type === 'fin') continue; // financial amendment deferred (Round 6+)
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

    // Changed FIELDS3 in ascending bit order
    if (hasCM3) {
      for (fi = 0; fi < FIELDS3.length; fi++) {
        var f3 = FIELDS3[fi];
        if (!(changedMask3 & (1 << f3.bit))) continue;
        var v3 = String(record[f3.id]);
        if      (f3.type === 'text')    { wtext(v3); }
        else if (f3.type === 'compact') { wcompact(v3); }
        else if (f3.type === 'date') {
          if (compactTime) wu16(dateToDays(v3)); else wtext(v3);
        }
      }
    }

    return new Uint8Array(out);
  }

  // ── pads-v1 frame encoder ──────────────────────────────────────────────────────
  // opts: {
  //   baseTemplate:   0-7  (default 0=Service; auto-set to 1=Financial when domain>0)
  //   extTemplate:    { signal: 1-4, bytes: Uint8Array } | null
  //   ackRequest, chain, recipientType, compactTime (default true), hasTrigBlock,
  //   domain: 0-3 (0=none, 1=simple I>O, 2=standard BitLedger, 3=hybrid)
  //   draft, restrictForward
  //
  //   Financial context (when domain>0):
  //   decimalPos:     0-7  (default 0; 2=pence/cents)
  //   currency:       0-3  (0=home, 3=extended → currencyCode)
  //   currencyCode:   0-254
  //   taxCode:        0-3  (0=none, 1=inclusive, 2=exclusive, 3=compound)
  //   sfPresent:      bool
  //   scalingFactor:  0-7  SF index (0=×1 … 7=×1B)
  //   compoundValue:  bool
  //   qtyCompact:     bool  (1=pack qty+rate into customer_amount uint24)
  //   splitPoint:     0-7  (qty bits when qtyCompact=true; 0=default 8 bits)
  //   direction:      0/1  (0=I/income, 1=O/outgoing)
  //   ioTime:         0/1  (0=past/settled, 1=future/pending)
  //   effect:         0/1  (0=I/net positive, 1=O/net negative)
  //   subtype:        0-3
  //   qtySplit:       bool  (1=qty+rate fields active)
  //   rounding:       0,2,3 (0=exact; 01 invalid — never set)
  //
  //   Financial block data (when domain>0):
  //   billed:         bool  (auto-forced true when expenseCat=0 and direction=O)
  //   qtyType:        0/1  (0=units, 1=time/hours)
  //   expenseCat:     0-2  (0=job charge, 1=COGS, 2=running cost)
  //   customerAmount: string|number  (monetary total; or omit when qtyCompact=true)
  //   workerAmount:   string|number  (internal cost; optional)
  //   qty:            string|number  (count; used when qtySplit=true)
  //   rate:           string|number  (rate per unit; used when qtySplit=true)
  //   taxRate:        0-255  (permille, e.g. 200=20.0%)
  //   taxAmount:      uint16 (scaled tax total)
  // }

  function buildFrame(record, opts) {
    opts = opts || {};
    var anonMode     = opts.displaySchema && ((opts.displaySchema.dataSource || 0) & 0x3) === 3;
    var compactTime  = opts.compactTime !== false;
    var baseTemplate = (opts.baseTemplate || 0) & 0x7;
    var domain       = (opts.domain       || 0) & 0x3;

    // Amendment (BASE_TEMPLATE=110): entirely different layout — dispatch early
    if (baseTemplate === 6) return buildAmendmentFrame(record, opts);

    var isStateCommit = (baseTemplate === 5);
    var hasFinancial  = domain > 0;
    if (hasFinancial && baseTemplate === 0) baseTemplate = 1;

    // financial context opts (used when hasFinancial)
    var decimalPos    = (opts.decimalPos    || 0) & 0x7;
    var currency      = (opts.currency      || 0) & 0x3;
    var currencyCode  = (opts.currencyCode  || 0) & 0xFF;
    var taxCode       = (opts.taxCode       || 0) & 0x3;
    var sfPresent     = !!(opts.sfPresent);
    var scalingFactor = (opts.scalingFactor || 0) & 0x7;
    var compoundVal   = !!(opts.compoundValue);
    if (compoundVal) {
      sfPresent = true;   // sf_byte required to carry COMPOUND_VALUE bit
      if (hasFinancial && baseTemplate < 2) baseTemplate = 2;
    }
    var compoundLines = opts.compoundLines || [];
    var qtyCompact    = !!(opts.qtyCompact);
    var splitPoint    = (opts.splitPoint    || 0) & 0x7;
    var ioDirection   = (opts.direction     || 0) & 0x1;
    var ioTime        = (opts.ioTime        || 0) & 0x1;
    var ioEffect      = (opts.effect        || 0) & 0x1;
    var ioSubtype     = (opts.subtype       || 0) & 0x3;
    var qtySplit      = !!(opts.qtySplit);
    var rounding      = (opts.rounding      || 0) & 0x3;
    var billed        = !!(opts.billed);
    var qtyType       = (opts.qtyType       || 0) & 0x1;
    var expenseCat    = (opts.expenseCat    || 0) & 0x3;
    // EXPENSE_CAT=00 (job charge) forces BILLED=1 on O-direction records
    if (hasFinancial && expenseCat === 0 && ioDirection === 1) billed = true;

    // DOMAIN=10/11 opts (Account Pair layer)
    var accountPair    = (opts.accountPair    || 0) & 0xF;
    var apDirection    = (opts.apDirection    || 0) & 0x1;
    var apStatus       = (opts.apStatus       || 0) & 0x1;
    var apCompleteness = (opts.apCompleteness || 0) & 0x1;
    // AP_EXTENSION always 0 — reserved post-MVP

    // State Commit opts (BASE_TEMPLATE=101)
    var scCommitType    = (opts.commitType    || 0) & 0x3;
    var scPeriodType    = (opts.periodType    || 0) & 0x3;
    var scChainComplete = !!(opts.chainComplete);
    var scDisputeFlag   = !!(opts.disputeFlag);
    var scTotalAmount   = opts.scTotalAmount;
    var scLineCount     = (opts.scLineCount   || 0) & 0xFF;
    var hasScFinSummary = isStateCommit && (scTotalAmount != null || scLineCount > 0);

    var rawParticipants  = opts.participants || [];
    var anonParticipants = anonMode ? rawParticipants.filter(function(p) { return !p.isSender; }) : rawParticipants;
    var hasParticipants  = anonParticipants.length > 0;

    // ── build flag bytes ─────────────────────────────────────────────────────────

    var fieldFlags = 0;
    var flags3     = 0;
    var fi;

    for (fi = 0; fi < FIELDS.length; fi++) {
      var f   = FIELDS[fi];
      if (f.type === 'fin') continue;
      var val = record[f.id];
      if (val == null || val === '')              continue;
      if (Array.isArray(val) && !val.length)     continue;
      fieldFlags |= (1 << f.bit);
    }

    var hasFlags3 = false;
    for (fi = 0; fi < FIELDS3.length; fi++) {
      var f3   = FIELDS3[fi];
      var val3 = record[f3.id];
      if (val3 == null || val3 === '') continue;
      flags3    |= (1 << f3.bit);
      hasFlags3  = true;
    }
    if (hasFlags3) fieldFlags |= (1 << 15);

    // FLAGS4 computation (template-specific extension fields)
    var flags4 = 0;
    if (baseTemplate === 3) {  // Contact
      for (fi = 0; fi < FIELDS4_CONTACT.length; fi++) {
        var f4c = FIELDS4_CONTACT[fi];
        var v4c = record[f4c.id];
        if (f4c.type === 'gps' ? v4c != null : (v4c != null && v4c !== '')) flags4 |= (1 << f4c.bit);
      }
    } else if (baseTemplate === 1 || baseTemplate === 2) {  // Financial / Compound
      for (fi = 0; fi < FIELDS4_FINANCIAL.length; fi++) {
        var f4f = FIELDS4_FINANCIAL[fi];
        var v4f = record[f4f.id];
        if (f4f.type === 'gps' ? v4f != null : (v4f != null && v4f !== '')) flags4 |= (1 << f4f.bit);
      }
    }
    if (flags4) {
      flags3    |= (1 << 7);   // FLAGS4_PRESENT
      hasFlags3  = true;
      fieldFlags |= (1 << 15);
    }

    if (hasFinancial)     fieldFlags |= (1 << 12);
    if (hasScFinSummary)  fieldFlags |= (1 << 12);

    // ── determine which header bytes are needed ──────────────────────────────────
    // meta2 is only written when it contributes something:
    // COMPACT_TIME only matters if date or time fields are actually present.

    var DATE_TIME_MASK  = (1<<2)|(1<<4)|(1<<5)|(1<<6)|(1<<14); // date,times,due_date
    var FLAGS3_DATE_MASK = (1<<3);                               // date_end
    var hasDateOrTime   = !!(fieldFlags & DATE_TIME_MASK) || !!(flags3 & FLAGS3_DATE_MASK);
    var needMeta2 = (compactTime && hasDateOrTime) || opts.hasTrigBlock || domain > 0 ||
                    opts.draft  || opts.restrictForward || hasParticipants;

    // ── write ────────────────────────────────────────────────────────────────────

    var out = [];

    function wb(v)   { out.push(v & 0xff); }
    function wu16(v) { out.push((v >> 8) & 0xff, v & 0xff); }

    function wtext(s) {
      var x = toUtf8(String(s));
      wu16(x.length);
      for (var i = 0; i < x.length; i++) out.push(x[i]);
    }

    function wcompact(s) {
      var x = toUtf8(String(s));
      var l = Math.min(x.length, 255);
      wb(l);
      for (var i = 0; i < l; i++) out.push(x[i]);
    }

    function wu24(v) { out.push((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff); }

    // meta1
    var meta1 = 0;
    if (needMeta2)         meta1 |= 0x80;
    if (opts.extTemplate)  meta1 |= 0x40;
    meta1 |= (opts.extTemplate ? (opts.extTemplate.signal & 0x7) : baseTemplate) << 3;
    if (opts.ackRequest)                meta1 |= 0x04;
    if (opts.chain && !anonMode)        meta1 |= 0x02;
    if (opts.recipientType)  meta1 |= 0x01;
    wb(meta1);

    // ext_template bytes
    if (opts.extTemplate) {
      var eb = opts.extTemplate.bytes;
      for (var ei = 0; ei < eb.length; ei++) out.push(eb[ei]);
    }

    // meta2
    if (needMeta2) {
      var meta2 = 0;
      if (compactTime)          meta2 |= 0x40;
      if (opts.hasTrigBlock)    meta2 |= 0x20;
      if (hasParticipants)      meta2 |= 0x10;
      meta2 |= (domain & 0x3) << 2;
      if (opts.draft)           meta2 |= 0x02;
      if (opts.restrictForward) meta2 |= 0x01;
      wb(meta2);
    }

    // financial context bytes (domain > 0, or State Commit which always has setup_byte)
    if (hasFinancial || isStateCommit) {
      wb((decimalPos << 5) | (currency << 3) | (taxCode << 1) | (sfPresent ? 1 : 0));
      if (currency === 3) wb(currencyCode);
      if (sfPresent) {
        wb((scalingFactor << 5) | (compoundVal ? 0x10 : 0) | (qtyCompact ? 0x08 : 0) | splitPoint);
      }
      if (isStateCommit) {
        // state_commit byte replaces transaction_byte
        wb((scCommitType << 6) | (scPeriodType << 4) | (scChainComplete ? 0x08 : 0) | (scDisputeFlag ? 0x04 : 0));
      } else if (domain === 2) {
        // DOMAIN=10: transaction_byte has BitLedger Account Pair layout
        wb((accountPair << 4) | (apDirection << 3) | (apStatus << 2) | (qtySplit ? 0x02 : 0) | (rounding & 0x1));
      } else {
        // DOMAIN=01 and DOMAIN=11: I>O layout
        wb((ioDirection << 7) | (ioTime << 6) | (ioEffect << 5) | (ioSubtype << 3) | (qtySplit ? 0x04 : 0) | (rounding & 0x3));
        if (domain === 3) {
          // DOMAIN=11: account_pair_byte follows transaction_byte
          wb(((accountPair & 0xF) << 4) | ((apDirection & 1) << 3) | ((apStatus & 1) << 2) | ((apCompleteness & 1) << 1));
        }
      }
    }

    // field_flags (2 bytes, big-endian)
    wu16(fieldFlags);

    // field_flags3
    if (hasFlags3) wb(flags3);

    // field_flags4
    if (flags4) wb(flags4);

    // data blocks: FIELDS in ascending bit order
    for (fi = 0; fi < FIELDS.length; fi++) {
      var f = FIELDS[fi];
      if (!(fieldFlags & (1 << f.bit))) continue;
      if (f.type === 'fin') {
        if (isStateCommit) {
          // sc_fin_summary Level A: total_amount uint24 + line_count uint8
          wu24(amountToU24(scTotalAmount || 0, decimalPos, scalingFactor));
          wb(scLineCount);
          continue;
        }
        var hasCustAmt = (opts.customerAmount != null && opts.customerAmount !== '') ||
                         (qtyCompact && qtySplit && opts.qty != null);
        var hasWorkAmt = opts.workerAmount != null && opts.workerAmount !== '';
        var custBit    = hasCustAmt ? 1 : 0;
        var workBit    = hasWorkAmt ? 1 : 0;
        var billedBit  = billed ? 1 : 0;

        if (domain === 2) {
          // DOMAIN=10 fin_control: bit6=1 mode indicator, AP in bits 5-2
          wb((billedBit << 7) | 0x40 | ((accountPair & 0xF) << 2) | (custBit << 1) | workBit);
        } else {
          // DOMAIN=01 and DOMAIN=11 fin_control: I>O perspective with PARITY
          var qtyTypeBit = qtyType ? 1 : 0;
          var ec1 = (expenseCat >> 1) & 1;
          var ec0 =  expenseCat       & 1;
          var parity = billedBit ^ qtyTypeBit ^ ec1 ^ ec0 ^ custBit ^ workBit;
          wb((billedBit << 7) | (qtyTypeBit << 5) | (parity << 4) | (expenseCat << 2) | (custBit << 1) | workBit);
        }

        if (hasCustAmt) {
          if (qtyCompact && qtySplit) {
            var sp = splitPoint === 0 ? 8 : splitPoint;
            var rU = amountToU24(opts.rate || 0, decimalPos, scalingFactor);
            var qI = Math.max(0, Math.min((1 << sp) - 1, Math.round(parseFloat(opts.qty || 0))));
            wu24(((rU << sp) | qI) & 0xFFFFFF);
          } else {
            wu24(amountToU24(opts.customerAmount, decimalPos, scalingFactor));
          }
        }
        if (hasWorkAmt) wu24(amountToU24(opts.workerAmount, decimalPos, scalingFactor));
        if (taxCode > 0) {
          wb((opts.taxRate   || 0) & 0xFF);
          wu16((opts.taxAmount || 0) & 0xFFFF);
        }
        if (qtySplit && !qtyCompact) {
          wu24(amountToU24(opts.qty  || 0, decimalPos, scalingFactor));
          wu24(amountToU24(opts.rate || 0, decimalPos, scalingFactor));
        }
        if (compoundVal && compoundLines.length > 0) {
          var cCount = Math.min(31, compoundLines.length);
          var cLFP = false;
          for (var cIdx = 0; cIdx < cCount; cIdx++) {
            var cL = compoundLines[cIdx];
            var cLT = (cL.lineType || 0) & 0x3;
            if (cLT || (cL.taxMode || 0) || (cLT !== 3 && cL.qty != null && cL.rate != null)) {
              cLFP = true; break;
            }
          }
          var cHasTot  = !!(opts.hasTotalSummary);
          var cHasSubs = !!(opts.hasSubtotals);
          wb((cCount << 3) | (cLFP ? 1 : 0));
          wb((cHasTot ? 0x80 : 0) | (cHasSubs ? 0x40 : 0));
          for (var cIdx2 = 0; cIdx2 < cCount; cIdx2++) {
            var cLine  = compoundLines[cIdx2];
            var cType  = (cLine.lineType || 0) & 0x3;
            var cTaxM  = (cLine.taxMode  || 0) & 0x3;
            var cHasQR = cType !== 3 && cLine.qty != null && cLine.rate != null;
            if (cLFP) wb((cType << 6) | (cTaxM << 4) | (cHasQR ? 0x08 : 0));
            wcompact(cLine.name || '');
            wu24(amountToU24(cLine.amount || 0, decimalPos, scalingFactor));
            if (cHasQR) {
              wu24(amountToU24(cLine.qty,  decimalPos, scalingFactor));
              wu24(amountToU24(cLine.rate, decimalPos, scalingFactor));
            }
          }
        }
        continue;
      }
      // bit 15 (FLAGS3_PRESENT) carries no data block

      var v = record[f.id];
      if (f.id === 'actions' && Array.isArray(v)) {
        // coerce actions array to newline-separated string for pads-v1 wire format
        v = v.map(function(a) { return a.title ? String(a.title) : String(a); }).join('\n');
      }
      var s = String(v);

      if      (f.type === 'text')    { wtext(s); }
      else if (f.type === 'compact') { wcompact(s); }
      else if (f.type === 'date') {
        if (compactTime) wu16(dateToDays(s));
        else             wtext(s);
      }
      else if (f.type === 'time') {
        if (compactTime) wu16(timeToMinutes(s));
        else             wtext(s);
      }
    }

    // FIELDS3 data blocks in ascending bit order
    if (hasFlags3) {
      for (fi = 0; fi < FIELDS3.length; fi++) {
        var f3 = FIELDS3[fi];
        if (!(flags3 & (1 << f3.bit))) continue;
        var v3 = String(record[f3.id]);
        if      (f3.type === 'text')    { wtext(v3); }
        else if (f3.type === 'compact') { wcompact(v3); }
        else if (f3.type === 'date') {
          if (compactTime) wu16(dateToDays(v3));
          else             wtext(v3);
        }
      }
    }

    // FLAGS4 data blocks in ascending bit order
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
      var parts      = anonParticipants;
      var partCount  = Math.min(7, parts.length);
      wb((partCount << 5) & 0xFF);
      for (var pti = 0; pti < partCount; pti++) {
        var p         = parts[pti];
        var pRoleType = (p.roleType || 0) & 0x3;
        var pHasPhone = !!(p.phone && p.phone !== '');
        var pHasEmail = !!(p.email && p.email !== '');
        var pHasAltId = !!(p.altId);
        var pBit1     = (pRoleType === 3)
          ? !!(p.roleText && p.roleText !== '')
          : !!(p.tradingName && p.tradingName !== '');
        var pf        = 0;
        if (p.isSender) pf |= 0x80;
        pf |= (pRoleType << 5);
        if (pHasAltId)  pf |= 0x10;
        if (pHasPhone)  pf |= 0x08;
        if (pHasEmail)  pf |= 0x04;
        if (pBit1)      pf |= 0x02;
        if (p.isOrg)    pf |= 0x01;
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

    // TRIG block (meta2 HAS_TRIG_BLOCK=1)
    if (opts.hasTrigBlock) {
      var tb  = opts.trigBytes || new Uint8Array(0);
      var tbl = Math.min(tb.length, 20);
      wb(tbl);
      for (var tbi = 0; tbi < tbl; tbi++) out.push(tb[tbi]);
    }

    // display_schema block (present for #1pb/ and #1pf/ presentation records)
    var ds = opts.displaySchema;
    if (ds) {
      var dsType    = (ds.displayType || 0) & 0x3;
      var dsSrc     = (ds.dataSource  || 0) & 0x3;
      var dsPrice   = !!(ds.showPrice);
      var dsContact = !!(ds.showContact);
      var dsHasAcc  = ds.accentColor != null;
      var dsHasDF2  = ds.displayFlags2 != null;
      wb((dsType << 6) | (dsSrc << 4) | (dsPrice ? 0x08 : 0) | (dsContact ? 0x04 : 0) | (dsHasAcc ? 0x02 : 0) | (dsHasDF2 ? 0x01 : 0));
      if (dsHasAcc) wb(ds.accentColor & 0xFF);
      if (dsHasDF2) {
        var df2      = ds.displayFlags2;
        var df2Font  = (df2.fontSize    || 0) & 0x7;
        var df2Cols  = (df2.layoutCols  || 0) & 0x3;
        wb((df2Font << 5) | (df2Cols << 3));
      }

      // form_schema block (present when DISPLAY_TYPE=02 or 03)
      var fso = opts.formSchema;
      if (fso && dsType >= 2) {
        var fsSA  = anonMode ? 3 : ((fso.submitAction || 0) & 0x3);
        var fsRT  = (fso.replyTemplate || 0) & 0x3;
        var fsAE  = !!(fso.allowEdit);
        var fsRN  = !!(fso.requireName);
        var fsRP  = !!(fso.requirePhone);
        var fsFF  = !!(fso.fields && fso.fields.length > 0);
        wb((fsSA << 6) | (fsRT << 4) | (fsAE ? 0x08 : 0) | (fsRN ? 0x04 : 0) | (fsRP ? 0x02 : 0) | (fsFF ? 0x01 : 0));
        if (fsFF) {
          var fsFields = fso.fields;
          wb(fsFields.length & 0xFF);
          for (var ffi = 0; ffi < fsFields.length; ffi++) {
            var ff      = fsFields[ffi];
            var ffType  = (ff.type || 0) & 0xF;
            var ffReq   = !!(ff.required);
            wb((ffType << 4) | (ffReq ? 0x08 : 0));
            var ffLbl   = (ff.labelIndex != null) ? (ff.labelIndex & 0xFF) : 0xFF;
            wb(ffLbl);
            if (ffLbl === 0xFF && ff.customLabel) wcompact(ff.customLabel);
          }
        }
      }
    }

    if (opts.programmableRules && global.WPProgrammableRules) {
      var prb = global.WPProgrammableRules.encodeBlock(opts.programmableRules);
      if (prb && prb.length) {
        for (var pri = 0; pri < prb.length; pri++) out.push(prb[pri]);
      }
    }

    return new Uint8Array(out);
  }

  // ── pads-v1 frame decoder ──────────────────────────────────────────────────────

  function parseFrame(bytes, parseOpts) {
    if (bytes.length < 3) throw new Error('WPCodec: frame too short');
    parseOpts = parseOpts || {};
    var pos    = 0;
    var record = {};

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

    // ext_template bytes
    if (extTemplate) {
      var sig = baseOrSig;
      if      (sig === 1) { record._extTemplateId = bytes[pos++]; }
      else if (sig === 2) { record._extTemplateId = readU16(bytes, pos); pos += 2; }
      else if (sig === 3) { record._extTemplateId = readU24(bytes, pos); pos += 3; }
      else if (sig === 4) { record._extTemplateId = { ns: bytes[pos], id: readU16(bytes, pos+1) }; pos += 3; }
    }

    // meta2
    var compactTime = false;
    var domain      = 0;
    if (meta2Present) {
      var meta2    = bytes[pos++];
      compactTime  = !!(meta2 & 0x40);
      domain       = (meta2 >> 2) & 0x03;
      record._meta.selfDescribing  = !!(meta2 & 0x80);
      record._meta.compactTime     = compactTime;
      record._meta.domain          = domain;
      record._meta.hasTrigBlock    = !!(meta2 & 0x20);
      record._meta.hasParticipants = !!(meta2 & 0x10);
      record._meta.draft           = !!(meta2 & 0x02);
      record._meta.restrictForward = !!(meta2 & 0x01);
    }

    // Detect BASE_TEMPLATE for special record types
    var isStateCommit = (!extTemplate && baseOrSig === 5);
    var isAmendment   = (!extTemplate && baseOrSig === 6);

    // Amendment: dispatch to separate decoder
    if (isAmendment) return parseAmendmentFrame(bytes, pos, record, compactTime);

    // financial context vars (defaults for no-financial records)
    var finDp  = 0;   // DECIMAL_POS
    var finTax = 0;   // TAX_CODE
    var finSf  = 0;   // SCALING_FACTOR index
    var finQtyC = false; // QTY_COMPACT
    var finQtyS = false; // QTY_SPLIT
    var finSp   = 0;  // SPLIT_POINT

    if (domain > 0 || isStateCommit) {
      if (pos >= bytes.length) throw new Error('WPCodec: truncated at setup_byte');
      var sb    = bytes[pos++];
      finDp     = (sb >> 5) & 0x7;
      var finCur = (sb >> 3) & 0x3;
      finTax    = (sb >> 1) & 0x3;
      var finSfP = !!(sb & 0x1);
      var finCC  = 0;
      if (finCur === 3) {
        if (pos >= bytes.length) throw new Error('WPCodec: truncated at currency_ext');
        finCC = bytes[pos++];
      }
      var finCmpd = false;
      if (finSfP) {
        if (pos >= bytes.length) throw new Error('WPCodec: truncated at sf_byte');
        var sfb  = bytes[pos++];
        finSf    = (sfb >> 5) & 0x7;
        finCmpd  = !!(sfb & 0x10);
        finQtyC  = !!(sfb & 0x08);
        finSp    =   sfb      & 0x7;
      }

      if (isStateCommit) {
        // state_commit byte (replaces transaction_byte)
        if (pos >= bytes.length) throw new Error('WPCodec: truncated at state_commit_byte');
        var scb = bytes[pos++];
        record._stateCommit = {
          commitType:    (scb >> 6) & 0x3,
          periodType:    (scb >> 4) & 0x3,
          chainComplete: !!(scb & 0x08),
          disputeFlag:   !!(scb & 0x04)
        };
        record._fin = { decimalPos: finDp, currency: finCur, currencyCode: finCC, taxCode: finTax,
                        sfPresent: finSfP, scalingFactor: finSf, compoundValue: finCmpd };
      } else {
        if (pos >= bytes.length) throw new Error('WPCodec: truncated at transaction_byte');
        var txb = bytes[pos++];

        if (domain === 2) {
          // DOMAIN=10: transaction_byte = [AP(7-4)][DIR(3)][STATUS(2)][QTY_SPLIT(1)][ROUNDING(0)]
          finQtyS = !!(txb & 0x02);
          record._fin = {
            decimalPos: finDp, currency: finCur, currencyCode: finCC, taxCode: finTax,
            sfPresent: finSfP, scalingFactor: finSf, compoundValue: finCmpd,
            qtyCompact: finQtyC, splitPoint: finSp,
            accountPair: (txb >> 4) & 0xF,
            apDirection: (txb >> 3) & 1,
            apStatus:    (txb >> 2) & 1,
            qtySplit:    finQtyS,
            rounding:    txb & 1
          };
        } else {
          // DOMAIN=01 and DOMAIN=11: transaction_byte = I>O layout
          finQtyS = !!(txb & 0x04);
          record._fin = {
            decimalPos: finDp, currency: finCur, currencyCode: finCC, taxCode: finTax,
            sfPresent: finSfP, scalingFactor: finSf, compoundValue: finCmpd,
            qtyCompact: finQtyC, splitPoint: finSp,
            direction: (txb >> 7) & 1, time: (txb >> 6) & 1, effect: (txb >> 5) & 1,
            subtype:   (txb >> 3) & 3, qtySplit: finQtyS, rounding: txb & 3
          };
          if (domain === 3) {
            // DOMAIN=11: account_pair_byte follows transaction_byte
            if (pos >= bytes.length) throw new Error('WPCodec: truncated at account_pair_byte');
            var apb  = bytes[pos++];
            var apExt = apb & 1;
            record._ap = {
              accountPair:    (apb >> 4) & 0xF,
              apDirection:    (apb >> 3) & 1,
              apStatus:       (apb >> 2) & 1,
              apCompleteness: (apb >> 1) & 1,
              apExtension:    apExt
            };
            if (apExt && pos < bytes.length) pos++; // skip post-MVP extension byte
          }
        }
      }
    }

    // field_flags (2 bytes)
    if (pos + 2 > bytes.length) throw new Error('WPCodec: truncated at field_flags');
    var fieldFlags = readU16(bytes, pos); pos += 2;

    // field_flags3
    var flags3 = 0;
    if (fieldFlags & (1 << 15)) {
      if (pos >= bytes.length) throw new Error('WPCodec: truncated at flags3');
      flags3 = bytes[pos++];
    }

    // field_flags4
    var flags4d = 0;
    if (flags3 & (1 << 7)) {
      if (pos >= bytes.length) throw new Error('WPCodec: truncated at flags4');
      flags4d = bytes[pos++];
      if (flags4d & (1 << 7)) {  // FLAGS5_PRESENT: skip 1 flags5 byte (reserved)
        if (pos >= bytes.length) throw new Error('WPCodec: truncated at flags5');
        pos++;
      }
    }

    // reader helpers
    function rtext() {
      var len = readU16(bytes, pos); pos += 2;
      var s   = fromUtf8(bytes.subarray(pos, pos + len)); pos += len;
      return s;
    }
    function rcompact() {
      var len = bytes[pos++];
      var s   = fromUtf8(bytes.subarray(pos, pos + len)); pos += len;
      return s;
    }

    // data blocks: FIELDS in ascending bit order
    var fi;
    for (fi = 0; fi < FIELDS.length; fi++) {
      var f = FIELDS[fi];
      if (!(fieldFlags & (1 << f.bit))) continue;
      if (f.bit === 15) continue; // FLAGS3_PRESENT — no data block

      if (f.type === 'fin') {
        if (isStateCommit) {
          // sc_fin_summary Level A: total_amount uint24 + line_count uint8
          var scTotRaw = readU24(bytes, pos); pos += 3;
          record.sc_total_amount = u24ToAmount(scTotRaw, finDp, finSf);
          record.sc_line_count   = bytes[pos++];
          continue;
        }
        if (pos >= bytes.length) throw new Error('WPCodec: truncated at fin_control');
        var fc     = bytes[pos++];
        var fcBit6 = (fc >> 6) & 1;
        var fcBld  = (fc >> 7) & 1;
        var fcCust = (fc >> 1) & 1;
        var fcWork =  fc       & 1;

        if (domain === 2) {
          // DOMAIN=10 fin_control: bit6 must be 1; AP in bits 5-2
          if (!fcBit6) throw new Error('WPCodec: fin_control mode bit error (bit6 must be 1 for domain=10)');
          record.billed       = !!fcBld;
          record.account_pair = (fc >> 2) & 0xF;
        } else {
          // DOMAIN=01 and DOMAIN=11 fin_control: bit6 must be 0; PARITY + EXPENSE_CAT
          if (fcBit6) throw new Error('WPCodec: fin_control mode bit error (bit6 must be 0 for domain=01/11)');
          var fcQtyT = (fc >> 5) & 1;
          var fcPar  = (fc >> 4) & 1;
          var fcEc   = (fc >> 2) & 3;
          if (fcEc === 3) throw new Error('WPCodec: fin_control EXPENSE_CAT=11 reserved');
          var fcPexp = fcBld ^ fcQtyT ^ ((fcEc >> 1) & 1) ^ (fcEc & 1) ^ fcCust ^ fcWork;
          if (fcPar !== fcPexp) throw new Error('WPCodec: fin_control parity error');
          record.billed      = !!fcBld;
          record.qty_type    = fcQtyT;
          record.expense_cat = fcEc;
        }

        if (fcCust) {
          var cuRaw = readU24(bytes, pos); pos += 3;
          if (finQtyC && finQtyS) {
            var sp    = finSp === 0 ? 8 : finSp;
            var qtyU  = cuRaw & ((1 << sp) - 1);
            var rateU = cuRaw >> sp;
            var sfMul = SF_MULTIPLIERS[finSf] || 1;
            var dp    = finDp > 6 ? 6 : finDp;
            record.qty  = String(qtyU);
            record.rate = u24ToAmount(rateU, finDp, finSf);
            record.customer_amount = ((rateU * qtyU * sfMul) / Math.pow(10, dp)).toFixed(dp);
          } else {
            record.customer_amount = u24ToAmount(cuRaw, finDp, finSf);
          }
        }
        if (fcWork) { record.worker_amount = u24ToAmount(readU24(bytes, pos), finDp, finSf); pos += 3; }
        if (finTax > 0) {
          if (pos + 3 > bytes.length) throw new Error('WPCodec: truncated at tax_block');
          record.tax_rate   = bytes[pos++];
          record.tax_amount = u24ToAmount(readU16(bytes, pos), finDp, finSf); pos += 2;
        }
        if (finQtyS && !finQtyC) {
          if (pos + 6 > bytes.length) throw new Error('WPCodec: truncated at qty_rate_block');
          record.qty  = u24ToAmount(readU24(bytes, pos), finDp, finSf); pos += 3;
          record.rate = u24ToAmount(readU24(bytes, pos), finDp, finSf); pos += 3;
        }
        if (finCmpd) {
          if (pos + 2 > bytes.length) throw new Error('WPCodec: truncated at compound_header');
          var chdr1    = bytes[pos++];
          var chdr2    = bytes[pos++];
          var cLineCount  = (chdr1 >> 3) & 0x1F;
          var cLFP        = !!(chdr1 & 0x01);
          var cHasTot     = !!(chdr2 & 0x80);
          var cHasSubs    = !!(chdr2 & 0x40);
          if (cLineCount === 0) throw new Error('WPCodec: compound LINE_COUNT=0 (protocol error)');
          var cLines = [];
          for (var dcIdx = 0; dcIdx < cLineCount; dcIdx++) {
            var dType = 0, dTaxM = 0, dHasQR = false;
            if (cLFP) {
              var clf  = bytes[pos++];
              dType    = (clf >> 6) & 0x3;
              dTaxM    = (clf >> 4) & 0x3;
              dHasQR   = !!(clf & 0x08) && dType !== 3;
            }
            var dName   = rcompact();
            var dAmtRaw = readU24(bytes, pos); pos += 3;
            var dAmt    = u24ToAmount(dAmtRaw, finDp, finSf);
            var dcLine  = { name: dName, amount: dAmt, lineType: dType, taxMode: dTaxM };
            if (dHasQR) {
              dcLine.qty  = u24ToAmount(readU24(bytes, pos), finDp, finSf); pos += 3;
              dcLine.rate = u24ToAmount(readU24(bytes, pos), finDp, finSf); pos += 3;
            }
            cLines.push(dcLine);
          }
          record._compound = { lines: cLines, hasTotalSummary: cHasTot, hasSubtotals: cHasSubs };
        }
        continue;
      }

      if      (f.type === 'text')    { record[f.id] = rtext(); }
      else if (f.type === 'compact') { record[f.id] = rcompact(); }
      else if (f.type === 'date') {
        if (compactTime) { record[f.id] = daysToDate(readU16(bytes, pos)); pos += 2; }
        else             { record[f.id] = rtext(); }
      }
      else if (f.type === 'time') {
        if (compactTime) { record[f.id] = minutesToTime(readU16(bytes, pos)); pos += 2; }
        else             { record[f.id] = rtext(); }
      }
    }

    // FIELDS3 data blocks in ascending bit order
    var f3i;
    for (f3i = 0; f3i < FIELDS3.length; f3i++) {
      var f3 = FIELDS3[f3i];
      if (!(flags3 & (1 << f3.bit))) continue;

      if      (f3.type === 'text')    { record[f3.id] = rtext(); }
      else if (f3.type === 'compact') { record[f3.id] = rcompact(); }
      else if (f3.type === 'date') {
        if (compactTime) { record[f3.id] = daysToDate(readU16(bytes, pos)); pos += 2; }
        else             { record[f3.id] = rtext(); }
      }
    }

    // FLAGS4 data blocks in ascending bit order
    if (flags4d) {
      var btd    = record._meta.baseTemplate;
      var f4def2 = (btd === 3) ? FIELDS4_CONTACT : (btd === 1 || btd === 2) ? FIELDS4_FINANCIAL : null;
      if (f4def2) {
        for (var f4i = 0; f4i < f4def2.length; f4i++) {
          var f4d = f4def2[f4i]; if (!(flags4d & (1 << f4d.bit))) continue;
          if      (f4d.type === 'text')    { record[f4d.id] = rtext(); }
          else if (f4d.type === 'compact') { record[f4d.id] = rcompact(); }
          else if (f4d.type === 'u8enum')  { record[f4d.id] = bytes[pos++]; }
          else if (f4d.type === 'date') {
            record[f4d.id] = daysToDate(readU16(bytes, pos)); pos += 2;
          }
          else if (f4d.type === 'gps') {
            var latS = readI16(bytes, pos); pos += 2;
            var lonS = readI16(bytes, pos); pos += 2;
            record.gps_binary = { lat: latS / 100, lon: lonS / 100 };
          }
        }
      }
    }

    // participants block
    if (record._meta.hasParticipants) {
      if (pos >= bytes.length) throw new Error('WPCodec: truncated at participants block_header');
      var bh     = bytes[pos++];
      var pCount = (bh >> 5) & 0x7;
      if (pCount === 0) throw new Error('WPCodec: participants block_header count=0 (protocol error)');
      var ptArr = [];
      for (var pti = 0; pti < pCount; pti++) {
        if (pos >= bytes.length) throw new Error('WPCodec: truncated at part_flags');
        var pf        = bytes[pos++];
        var pIsSender = !!(pf & 0x80);
        var pRoleType = (pf >> 5) & 0x3;
        var pHasAltId = !!(pf & 0x10);
        var pHasPhone = !!(pf & 0x08);
        var pHasEmail = !!(pf & 0x04);
        var pBit1     = !!(pf & 0x02);
        var pIsOrg    = !!(pf & 0x01);
        var part      = { isSender: pIsSender, roleType: pRoleType, isOrg: pIsOrg, name: rtext() };
        if (pRoleType !== 3 && pBit1) part.tradingName = rtext();
        if (pHasPhone) part.phone = rtext();
        if (pHasEmail) part.email = rtext();
        if (pRoleType === 3) {
          if (pBit1) {
            part.roleText = rtext();
          } else {
            var rc     = bytes[pos++];
            var rcSlot = (rc >> 3) & 0x1F;
            var rcSig  =  rc       & 0x7;
            part.roleSlot    = rcSlot;
            part.roleSignals = rcSig;
            if (rcSlot === 31) part.roleCode2 = bytes[pos++];
          }
        }
        if (pHasAltId) {
          var aidType = bytes[pos++];
          var aidVal  = rcompact();
          part.altId = { type: aidType, value: aidVal };
        }
        ptArr.push(part);
      }
      record._participants = ptArr;
    }

    // TRIG block (meta2 HAS_TRIG_BLOCK=1)
    if (record._meta.hasTrigBlock && pos < bytes.length) {
      var tLen = bytes[pos++];
      if (tLen > 20) {
        record._trig = { trig_violation: true };
        pos += tLen;
      } else {
        record._trig = { bytes: bytes.subarray(pos, pos + tLen) };
        pos += tLen;
      }
    }

    // display_schema + form_schema (when parseOpts.presentation=true)
    if (parseOpts && parseOpts.presentation && pos < bytes.length) {
      var dc        = bytes[pos++];
      var dsParsed  = {
        displayType:  (dc >> 6) & 0x3,
        dataSource:   (dc >> 4) & 0x3,
        showPrice:    !!(dc & 0x08),
        showContact:  !!(dc & 0x04)
      };
      if (dc & 0x02) dsParsed.accentColor = bytes[pos++];
      if (dc & 0x01) {
        var df2b = bytes[pos++];
        dsParsed.displayFlags2 = { fontSize: (df2b >> 5) & 0x7, layoutCols: (df2b >> 3) & 0x3 };
      }
      record._displaySchema = dsParsed;
      if (dsParsed.dataSource === 3) record._anonMode = true;

      // form_schema (present when DISPLAY_TYPE=02 or 03)
      if (dsParsed.displayType >= 2 && pos < bytes.length) {
        var fc      = bytes[pos++];
        var fsParsed = {
          submitAction:  (fc >> 6) & 0x3,
          replyTemplate: (fc >> 4) & 0x3,
          allowEdit:     !!(fc & 0x08),
          requireName:   !!(fc & 0x04),
          requirePhone:  !!(fc & 0x02)
        };
        var fsFF = !!(fc & 0x01);
        if (fsFF && pos < bytes.length) {
          var fCount = bytes[pos++];
          var fFields = [];
          for (var ffi2 = 0; ffi2 < fCount; ffi2++) {
            var ffb1   = bytes[pos++];
            var ffb2   = bytes[pos++];
            var fField = {
              type:       (ffb1 >> 4) & 0xF,
              required:   !!(ffb1 & 0x08),
              labelIndex: ffb2
            };
            if (ffb2 === 0xFF) fField.customLabel = rcompact();
            fFields.push(fField);
          }
          fsParsed.fields = fFields;
        }
        record._formSchema = fsParsed;
      }
    }

    if (global.WPProgrammableRules && pos < bytes.length &&
        bytes[pos] === global.WPProgrammableRules.TAG) {
      var prDec = global.WPProgrammableRules.decodeBlock(bytes, pos);
      record.programmable_rules = prDec.rules;
      record._programmablePlain = global.WPProgrammableRules.describeAll(prDec.rules);
      pos = prDec.next;
    }

    return record;
  }

  // ── Amendment frame decoder (BASE_TEMPLATE=110) ───────────────────────────────

  function parseAmendmentFrame(bytes, pos, record, compactTime) {
    if (pos + 2 > bytes.length) throw new Error('WPCodec: truncated at amendment_header');
    var changedMask  = readU16(bytes, pos); pos += 2;
    var hasCM3       = !!(changedMask & 0x8000);
    var hasAFBit     = !!(changedMask & 0x4000);
    var changedMask3 = 0;
    var parentUidArr = null;
    var disputeLink  = false;

    if (hasCM3) {
      changedMask3 = bytes[pos++];
    } else if (hasAFBit) {
      var af = bytes[pos++];
      disputeLink = !!(af & 0x40);
      if (af & 0x80) {
        parentUidArr = Array.from(bytes.subarray(pos, pos + 8)); pos += 8;
      }
    }

    record._amendment = { changedMask: changedMask & ~0xC000, changedMask3: changedMask3, disputeLink: disputeLink };
    if (parentUidArr) record._amendment.parentUid = parentUidArr;

    function rtext() {
      var len = readU16(bytes, pos); pos += 2;
      var s   = fromUtf8(bytes.subarray(pos, pos + len)); pos += len;
      return s;
    }
    function rcompact() {
      var len = bytes[pos++];
      var s   = fromUtf8(bytes.subarray(pos, pos + len)); pos += len;
      return s;
    }

    var fi;
    for (fi = 0; fi < FIELDS.length; fi++) {
      var f = FIELDS[fi];
      if (!(changedMask & (1 << f.bit))) continue;
      if (f.bit === 15) continue;
      if (f.type === 'fin') continue; // financial amendment deferred (Round 6+)
      if      (f.type === 'text')    { record[f.id] = rtext(); }
      else if (f.type === 'compact') { record[f.id] = rcompact(); }
      else if (f.type === 'date') {
        if (compactTime) { record[f.id] = daysToDate(readU16(bytes, pos)); pos += 2; }
        else             { record[f.id] = rtext(); }
      }
      else if (f.type === 'time') {
        if (compactTime) { record[f.id] = minutesToTime(readU16(bytes, pos)); pos += 2; }
        else             { record[f.id] = rtext(); }
      }
    }

    if (hasCM3) {
      for (var f3i = 0; f3i < FIELDS3.length; f3i++) {
        var f3 = FIELDS3[f3i];
        if (!(changedMask3 & (1 << f3.bit))) continue;
        if      (f3.type === 'text')    { record[f3.id] = rtext(); }
        else if (f3.type === 'compact') { record[f3.id] = rcompact(); }
        else if (f3.type === 'date') {
          if (compactTime) { record[f3.id] = daysToDate(readU16(bytes, pos)); pos += 2; }
          else             { record[f3.id] = rtext(); }
        }
      }
    }

    return record;
  }

  // ── legacy decoders (preserved for backward compatibility) ────────────────────

  var LEGACY_TEMPLATE_KAIOS  = 0x02;
  var LEGACY_TEMPLATE_OLD    = 0x01;
  var LEGACY_RECORD_TYPES    = ['quote', 'invoice', 'expense', 'payment'];
  var LEGACY_CURRENCIES      = ['GBP', 'USD', 'EUR', 'CAD', 'AUD', 'NZD', 'ZAR'];
  var LEGACY_VAT_RATES       = ['0', '5', '7.5', '10', '12.5', '15', '20', '23', '25'];
  var LEGACY_BILLING_TYPES   = ['billable', 'non-billable', 'absorbed', 'cogs'];
  var LEGACY_SCALAR_FIELDS   = [
    { id: 'job',            bit: 0  },
    { id: 'customer',       bit: 1  },
    { id: 'location',       bit: 3  },
    { id: 'meeting_time',   bit: 4  },
    { id: 'start_time',     bit: 5  },
    { id: 'end_time',       bit: 6  },
    { id: 'customer_phone', bit: 7  },
    { id: 'worker',         bit: 8  },
    { id: 'details',        bit: 10 },
    { id: 'story',          bit: 11 },
  ];

  function padsDecodeKaios(bytes) {
    if (bytes.length < 4) throw new Error('WPCodec: frame too short');
    var pos = 0;
    var tid = bytes[pos++];
    if (tid !== LEGACY_TEMPLATE_KAIOS) throw new Error('WPCodec: expected 0x02, got 0x' + tid.toString(16));
    var flags  = readU24(bytes, pos); pos += 3;
    var record = {};
    var di, df;

    function readField() {
      var len = readU16(bytes, pos); pos += 2;
      var s   = fromUtf8(bytes.subarray(pos, pos + len)); pos += len;
      return s;
    }

    for (di = 0; di < LEGACY_SCALAR_FIELDS.length; di++) {
      df = LEGACY_SCALAR_FIELDS[di];
      if (df.bit > 1) break;
      if (flags & (1 << df.bit)) record[df.id] = readField();
    }
    if (flags & (1 << 2)) { record.date = legacyU16ToDate(readU16(bytes, pos)); pos += 2; }
    for (di = 0; di < LEGACY_SCALAR_FIELDS.length; di++) {
      df = LEGACY_SCALAR_FIELDS[di];
      if (df.bit < 3 || df.bit >= 9) continue;
      if (flags & (1 << df.bit)) record[df.id] = readField();
    }
    if (flags & (1 << 9)) {
      var ac = bytes[pos++]; var actions = [];
      for (var ak = 0; ak < ac; ak++) {
        var afl = bytes[pos++];
        var ttl = readField();
        var nts = (afl & 0x01) ? readField() : '';
        actions.push({ title: ttl, notes: nts });
      }
      record.actions = actions;
    }
    for (di = 0; di < LEGACY_SCALAR_FIELDS.length; di++) {
      df = LEGACY_SCALAR_FIELDS[di];
      if (df.bit > 9 && df.bit < 12 && (flags & (1 << df.bit))) record[df.id] = readField();
    }
    if (flags & (1 << 12)) {
      var finFlags = bytes[pos++];
      record.record_type = 'job';
      if (finFlags & 0x01) { var ri = bytes[pos++]; record.record_type = LEGACY_RECORD_TYPES[ri] || 'job'; }
      if (finFlags & 0x02) { var ci = bytes[pos++]; record.currency = ci === 255 ? readField() : (LEGACY_CURRENCIES[ci] || ''); }
      if (finFlags & 0x04) { var vi = bytes[pos++]; record.vat      = vi === 255 ? readField() : (LEGACY_VAT_RATES[vi]  || ''); }
      if (finFlags & 0x08) { record.amount = u32ToLegacyAmount(readU32(bytes, pos)); pos += 4; }
      if (finFlags & 0x10) {
        var ec = bytes[pos++]; var exps = [];
        for (var ei = 0; ei < ec; ei++) {
          var efl = bytes[pos++];
          var exp = { amount: u32ToLegacyAmount(readU32(bytes, pos)) }; pos += 4;
          if (efl & 0x01) exp.job             = readField();
          if (efl & 0x02) exp.date            = readField();
          if (efl & 0x04) exp.expense_billing = LEGACY_BILLING_TYPES[bytes[pos++]] || 'billable';
          if (efl & 0x08) exp.actionIdx       = bytes[pos++];
          if (efl & 0x10) exp.is_viewer        = true;
          exps.push(exp);
        }
        record._expenses = exps;
      }
      if (finFlags & 0x20) {
        var pc = bytes[pos++]; var pays = [];
        for (var pi = 0; pi < pc; pi++) {
          var pfl = bytes[pos++];
          var pay = { amount: u32ToLegacyAmount(readU32(bytes, pos)) }; pos += 4;
          if (pfl & 0x01) pay.job  = readField();
          if (pfl & 0x02) pay.date = readField();
          pays.push(pay);
        }
        record._payments = pays;
      }
    }
    if (flags & (1 << 16)) record.record_subtype  = readField();
    if (flags & (1 << 17)) record.template_locale = readField();
    if (flags & (1 << 18)) { record._chainRef = toBase64Url(bytes.subarray(pos, pos + 3)); pos += 3; }
    if (flags & (1 << 19)) {
      var ptc = bytes[pos++]; var parts = [];
      for (var pti = 0; pti < ptc; pti++) parts.push({ name: readField(), role: readField() });
      record._participants = parts;
    }
    if (flags & (1 << 20)) record.geo         = readField();
    if (flags & (1 << 21)) record.service_ref  = readField();
    if (flags & (1 << 22)) { record.expiry       = readU16(bytes, pos); pos += 2; }
    if (flags & (1 << 23)) record.verification  = bytes[pos++];
    return record;
  }

  function padsDecodeLegacy(bytes, useBinary) {
    if (bytes.length < 3) throw new Error('WPCodec: frame too short');
    var pos = 0;
    var tid = bytes[pos++];
    if (tid !== LEGACY_TEMPLATE_OLD) throw new Error('WPCodec: expected 0x01, got 0x' + tid.toString(16));
    var flags  = readU16(bytes, pos); pos += 2;
    var record = {};

    function readField() {
      var len = readU16(bytes, pos); pos += 2;
      var s   = fromUtf8(bytes.subarray(pos, pos + len)); pos += len;
      return s;
    }

    if (flags & 0x01) record.job      = readField();
    if (flags & 0x02) record.customer = readField();
    if (flags & (1 << 2)) {
      if (useBinary) { record.date = legacyU16ToDate(readU16(bytes, pos)); pos += 2; }
      else           { record.date = readField(); }
    }
    var legBits = [
      {id:'location',bit:3},{id:'meeting_time',bit:4},{id:'start_time',bit:5},
      {id:'end_time',bit:6},{id:'customer_phone',bit:7},{id:'worker',bit:8}
    ];
    for (var li = 0; li < legBits.length; li++) {
      if (flags & (1 << legBits[li].bit)) record[legBits[li].id] = readField();
    }
    if (flags & (1 << 9)) {
      var ac = bytes[pos++]; var actions = [];
      for (var ak = 0; ak < ac; ak++) {
        if (useBinary) {
          var afl = bytes[pos++];
          actions.push({ title: readField(), notes: (afl & 0x01) ? readField() : '' });
        } else {
          actions.push({ title: readField(), notes: readField() });
        }
      }
      record.actions = actions;
    }
    if (flags & (1 << 10)) record.details = readField();
    if (flags & (1 << 11)) record.story   = readField();
    if (flags & (1 << 12)) {
      var finFlags = bytes[pos++];
      record.record_type = 'job';
      if (finFlags & 0x01) { var ri = bytes[pos++]; record.record_type = LEGACY_RECORD_TYPES[ri] || 'job'; }
      if (finFlags & 0x02) { var ci = bytes[pos++]; record.currency = ci === 255 ? readField() : (LEGACY_CURRENCIES[ci] || ''); }
      if (finFlags & 0x04) { var vi = bytes[pos++]; record.vat      = vi === 255 ? readField() : (LEGACY_VAT_RATES[vi]  || ''); }
      if (finFlags & 0x08) {
        if (useBinary) { record.amount = u32ToLegacyAmount(readU32(bytes, pos)); pos += 4; }
        else           { record.amount = readField(); }
      }
      if (finFlags & 0x10) {
        var ec = bytes[pos++]; var exps = [];
        for (var ei = 0; ei < ec; ei++) {
          var efl = bytes[pos++]; var exp = {};
          if (useBinary) { exp.amount = u32ToLegacyAmount(readU32(bytes, pos)); pos += 4; }
          else           { exp.amount = readField(); }
          if (efl & 0x01) exp.job             = readField();
          if (efl & 0x02) exp.date            = readField();
          if (efl & 0x04) exp.expense_billing = LEGACY_BILLING_TYPES[bytes[pos++]] || 'billable';
          if (efl & 0x08) exp.actionIdx       = bytes[pos++];
          if (efl & 0x10) exp.is_viewer        = true;
          exps.push(exp);
        }
        record._expenses = exps;
      }
      if (finFlags & 0x20) {
        var pc = bytes[pos++]; var pays = [];
        for (var pi = 0; pi < pc; pi++) {
          var pfl = bytes[pos++]; var pay = {};
          if (useBinary) { pay.amount = u32ToLegacyAmount(readU32(bytes, pos)); pos += 4; }
          else           { pay.amount = readField(); }
          if (pfl & 0x01) pay.job  = readField();
          if (pfl & 0x02) pay.date = readField();
          pays.push(pay);
        }
        record._payments = pays;
      }
    }
    if (useBinary && (flags & (1 << 13))) {
      record._chainRef = toBase64Url(bytes.subarray(pos, pos + 3));
      pos += 3;
    }
    return record;
  }

  function u32ToLegacyAmount(u) {
    if (!u) return '0';
    var cents = u % 100;
    var units = (u - cents) / 100;
    if (!cents) return String(units);
    return units + '.' + (cents < 10 ? '0' : '') + cents;
  }

  // ── URL suffix params (&c= chain ref, &r= ratified frame) ───────────────────

  function parseHashExtras(hash) {
    var amp = hash.indexOf('&');
    if (amp === -1) return { body: hash, chainRef: null, ratifiedB64: null };
    var body = hash.slice(0, amp);
    var chainRef = null;
    var ratifiedB64 = null;
    var segs = hash.slice(amp + 1).split('&');
    var si;
    for (si = 0; si < segs.length; si++) {
      if (segs[si].indexOf('c=') === 0) chainRef = segs[si].slice(2);
      else if (segs[si].indexOf('r=') === 0) ratifiedB64 = segs[si].slice(2);
    }
    return { body: body, chainRef: chainRef, ratifiedB64: ratifiedB64 };
  }

  function appendRatifiedSuffix(url, ratifiedFrameBytes) {
    if (!ratifiedFrameBytes || !ratifiedFrameBytes.length) return url;
    var rDef = global.fflate.deflateSync(ratifiedFrameBytes, { level: 9 });
    return url + '&r=' + toBase64Url(rDef);
  }

  function attachRatifiedFrameRecord(result, ratifiedB64) {
    if (!ratifiedB64) return;
    var rf = global.fflate.inflateSync(fromBase64Url(ratifiedB64));
    result._ratifiedFrameRecord = parseFrame(rf);
  }

  // ── public encode ──────────────────────────────────────────────────────────────

  function encodeV2(record, opts) {
    if (!global.WPPathC) throw new Error('WPCodec: WPPathC not loaded — include pathc-v2.js before codec.js');
    opts = opts || {};
    if (opts.programmableRules == null && record && record.programmable_rules) {
      opts.programmableRules = record.programmable_rules;
    }
    var v1Frame = buildFrame(record, opts);
    var useBridge = opts.bridgeV1 === true;
    var inner = (useBridge || !global.WPPathCNative)
      ? global.WPPathC.wrapV1Frame(v1Frame, record, opts)
      : global.WPPathCNative.wrapNative(v1Frame, record, opts);
    var compressed = global.fflate.deflateSync(inner, { level: 9 });
    var url = URL_PREFIX + CODEBOOK_V2 + '/' + toBase64Url(compressed);
    if (opts.chain && opts.chainRef) {
      var cr = opts.chainRef;
      url += '&c=' + (typeof cr === 'string' ? cr : toBase64Url(new Uint8Array(cr)));
    }
    return appendRatifiedSuffix(url, opts.ratifiedFrameBytes);
  }

  function decodeV2(hash) {
    if (!global.WPPathC) throw new Error('WPCodec: WPPathC not loaded');
    var extras = parseHashExtras(hash);
    var inflated = global.fflate.inflateSync(fromBase64Url(extras.body.slice(4)));
    var unwrapped = (global.WPPathCNative && global.WPPathCNative.unwrapNative)
      ? global.WPPathCNative.unwrapNative(inflated)
      : global.WPPathC.unwrapToV1Frame(inflated);
    var result = parseFrame(unwrapped.v1Frame, null);
    global.WPPathC.attachMetaToRecord(result, unwrapped.meta, unwrapped.bridge);
    if (unwrapped.native) result._nativeGroups = true;
    if (unwrapped.groupLocalPrefix && unwrapped.decodedGroupLocal) {
      result._decodedGroupLocal = unwrapped.decodedGroupLocal;
    }
    if (extras.chainRef) result._chainRef = extras.chainRef;
    attachRatifiedFrameRecord(result, extras.ratifiedB64);
    return result;
  }

  function encode(record, opts) {
    opts = opts || {};
    if (opts.schemeTag === CODEBOOK_V2 || opts.codebook === CODEBOOK_V2 || opts.padsV2) {
      return encodeV2(record, opts);
    }
    var frame      = buildFrame(record, opts);
    var compressed = global.fflate.deflateSync(frame, { level: 9 });
    var tag = opts.presentationTag ? opts.presentationTag : CODEBOOK;
    var url = URL_PREFIX + tag + '/' + toBase64Url(compressed);
    if (opts.chain && opts.chainRef) {
      var cr = opts.chainRef;
      if (typeof cr === 'string') {
        url += '&c=' + cr;
      } else {
        url += '&c=' + toBase64Url(new Uint8Array(cr));
      }
    }
    return appendRatifiedSuffix(url, opts.ratifiedFrameBytes);
  }

  // ── public decode ──────────────────────────────────────────────────────────────

  function decode(url) {
    var hash = url.indexOf('#') !== -1 ? url.slice(url.indexOf('#') + 1) : url;

    // template install routing (#t/ and #te/)
    if (hash.slice(0, 2) === 't/')  return { _installTemplate: hash.slice(2),  encrypted: false };
    if (hash.slice(0, 3) === 'te/') return { _installTemplate: hash.slice(3), encrypted: true  };

    // Marker UID lookup (#1pm/<b64url(marker_uid_string)>)
    if (hash.slice(0, 4) === '1pm/') return { _markerUid: fromUtf8(fromBase64Url(hash.slice(4))) };

    // pads-v2 Path C bridge (#1pv/)
    if (hash.slice(0, 4) === '1pv/') {
      return decodeV2(hash);
    }

    // pads-v1 plain (#1pa/) and presentation (#1pb/, #1pf/, #1dt/ draft template QR)
    if (hash.slice(0, 4) === '1pa/' || hash.slice(0, 4) === '1pb/' || hash.slice(0, 4) === '1pf/' ||
        hash.slice(0, 4) === '1dt/') {
      var isPresentation = (hash.slice(0, 4) !== '1pa/');
      var extras = parseHashExtras(hash);
      var frame  = global.fflate.inflateSync(fromBase64Url(extras.body.slice(4)));
      var result = parseFrame(frame, isPresentation ? { presentation: true } : null);
      if (hash.slice(0, 4) === '1dt/') result._templateQr = true;
      if (extras.chainRef) result._chainRef = extras.chainRef;
      attachRatifiedFrameRecord(result, extras.ratifiedB64);
      return result;
    }

    // legacy codebook tags (#1eg/, #1cg/, #1dg/, #1ag/, #1bg/)
    if (/^[0-9][a-z][a-z]\//.test(hash)) {
      var tag    = hash.slice(0, 3);
      var frame2 = global.fflate.inflateSync(fromBase64Url(hash.slice(4)));
      if (tag === '1eg') return padsDecodeKaios(frame2);
      return padsDecodeLegacy(frame2, tag === '1cg' || tag === '1dg');
    }

    // legacy alg=bitpad-v1 (kaios v0.1)
    var params = {}; var segs = hash.split('&');
    for (var i = 0; i < segs.length; i++) {
      var eq = segs[i].indexOf('=');
      if (eq !== -1) params[segs[i].slice(0, eq)] = segs[i].slice(eq + 1);
    }
    if (params.d && params.alg === 'bitpad-v1') {
      return padsDecodeLegacy(global.fflate.inflateSync(fromBase64Url(params.d)), false);
    }

    throw new Error('WPCodec.decode: unrecognised URL format');
  }

  // ── validate ───────────────────────────────────────────────────────────────────

  function validate(record) {
    var errors = [];
    if (!record || typeof record !== 'object') return { valid: false, errors: ['record must be an object'] };
    if (!record.job || String(record.job).trim() === '') errors.push('job is required');
    var limits = {
      job: 120, customer: 120, location: 200, meeting_time: 40,
      start_time: 40, end_time: 40, customer_phone: 40, worker: 80,
      details: 500, story: 2000, ref_number: 255, context_label: 255,
      tag: 255, qty_unit: 64, attachment: 500, uid: 128, url: 500
    };
    var fields = Object.keys(limits);
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      if (record[field] != null) {
        var len = toUtf8(String(record[field])).length;
        if (len > limits[field]) errors.push(field + ' exceeds ' + limits[field] + ' bytes');
      }
    }
    return { valid: errors.length === 0, errors: errors };
  }

  // ── attachment field helpers ──────────────────────────────────────────────────
  // attachment field value: "t0:<thumbhash>:<content_url>[?t=<tiers>]" or bare URL
  // multi-image: comma-separated entries → array of parsed objects

  function parseSingleAttachment(str) {
    str = str.trim();
    var result = { tier0: null, contentUrl: '', availableTiers: [] };
    if (str.slice(0, 3) === 't0:') {
      var rest = str.slice(3);
      var sep  = rest.indexOf(':');
      if (sep === -1) { result.contentUrl = rest; return result; }
      result.tier0    = rest.slice(0, sep);
      var urlPart     = rest.slice(sep + 1);
      var qIdx        = urlPart.indexOf('?t=');
      if (qIdx !== -1) {
        var tParam  = urlPart.slice(qIdx + 3);
        urlPart     = urlPart.slice(0, qIdx);
        for (var ti = 0; ti < tParam.length; ti++) {
          var tn = parseInt(tParam[ti], 10);
          if (!isNaN(tn)) result.availableTiers.push(tn);
        }
      }
      result.contentUrl = urlPart;
    } else {
      result.contentUrl = str;
    }
    return result;
  }

  function parseAttachmentField(str) {
    if (!str || typeof str !== 'string') return null;
    if (str.indexOf(',') !== -1) return str.split(',').map(parseSingleAttachment);
    return parseSingleAttachment(str);
  }

  function formatAttachmentField(opts) {
    if (!opts || !opts.contentUrl) return '';
    if (!opts.tier0) return opts.contentUrl;
    var tiers = (opts.availableTiers && opts.availableTiers.length)
      ? '?t=' + opts.availableTiers.join('') : '';
    return 't0:' + opts.tier0 + ':' + opts.contentUrl + tiers;
  }

  // ── project tag helpers ───────────────────────────────────────────────────────
  // tag field value: comma-separated; project associations prefixed "proj:"

  function parseProjectTags(tagStr) {
    var result = { projectUids: [], freeTags: [] };
    if (!tagStr || typeof tagStr !== 'string') return result;
    var parts = tagStr.split(',');
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i].trim();
      if (!t) continue;
      if (t.slice(0, 5) === 'proj:') result.projectUids.push(t.slice(5));
      else                           result.freeTags.push(t);
    }
    return result;
  }

  // ── exports ────────────────────────────────────────────────────────────────────

  global.WPCodec = {
    encode:   encode,
    decode:   decode,
    encodeV2: encodeV2,
    decodeV2: decodeV2,
    validate: validate,
    CODEBOOK_V2: CODEBOOK_V2,
    parseAttachmentField:  parseAttachmentField,
    formatAttachmentField: formatAttachmentField,
    parseProjectTags:      parseProjectTags,
    // exposed for testing
    _buildFrame:             buildFrame,
    _parseFrame:             parseFrame,
    _parseFramePresentation: function(b) { return parseFrame(b, { presentation: true }); },
    _dateToDays:             dateToDays,
    _daysToDate:             daysToDate,
    _timeToMins:             timeToMinutes,
    _minsToTime:             minutesToTime,
    parseHashExtras:              parseHashExtras,
    appendRatifiedSuffix:         appendRatifiedSuffix,
    _attachRatifiedFrameRecord:   attachRatifiedFrameRecord
  };

}(window));
