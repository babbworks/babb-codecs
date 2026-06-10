// WPCodec — pads-v1 codec, codebooks a/b/c/d
// 1ag/ = codebook-a (legacy, base64url + deflate, decode only)
// 1bg/ = codebook-b (base64url + deflate — KaiOS compat, decode + encode)
// 1cg/ = codebook-c (base91 + deflate, binary date/amount, chainRef in frame — decode only)
// 1dg/ = codebook-d (base64url + deflate, same binary frame as 1cg/ — CURRENT default)
//
// 1dg/ is the current encode target. Identical frame to 1cg/ but base64url-encoded
// so the URL payload is A-Za-z0-9-_ only — safe in all messaging apps.
//
// 1cg/ vs 1bg/ frame changes (shared by 1dg/):
//   bit 2  (date):       uint16 days since 2020-01-01 (not length-prefixed UTF-8)
//   bit 13 (CHAIN_BIT):  3-byte raw chainRef embedded after FIN block (no &c= in URL)
//   FIN amount:          uint32 minor-currency units (not length-prefixed UTF-8)
//   FIN item amounts:    uint32 minor-currency units each
//   Actions:             per-action flags byte (bit 0 = notes present); notes omitted when empty
//
// Depends on: fflate UMD (window.fflate must be present before this file).
// Exposes: window.WPCodec = { encode, decode, validate }

(function(global) {
  'use strict';

  var URL_PREFIX = 'workpads.me/p#';

  // ── base64url ─────────────────────────────────────────────────────────────────

  function toBase64Url(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  function fromBase64Url(str) {
    var padded = str + '=='.slice(0, (4 - str.length % 4) % 4);
    var bin = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ── base91 (URL-safe variant) ─────────────────────────────────────────────────
  // Alphabet: printable ASCII 33-126 minus # (35), % (37), & (38) = 91 chars
  // Safe in URL hash fragments in all modern browsers.
  // Encoding: ~23% overhead vs base64url's ~33% overhead → ~7.5% shorter URLs.
  var B91 = '!"$\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';

  var B91_DECODE = (function () {
    var d = new Int8Array(128).fill(-1);
    for (var i = 0; i < B91.length; i++) d[B91.charCodeAt(i)] = i;
    return d;
  }());

  function toBase91(data) {
    var b = 0, n = 0, o = '';
    for (var i = 0; i < data.length; i++) {
      b |= (data[i] & 0xff) << n;
      n += 8;
      if (n > 13) {
        var v = b & 8191;
        if (v > 88) { b >>= 13; n -= 13; }
        else        { v = b & 16383; b >>= 14; n -= 14; }
        o += B91[v % 91] + B91[(v / 91) | 0];
      }
    }
    if (n) {
      o += B91[b % 91];
      if (n > 7 || b > 90) o += B91[(b / 91) | 0];
    }
    return o;
  }

  function fromBase91(str) {
    var v = -1, b = 0, n = 0, o = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      var p = (c < 128) ? B91_DECODE[c] : -1;
      if (p === -1) continue;
      if (v < 0) {
        v = p;
      } else {
        v += p * 91;
        b |= v << n;
        n += (v & 8191) > 88 ? 13 : 14;
        do { o.push(b & 0xff); b >>= 8; n -= 8; } while (n > 7);
        v = -1;
      }
    }
    if (v >= 0) o.push((b | (v << n)) & 0xff);
    return new Uint8Array(o);
  }

  // ── UTF-8 helpers ─────────────────────────────────────────────────────────────

  function toUtf8(str)   { return new TextEncoder().encode(str); }
  function fromUtf8(buf) { return new TextDecoder().decode(buf); }

  // WORKPADS_DICT was defined here for a planned 1cg/ preset-dictionary feature
  // but was never wired into the deflateSync call. Removed to avoid confusion.

  // ── Date encoding (1cg/ only) ────────────────────────────────────────────────
  // uint16 days since 2020-01-01. Range: 2020-01-01 to ~2199. 2 bytes vs 12 bytes.
  var DATE_EPOCH_MS = Date.UTC(2020, 0, 1);
  var MS_PER_DAY    = 86400000;

  function dateToU16(iso) {
    try {
      var ms   = Date.UTC(+iso.slice(0,4), +iso.slice(5,7)-1, +iso.slice(8,10));
      var days = Math.round((ms - DATE_EPOCH_MS) / MS_PER_DAY);
      return Math.max(0, Math.min(65535, days));
    } catch (e) { return 0; }
  }

  function u16ToDate(days) {
    var ms  = DATE_EPOCH_MS + days * MS_PER_DAY;
    var d   = new Date(ms);
    var y   = d.getUTCFullYear();
    var m   = ('0' + (d.getUTCMonth() + 1)).slice(-2);
    var day = ('0' + d.getUTCDate()).slice(-2);
    return y + '-' + m + '-' + day;
  }

  // ── Amount encoding (1cg/ only) ──────────────────────────────────────────────
  // uint32 minor currency units (pence/cents). Max: £42,949,672.95.
  // 1 unit = 1 cent/penny. 4 bytes vs typical 7-9 bytes for string representation.

  function amountToU32(s) {
    var n = parseFloat(s);
    if (!s || isNaN(n)) return 0;
    return (n * 100 + 0.5) | 0;   // round half-up
  }

  function u32ToAmount(u) {
    if (!u) return '0';
    var pence  = u % 100;
    var pounds = (u - pence) / 100;
    if (!pence) return String(pounds);
    return pounds + '.' + (pence < 10 ? '0' : '') + pence;
  }

  // ── frame constants ───────────────────────────────────────────────────────────

  var TEMPLATE_SVC_BASIC = 0x01;
  var ACTIONS_BIT        = 9;
  var FIN_BIT            = 12;
  var CHAIN_BIT          = 13;  // 1cg/ only: chainRef embedded in frame
  var MAX_ACTIONS        = 20;

  // ── codebook-b/c scalar fields (bits 0–11) ────────────────────────────────────

  var SCALAR_FIELDS = [
    { id: 'job',            bit: 0  },
    { id: 'customer',       bit: 1  },
    { id: 'date',           bit: 2  },  // 1cg/: uint16; 1bg/: UTF-8 string
    { id: 'location',       bit: 3  },
    { id: 'meeting_time',   bit: 4  },
    { id: 'start_time',     bit: 5  },
    { id: 'end_time',       bit: 6  },
    { id: 'customer_phone', bit: 7  },
    { id: 'worker',         bit: 8  },
    // bit 9  = actions blob
    { id: 'details',        bit: 10 },
    { id: 'story',          bit: 11 },
    // bit 12 = FIN_BIT
    // bit 13 = CHAIN_BIT (1cg/ only)
    // bits 14-15 reserved
  ];

  // Codebook-a used bits 12-15 for financial scalars; kept for decode compat
  var SCALAR_FIELDS_A = SCALAR_FIELDS.concat([
    { id: 'amount',      bit: 12 },
    { id: 'currency',    bit: 13 },
    { id: 'vat',         bit: 14 },
    { id: 'record_type', bit: 15 },
  ]);

  // ── financial block enums ─────────────────────────────────────────────────────
  // 'job' is the default record_type — not written; decoder returns 'job' when absent.
  var RECORD_TYPES  = ['quote', 'invoice', 'expense', 'payment'];
  var CURRENCIES    = ['GBP', 'USD', 'EUR', 'CAD', 'AUD', 'NZD', 'ZAR'];
  var VAT_RATES     = ['0', '5', '7.5', '10', '12.5', '15', '20', '23', '25'];
  var BILLING_TYPES = ['billable', 'non-billable', 'absorbed', 'cogs'];

  // ── write/read helpers ────────────────────────────────────────────────────────

  function writeU16(buf, offset, val) {
    buf[offset]     = (val >>> 8) & 0xff;
    buf[offset + 1] = val         & 0xff;
  }

  function readU16(buf, offset) {
    return ((buf[offset] & 0xff) << 8) | (buf[offset + 1] & 0xff);
  }

  function writeU32(buf, offset, val) {
    buf[offset]     = (val >>> 24) & 0xff;
    buf[offset + 1] = (val >>> 16) & 0xff;
    buf[offset + 2] = (val >>> 8)  & 0xff;
    buf[offset + 3] = val          & 0xff;
  }

  function readU32(buf, offset) {
    return ((buf[offset] & 0xff) * 0x1000000) +
           ((buf[offset + 1] & 0xff) << 16) +
           ((buf[offset + 2] & 0xff) << 8) +
            (buf[offset + 3] & 0xff);
  }

  function enumIdx(arr, val) {
    var i = arr.indexOf(val);
    return i === -1 ? 255 : i;
  }

  // ── codebook-b encoder ────────────────────────────────────────────────────────

  function padsEncodeB(record, expenses, payments) {
    expenses = expenses || [];
    payments = payments || [];

    var flags = 0;
    var scalarBytes = {};
    for (var i = 0; i < SCALAR_FIELDS.length; i++) {
      var f = SCALAR_FIELDS[i];
      var val = record[f.id];
      if (val != null && val !== '') {
        var b = toUtf8(String(val));
        scalarBytes[f.id] = b;
        flags |= (1 << f.bit);
      }
    }

    var actionItems = Array.isArray(record.actions) ? record.actions.slice(0, MAX_ACTIONS) : [];
    if (actionItems.length) flags |= (1 << ACTIONS_BIT);

    var withFin = !!(
      (record.record_type && record.record_type !== 'job') ||
      record.currency || record.vat || record.amount ||
      expenses.length || payments.length
    );
    if (withFin) flags |= (1 << FIN_BIT);

    var finFlagsByte = 0;
    var rtIdx = -1, curIdx = -1, vatIdx = -1;
    var curCustom = null, vatCustom = null, amtBytes = null;
    var expItems = [], payItems = [];

    if (withFin) {
      if (record.record_type && record.record_type !== 'job') {
        rtIdx = RECORD_TYPES.indexOf(record.record_type);
        if (rtIdx !== -1) finFlagsByte |= 0x01;
      }
      if (record.currency) {
        finFlagsByte |= 0x02;
        curIdx = enumIdx(CURRENCIES, record.currency);
        if (curIdx === 255) curCustom = toUtf8(String(record.currency));
      }
      if (record.vat != null) {
        finFlagsByte |= 0x04;
        vatIdx = enumIdx(VAT_RATES, String(record.vat));
        if (vatIdx === 255) vatCustom = toUtf8(String(record.vat));
      }
      if (record.amount != null) {
        finFlagsByte |= 0x08;
        amtBytes = toUtf8(String(record.amount));
      }
      if (expenses.length) {
        finFlagsByte |= 0x10;
        for (var ei = 0; ei < expenses.length; ei++) {
          var e = expenses[ei];
          var eflags = 0;
          var eamt  = toUtf8(String(e.amount || '0'));
          var ejob  = null, edate = null, ebilling = -1, eaidx = -1;
          if (e.job)   { eflags |= 0x01; ejob  = toUtf8(String(e.job)); }
          if (e.date)  { eflags |= 0x02; edate = toUtf8(String(e.date)); }
          var bval = e.expense_billing;
          if (bval) { ebilling = BILLING_TYPES.indexOf(bval); if (ebilling !== -1) eflags |= 0x04; }
          if (e.actionIdx != null && e.actionIdx >= 0 && e.actionIdx <= 19) { eflags |= 0x08; eaidx = e.actionIdx; }
          if (e.is_viewer) eflags |= 0x10;
          expItems.push({ flags: eflags, amt: eamt, job: ejob, date: edate, billing: ebilling, aidx: eaidx });
        }
      }
      if (payments.length) {
        finFlagsByte |= 0x20;
        for (var pi = 0; pi < payments.length; pi++) {
          var p = payments[pi];
          var pflags = 0;
          var pamt  = toUtf8(String(p.amount || '0'));
          var pjob  = null, pdate = null;
          if (p.job)  { pflags |= 0x01; pjob  = toUtf8(String(p.job)); }
          if (p.date) { pflags |= 0x02; pdate = toUtf8(String(p.date)); }
          payItems.push({ flags: pflags, amt: pamt, job: pjob, date: pdate });
        }
      }
    }

    // size pass
    var size = 3;
    for (var j = 0; j < SCALAR_FIELDS.length; j++) {
      var sf = SCALAR_FIELDS[j];
      if (sf.bit < ACTIONS_BIT && scalarBytes[sf.id]) size += 2 + scalarBytes[sf.id].length;
    }
    if (actionItems.length) {
      size += 1;
      for (var k = 0; k < actionItems.length; k++) {
        var ta = toUtf8(actionItems[k].title || '');
        var na = toUtf8(actionItems[k].notes || '');
        size += 2 + ta.length + 2 + na.length;
      }
    }
    for (var m = 0; m < SCALAR_FIELDS.length; m++) {
      var pfs = SCALAR_FIELDS[m];
      if (pfs.bit > ACTIONS_BIT && pfs.bit < FIN_BIT && scalarBytes[pfs.id]) size += 2 + scalarBytes[pfs.id].length;
    }
    if (withFin) {
      size += 1;
      if (finFlagsByte & 0x01) size += 1;
      if (finFlagsByte & 0x02) { size += 1; if (curIdx === 255) size += 2 + curCustom.length; }
      if (finFlagsByte & 0x04) { size += 1; if (vatIdx === 255) size += 2 + vatCustom.length; }
      if (finFlagsByte & 0x08) size += 2 + amtBytes.length;
      if (finFlagsByte & 0x10) {
        size += 1;
        for (var ei2 = 0; ei2 < expItems.length; ei2++) {
          var ed = expItems[ei2];
          size += 1 + 2 + ed.amt.length;
          if (ed.flags & 0x01) size += 2 + ed.job.length;
          if (ed.flags & 0x02) size += 2 + ed.date.length;
          if (ed.flags & 0x04) size += 1;
          if (ed.flags & 0x08) size += 1;
        }
      }
      if (finFlagsByte & 0x20) {
        size += 1;
        for (var pi2 = 0; pi2 < payItems.length; pi2++) {
          var pd = payItems[pi2];
          size += 1 + 2 + pd.amt.length;
          if (pd.flags & 0x01) size += 2 + pd.job.length;
          if (pd.flags & 0x02) size += 2 + pd.date.length;
        }
      }
    }

    // write pass
    var buf = new Uint8Array(size);
    var pos = 0;

    buf[pos++] = TEMPLATE_SVC_BASIC;
    writeU16(buf, pos, flags); pos += 2;

    function writeField(bytes) {
      writeU16(buf, pos, bytes.length); pos += 2;
      buf.set(bytes, pos); pos += bytes.length;
    }

    for (var a = 0; a < SCALAR_FIELDS.length; a++) {
      var asf = SCALAR_FIELDS[a];
      if (asf.bit < ACTIONS_BIT && scalarBytes[asf.id]) writeField(scalarBytes[asf.id]);
    }
    if (actionItems.length) {
      buf[pos++] = actionItems.length;
      for (var ai = 0; ai < actionItems.length; ai++) {
        writeField(toUtf8(actionItems[ai].title || ''));
        writeField(toUtf8(actionItems[ai].notes || ''));
      }
    }
    for (var n2 = 0; n2 < SCALAR_FIELDS.length; n2++) {
      var nsf = SCALAR_FIELDS[n2];
      if (nsf.bit > ACTIONS_BIT && nsf.bit < FIN_BIT && scalarBytes[nsf.id]) writeField(scalarBytes[nsf.id]);
    }
    if (withFin) {
      buf[pos++] = finFlagsByte;
      if (finFlagsByte & 0x01) buf[pos++] = rtIdx;
      if (finFlagsByte & 0x02) { buf[pos++] = curIdx; if (curIdx === 255) writeField(curCustom); }
      if (finFlagsByte & 0x04) { buf[pos++] = vatIdx; if (vatIdx === 255) writeField(vatCustom); }
      if (finFlagsByte & 0x08) writeField(amtBytes);
      if (finFlagsByte & 0x10) {
        buf[pos++] = expItems.length;
        for (var ex = 0; ex < expItems.length; ex++) {
          var ed2 = expItems[ex];
          buf[pos++] = ed2.flags;
          writeField(ed2.amt);
          if (ed2.flags & 0x01) writeField(ed2.job);
          if (ed2.flags & 0x02) writeField(ed2.date);
          if (ed2.flags & 0x04) buf[pos++] = ed2.billing;
          if (ed2.flags & 0x08) buf[pos++] = ed2.aidx;
        }
      }
      if (finFlagsByte & 0x20) {
        buf[pos++] = payItems.length;
        for (var px = 0; px < payItems.length; px++) {
          var pd2 = payItems[px];
          buf[pos++] = pd2.flags;
          writeField(pd2.amt);
          if (pd2.flags & 0x01) writeField(pd2.job);
          if (pd2.flags & 0x02) writeField(pd2.date);
        }
      }
    }

    return buf;
  }

  // ── codebook-c encoder ────────────────────────────────────────────────────────
  // Changes vs padsEncodeB:
  //   - date: uint16 days (2 bytes, no length prefix)
  //   - chainRef: 3 raw bytes at bit 13 (after FIN block)
  //   - FIN amount + item amounts: uint32 (4 bytes, no length prefix)
  //   - Actions: per-action flags byte; notes field only if non-empty

  function padsEncodeC(record, expenses, payments, chainRef) {
    expenses = expenses || [];
    payments = payments || [];

    var flags = 0;
    var scalarBytes = {};

    // Date handled separately (uint16 encoding)
    var dateU16 = null;
    if (record.date && record.date !== '') {
      dateU16 = dateToU16(record.date);
      flags |= (1 << 2);
    }

    // Other scalar fields (skip date bit 2)
    for (var i = 0; i < SCALAR_FIELDS.length; i++) {
      var f = SCALAR_FIELDS[i];
      if (f.bit === 2) continue;
      var val = record[f.id];
      if (val != null && val !== '') {
        var b = toUtf8(String(val));
        scalarBytes[f.id] = b;
        flags |= (1 << f.bit);
      }
    }

    // Actions
    var actionItems = Array.isArray(record.actions) ? record.actions.slice(0, MAX_ACTIONS) : [];
    if (actionItems.length) flags |= (1 << ACTIONS_BIT);

    // ChainRef (bit 13)
    var chainBuf = null;
    if (chainRef) {
      try {
        var cb = fromBase64Url(chainRef);
        if (cb.length >= 3) { chainBuf = cb.subarray(0, 3); flags |= (1 << CHAIN_BIT); }
      } catch (e) {}
    }

    // FIN block
    var withFin = !!(
      (record.record_type && record.record_type !== 'job') ||
      record.currency || record.vat || (record.amount != null && record.amount !== '') ||
      expenses.length || payments.length
    );
    if (withFin) flags |= (1 << FIN_BIT);

    var finFlagsByte = 0;
    var rtIdx = -1, curIdx = -1, vatIdx = -1;
    var curCustom = null, vatCustom = null, amtU32 = 0, hasAmt = false;
    var expItems = [], payItems = [];

    if (withFin) {
      if (record.record_type && record.record_type !== 'job') {
        rtIdx = RECORD_TYPES.indexOf(record.record_type);
        if (rtIdx !== -1) finFlagsByte |= 0x01;
      }
      if (record.currency) {
        finFlagsByte |= 0x02;
        curIdx = enumIdx(CURRENCIES, record.currency);
        if (curIdx === 255) curCustom = toUtf8(String(record.currency));
      }
      if (record.vat != null && record.vat !== '') {
        finFlagsByte |= 0x04;
        vatIdx = enumIdx(VAT_RATES, String(record.vat));
        if (vatIdx === 255) vatCustom = toUtf8(String(record.vat));
      }
      if (record.amount != null && record.amount !== '') {
        finFlagsByte |= 0x08;
        amtU32 = amountToU32(record.amount);
        hasAmt = true;
      }
      if (expenses.length) {
        finFlagsByte |= 0x10;
        for (var ei = 0; ei < expenses.length; ei++) {
          var e = expenses[ei];
          var eflags = 0;
          var eamt   = amountToU32(e.amount || '0');
          var ejob   = null, edate = null, ebilling = -1, eaidx = -1;
          if (e.job)   { eflags |= 0x01; ejob  = toUtf8(String(e.job)); }
          if (e.date)  { eflags |= 0x02; edate = toUtf8(String(e.date)); }
          var bval = e.expense_billing;
          if (bval) { ebilling = BILLING_TYPES.indexOf(bval); if (ebilling !== -1) eflags |= 0x04; }
          if (e.actionIdx != null && e.actionIdx >= 0 && e.actionIdx <= 19) { eflags |= 0x08; eaidx = e.actionIdx; }
          if (e.is_viewer) eflags |= 0x10;
          expItems.push({ flags: eflags, amt: eamt, job: ejob, date: edate, billing: ebilling, aidx: eaidx });
        }
      }
      if (payments.length) {
        finFlagsByte |= 0x20;
        for (var pi = 0; pi < payments.length; pi++) {
          var p = payments[pi];
          var pflags = 0;
          var pamt   = amountToU32(p.amount || '0');
          var pjob   = null, pdate = null;
          if (p.job)  { pflags |= 0x01; pjob  = toUtf8(String(p.job)); }
          if (p.date) { pflags |= 0x02; pdate = toUtf8(String(p.date)); }
          payItems.push({ flags: pflags, amt: pamt, job: pjob, date: pdate });
        }
      }
    }

    // Pre-compute action data for size pass
    var actData = actionItems.map(function (a) {
      var t    = toUtf8(a.title || '');
      var nStr = (a.notes || '').trim();
      var n    = nStr ? toUtf8(nStr) : null;
      return { title: t, notes: n };
    });

    // size pass
    var size = 3; // template + 2-byte flags

    // Scalars bit 0-1 (before date at bit 2)
    for (var j = 0; j < SCALAR_FIELDS.length; j++) {
      var sf = SCALAR_FIELDS[j];
      if (sf.bit >= ACTIONS_BIT || sf.bit === 2) continue;
      if (sf.bit < 2 && scalarBytes[sf.id]) size += 2 + scalarBytes[sf.id].length;
    }
    // Date: 2 bytes (uint16)
    if (dateU16 !== null) size += 2;
    // Scalars bit 3-8
    for (var j2 = 0; j2 < SCALAR_FIELDS.length; j2++) {
      var sf2 = SCALAR_FIELDS[j2];
      if (sf2.bit <= 2 || sf2.bit >= ACTIONS_BIT) continue;
      if (scalarBytes[sf2.id]) size += 2 + scalarBytes[sf2.id].length;
    }
    // Actions
    if (actData.length) {
      size += 1; // count
      for (var k = 0; k < actData.length; k++) {
        var ad = actData[k];
        size += 1;                         // per-action flags
        size += 2 + ad.title.length;       // title field
        if (ad.notes) size += 2 + ad.notes.length; // notes field (conditional)
      }
    }
    // Scalars bit 10-11 (details, story)
    for (var m = 0; m < SCALAR_FIELDS.length; m++) {
      var pfs = SCALAR_FIELDS[m];
      if (pfs.bit > ACTIONS_BIT && pfs.bit < FIN_BIT && scalarBytes[pfs.id]) size += 2 + scalarBytes[pfs.id].length;
    }
    // FIN block (bit 12)
    if (withFin) {
      size += 1; // finFlagsByte
      if (finFlagsByte & 0x01) size += 1;
      if (finFlagsByte & 0x02) { size += 1; if (curIdx === 255) size += 2 + curCustom.length; }
      if (finFlagsByte & 0x04) { size += 1; if (vatIdx === 255) size += 2 + vatCustom.length; }
      if (finFlagsByte & 0x08) size += 4; // uint32
      if (finFlagsByte & 0x10) {
        size += 1; // expense count
        for (var ei2 = 0; ei2 < expItems.length; ei2++) {
          var ed = expItems[ei2];
          size += 1 + 4; // flags + uint32 amount
          if (ed.flags & 0x01) size += 2 + ed.job.length;
          if (ed.flags & 0x02) size += 2 + ed.date.length;
          if (ed.flags & 0x04) size += 1;
          if (ed.flags & 0x08) size += 1;
        }
      }
      if (finFlagsByte & 0x20) {
        size += 1; // payment count
        for (var pi2 = 0; pi2 < payItems.length; pi2++) {
          var pd = payItems[pi2];
          size += 1 + 4; // flags + uint32 amount
          if (pd.flags & 0x01) size += 2 + pd.job.length;
          if (pd.flags & 0x02) size += 2 + pd.date.length;
        }
      }
    }
    // ChainRef (bit 13): 3 bytes
    if (chainBuf) size += 3;

    // write pass
    var buf = new Uint8Array(size);
    var pos = 0;

    buf[pos++] = TEMPLATE_SVC_BASIC;
    writeU16(buf, pos, flags); pos += 2;

    function writeField(bytes) {
      writeU16(buf, pos, bytes.length); pos += 2;
      buf.set(bytes, pos); pos += bytes.length;
    }

    // bit 0 (job), bit 1 (customer)
    for (var a = 0; a < SCALAR_FIELDS.length; a++) {
      var asf = SCALAR_FIELDS[a];
      if (asf.bit < 2 && scalarBytes[asf.id]) writeField(scalarBytes[asf.id]);
    }
    // bit 2 (date): uint16
    if (dateU16 !== null) { writeU16(buf, pos, dateU16); pos += 2; }
    // bits 3-8
    for (var a2 = 0; a2 < SCALAR_FIELDS.length; a2++) {
      var asf2 = SCALAR_FIELDS[a2];
      if (asf2.bit > 2 && asf2.bit < ACTIONS_BIT && scalarBytes[asf2.id]) writeField(scalarBytes[asf2.id]);
    }
    // bit 9 (actions)
    if (actData.length) {
      buf[pos++] = actData.length;
      for (var ai = 0; ai < actData.length; ai++) {
        var ad2 = actData[ai];
        var aFlags = ad2.notes ? 0x01 : 0x00;
        buf[pos++] = aFlags;
        writeField(ad2.title);
        if (ad2.notes) writeField(ad2.notes);
      }
    }
    // bits 10-11 (details, story)
    for (var n2 = 0; n2 < SCALAR_FIELDS.length; n2++) {
      var nsf = SCALAR_FIELDS[n2];
      if (nsf.bit > ACTIONS_BIT && nsf.bit < FIN_BIT && scalarBytes[nsf.id]) writeField(scalarBytes[nsf.id]);
    }
    // bit 12 (FIN block)
    if (withFin) {
      buf[pos++] = finFlagsByte;
      if (finFlagsByte & 0x01) buf[pos++] = rtIdx;
      if (finFlagsByte & 0x02) { buf[pos++] = curIdx; if (curIdx === 255) writeField(curCustom); }
      if (finFlagsByte & 0x04) { buf[pos++] = vatIdx; if (vatIdx === 255) writeField(vatCustom); }
      if (finFlagsByte & 0x08) { writeU32(buf, pos, amtU32); pos += 4; }
      if (finFlagsByte & 0x10) {
        buf[pos++] = expItems.length;
        for (var ex = 0; ex < expItems.length; ex++) {
          var ed3 = expItems[ex];
          buf[pos++] = ed3.flags;
          writeU32(buf, pos, ed3.amt); pos += 4;
          if (ed3.flags & 0x01) writeField(ed3.job);
          if (ed3.flags & 0x02) writeField(ed3.date);
          if (ed3.flags & 0x04) buf[pos++] = ed3.billing;
          if (ed3.flags & 0x08) buf[pos++] = ed3.aidx;
        }
      }
      if (finFlagsByte & 0x20) {
        buf[pos++] = payItems.length;
        for (var px = 0; px < payItems.length; px++) {
          var pd3 = payItems[px];
          buf[pos++] = pd3.flags;
          writeU32(buf, pos, pd3.amt); pos += 4;
          if (pd3.flags & 0x01) writeField(pd3.job);
          if (pd3.flags & 0x02) writeField(pd3.date);
        }
      }
    }
    // bit 13 (chainRef)
    if (chainBuf) { buf.set(chainBuf, pos); pos += 3; }

    return buf;
  }

  // ── codebook-b decoder ────────────────────────────────────────────────────────

  function padsDecodeB(bytes) {
    if (bytes.length < 3) throw new Error('WPCodec: frame too short');
    var pos = 0;
    var templateId = bytes[pos++];
    if (templateId !== TEMPLATE_SVC_BASIC) throw new Error('WPCodec: unknown template 0x' + templateId.toString(16));
    var flags = readU16(bytes, pos); pos += 2;
    var record = {};

    function readField() {
      var len = readU16(bytes, pos); pos += 2;
      var text = fromUtf8(bytes.subarray(pos, pos + len)); pos += len;
      return text;
    }

    for (var i = 0; i < SCALAR_FIELDS.length; i++) {
      var f = SCALAR_FIELDS[i];
      if (f.bit < ACTIONS_BIT && (flags & (1 << f.bit))) record[f.id] = readField();
    }
    if (flags & (1 << ACTIONS_BIT)) {
      var count = bytes[pos++];
      var actions = [];
      for (var k = 0; k < count; k++) actions.push({ title: readField(), notes: readField() });
      record.actions = actions;
    }
    for (var j = 0; j < SCALAR_FIELDS.length; j++) {
      var sf = SCALAR_FIELDS[j];
      if (sf.bit > ACTIONS_BIT && sf.bit < FIN_BIT && (flags & (1 << sf.bit))) record[sf.id] = readField();
    }
    if (flags & (1 << FIN_BIT)) {
      var finFlags = bytes[pos++];
      record.record_type = 'job';
      if (finFlags & 0x01) { var ri = bytes[pos++]; record.record_type = RECORD_TYPES[ri] || 'job'; }
      if (finFlags & 0x02) {
        var ci = bytes[pos++];
        record.currency = ci === 255 ? readField() : (CURRENCIES[ci] || '');
      }
      if (finFlags & 0x04) {
        var vi = bytes[pos++];
        record.vat = vi === 255 ? readField() : (VAT_RATES[vi] || '');
      }
      if (finFlags & 0x08) record.amount = readField();
      if (finFlags & 0x10) {
        var ec = bytes[pos++];
        var exps = [];
        for (var ei = 0; ei < ec; ei++) {
          var eflags = bytes[pos++];
          var exp = { amount: readField() };
          if (eflags & 0x01) exp.job             = readField();
          if (eflags & 0x02) exp.date            = readField();
          if (eflags & 0x04) exp.expense_billing = BILLING_TYPES[bytes[pos++]] || 'billable';
          if (eflags & 0x08) exp.actionIdx       = bytes[pos++];
          if (eflags & 0x10) exp.is_viewer        = true;
          exps.push(exp);
        }
        record._expenses = exps;
      }
      if (finFlags & 0x20) {
        var pc = bytes[pos++];
        var pays = [];
        for (var pi = 0; pi < pc; pi++) {
          var pflags = bytes[pos++];
          var pay = { amount: readField() };
          if (pflags & 0x01) pay.job  = readField();
          if (pflags & 0x02) pay.date = readField();
          pays.push(pay);
        }
        record._payments = pays;
      }
    }
    return record;
  }

  // ── codebook-c decoder ────────────────────────────────────────────────────────

  function padsDecodeC(bytes) {
    if (bytes.length < 3) throw new Error('WPCodec: frame too short');
    var pos = 0;
    var templateId = bytes[pos++];
    if (templateId !== TEMPLATE_SVC_BASIC) throw new Error('WPCodec: unknown template 0x' + templateId.toString(16));
    var flags = readU16(bytes, pos); pos += 2;
    var record = {};

    function readField() {
      var len = readU16(bytes, pos); pos += 2;
      var text = fromUtf8(bytes.subarray(pos, pos + len)); pos += len;
      return text;
    }

    // bits 0-1 (job, customer) — UTF-8 string fields
    for (var i = 0; i < SCALAR_FIELDS.length; i++) {
      var f = SCALAR_FIELDS[i];
      if (f.bit >= 2) break;
      if (flags & (1 << f.bit)) record[f.id] = readField();
    }
    // bit 2 (date) — uint16
    if (flags & (1 << 2)) { record.date = u16ToDate(readU16(bytes, pos)); pos += 2; }
    // bits 3-8 — UTF-8 string fields
    for (var i2 = 0; i2 < SCALAR_FIELDS.length; i2++) {
      var f2 = SCALAR_FIELDS[i2];
      if (f2.bit <= 2 || f2.bit >= ACTIONS_BIT) continue;
      if (flags & (1 << f2.bit)) record[f2.id] = readField();
    }
    // bit 9 (actions) — 1cg format: per-action flags byte, conditional notes
    if (flags & (1 << ACTIONS_BIT)) {
      var count = bytes[pos++];
      var actions = [];
      for (var k = 0; k < count; k++) {
        var aFlags = bytes[pos++];
        var title  = readField();
        var notes  = (aFlags & 0x01) ? readField() : '';
        actions.push({ title: title, notes: notes });
      }
      record.actions = actions;
    }
    // bits 10-11 (details, story) — UTF-8 string fields
    for (var j = 0; j < SCALAR_FIELDS.length; j++) {
      var sf = SCALAR_FIELDS[j];
      if (sf.bit > ACTIONS_BIT && sf.bit < FIN_BIT && (flags & (1 << sf.bit))) record[sf.id] = readField();
    }
    // bit 12 (FIN block) — amounts as uint32
    if (flags & (1 << FIN_BIT)) {
      var finFlags = bytes[pos++];
      record.record_type = 'job';
      if (finFlags & 0x01) { var ri = bytes[pos++]; record.record_type = RECORD_TYPES[ri] || 'job'; }
      if (finFlags & 0x02) {
        var ci = bytes[pos++];
        record.currency = ci === 255 ? readField() : (CURRENCIES[ci] || '');
      }
      if (finFlags & 0x04) {
        var vi = bytes[pos++];
        record.vat = vi === 255 ? readField() : (VAT_RATES[vi] || '');
      }
      if (finFlags & 0x08) { record.amount = u32ToAmount(readU32(bytes, pos)); pos += 4; }
      if (finFlags & 0x10) {
        var ec = bytes[pos++];
        var exps = [];
        for (var ei = 0; ei < ec; ei++) {
          var eflags = bytes[pos++];
          var exp = { amount: u32ToAmount(readU32(bytes, pos)) }; pos += 4;
          if (eflags & 0x01) exp.job             = readField();
          if (eflags & 0x02) exp.date            = readField();
          if (eflags & 0x04) exp.expense_billing = BILLING_TYPES[bytes[pos++]] || 'billable';
          if (eflags & 0x08) exp.actionIdx       = bytes[pos++];
          if (eflags & 0x10) exp.is_viewer        = true;
          exps.push(exp);
        }
        record._expenses = exps;
      }
      if (finFlags & 0x20) {
        var pc = bytes[pos++];
        var pays = [];
        for (var pi = 0; pi < pc; pi++) {
          var pflags = bytes[pos++];
          var pay = { amount: u32ToAmount(readU32(bytes, pos)) }; pos += 4;
          if (pflags & 0x01) pay.job  = readField();
          if (pflags & 0x02) pay.date = readField();
          pays.push(pay);
        }
        record._payments = pays;
      }
    }
    // bit 13 (chainRef): 3 raw bytes → base64url string
    if (flags & (1 << CHAIN_BIT)) {
      record._chainRef = toBase64Url(bytes.subarray(pos, pos + 3));
      pos += 3;
    }
    return record;
  }

  // ── codebook-a decoder (backwards compatibility for 1ag/ URLs) ───────────────

  function padsDecodeA(bytes) {
    if (bytes.length < 3) throw new Error('WPCodec: frame too short');
    var pos = 0;
    if (bytes[pos++] !== TEMPLATE_SVC_BASIC) throw new Error('WPCodec: unknown template');
    var flags = readU16(bytes, pos); pos += 2;
    var record = {};

    function readField() {
      var len = readU16(bytes, pos); pos += 2;
      var text = fromUtf8(bytes.subarray(pos, pos + len)); pos += len;
      return text;
    }

    for (var i = 0; i < SCALAR_FIELDS_A.length; i++) {
      var f = SCALAR_FIELDS_A[i];
      if (f.bit < ACTIONS_BIT && (flags & (1 << f.bit))) record[f.id] = readField();
    }
    if (flags & (1 << ACTIONS_BIT)) {
      var count = bytes[pos++];
      var actions = [];
      for (var k = 0; k < count; k++) actions.push({ title: readField(), notes: readField() });
      record.actions = actions;
    }
    for (var j = 0; j < SCALAR_FIELDS_A.length; j++) {
      var sf = SCALAR_FIELDS_A[j];
      if (sf.bit > ACTIONS_BIT && (flags & (1 << sf.bit))) record[sf.id] = readField();
    }
    return record;
  }

  // ── public API ────────────────────────────────────────────────────────────────

  // encode(record, opts) — produces 1dg/ (base64url + 1cg-frame)
  // URL payload is A-Za-z0-9-_ only — safe in all messaging apps.
  // chainRef is embedded in the frame; no &c= suffix.
  // opts: string (chainRef) | null | { chainRef, expenses, payments }
  function encode(record, opts) {
    var chainRef = null, expenses = [], payments = [];
    if (typeof opts === 'string' || opts === null || opts === undefined) {
      chainRef = opts || null;
    } else {
      chainRef  = opts.chainRef  || null;
      expenses  = opts.expenses  || [];
      payments  = opts.payments  || [];
    }
    var frame      = padsEncodeC(record, expenses, payments, chainRef);
    var compressed = global.fflate.deflateSync(frame, { level: 9 });
    return URL_PREFIX + '1dg/' + toBase64Url(compressed);
  }

  // encodeLegacy(record, opts) — produces 1bg/ (base64url, 1bg-frame) for KaiOS compat
  function encodeLegacy(record, opts) {
    var chainRef = null, expenses = [], payments = [];
    if (typeof opts === 'string' || opts === null || opts === undefined) {
      chainRef = opts || null;
    } else {
      chainRef  = opts.chainRef  || null;
      expenses  = opts.expenses  || [];
      payments  = opts.payments  || [];
    }
    var frame      = padsEncodeB(record, expenses, payments);
    var compressed = global.fflate.deflateSync(frame, { level: 9 });
    var url        = URL_PREFIX + '1bg/' + toBase64Url(compressed);
    if (chainRef) url += '&c=' + chainRef;
    return url;
  }

  // decode(url) — routes 1ag/ → A, 1bg/ → B, 1cg/ → C (legacy), 1dg/ → C (current)
  function decode(url) {
    var hash = url.indexOf('#') !== -1 ? url.slice(url.indexOf('#') + 1) : url;
    if (!/^[0-9][a-z][a-z]\//.test(hash)) throw new Error('WPCodec.decode: unrecognised format');
    var tag = hash.slice(0, 3);
    var record;

    if (tag === '1cg' || tag === '1dg') {
      // 1cg/: base91-encoded (legacy); 1dg/: base64url-encoded (current)
      // Both use the same 1cg-frame: binary date, binary amounts, chainRef in frame
      var rawBytes   = (tag === '1cg') ? fromBase91(hash.slice(4)) : fromBase64Url(hash.slice(4));
      var frame      = global.fflate.inflateSync(rawBytes);
      record = padsDecodeC(frame);
    } else {
      // 1ag/ or 1bg/: base64url, 1bg-frame; chainRef in &c= param
      var segments = hash.split('&');
      var payload  = segments[0];
      var chainRef = null;
      for (var i = 1; i < segments.length; i++) {
        var eq = segments[i].indexOf('=');
        if (eq !== -1 && segments[i].slice(0, eq) === 'c') chainRef = segments[i].slice(eq + 1);
      }
      var cmp2   = fromBase64Url(payload.slice(4));
      var frame2 = global.fflate.inflateSync(cmp2);
      record = (tag === '1ag') ? padsDecodeA(frame2) : padsDecodeB(frame2);
      if (chainRef) record._chainRef = chainRef;
    }

    return record;
  }

  function validate(record) {
    var errors = [];
    if (!record || typeof record !== 'object') return { valid: false, errors: ['record must be an object'] };
    if (!record.job || String(record.job).trim() === '') errors.push('job is required');
    var limits = {
      job: 120, customer: 120, date: 10, location: 160,
      meeting_time: 40, start_time: 40, end_time: 40,
      customer_phone: 40, worker: 80, details: 500, story: 2000,
    };
    Object.keys(limits).forEach(function (field) {
      if (record[field] != null) {
        var len = toUtf8(String(record[field])).length;
        if (len > limits[field]) errors.push(field + ' exceeds ' + limits[field] + ' bytes');
      }
    });
    if (record.actions != null) {
      if (!Array.isArray(record.actions)) errors.push('actions must be an array');
      else if (record.actions.length > MAX_ACTIONS) errors.push('actions exceeds ' + MAX_ACTIONS + ' items');
    }
    return { valid: errors.length === 0, errors: errors };
  }

  global.WPCodec = { encode: encode, encodeLegacy: encodeLegacy, decode: decode, validate: validate };

}(window));
