// native-v1-split.js — native G0–G6 field bodies (phase 2b)
// Spec: system/dev_refs/NATIVE-GROUPS-TABLE.md §4–§5
(function(global) {
  'use strict';

  var NG = global.WPNativeGroups;
  var PRG_TAG = global.WPProgrammableRules ? global.WPProgrammableRules.TAG : 0x50;

  var FIELDS = [
    { bit: 0, type: 'text' }, { bit: 1, type: 'text' }, { bit: 2, type: 'date' },
    { bit: 3, type: 'text' }, { bit: 4, type: 'time' }, { bit: 5, type: 'time' },
    { bit: 6, type: 'time' }, { bit: 7, type: 'text' }, { bit: 8, type: 'text' },
    { bit: 9, type: 'text' }, { bit: 10, type: 'text' }, { bit: 11, type: 'text' },
    { bit: 12, type: 'fin' }, { bit: 13, type: 'compact' }, { bit: 14, type: 'date' }
  ];

  var FIELDS3 = [
    { bit: 0, type: 'compact' }, { bit: 1, type: 'compact' }, { bit: 2, type: 'compact' },
    { bit: 3, type: 'date' }, { bit: 4, type: 'text' }, { bit: 5, type: 'text' }, { bit: 6, type: 'text' }
  ];

  function pushBuf(arr, bytes) {
    if (bytes && bytes.length) arr.push(bytes);
  }

  function concatArr(arr) {
    if (!arr.length) return new Uint8Array(0);
    var len = 0, i;
    for (i = 0; i < arr.length; i++) len += arr[i].length;
    var out = new Uint8Array(len);
    var off = 0;
    for (i = 0; i < arr.length; i++) {
      out.set(arr[i], off);
      off += arr[i].length;
    }
    return out;
  }

  function readU16BE(buf, pos) {
    return ((buf[pos] & 0xff) << 8) | (buf[pos + 1] & 0xff);
  }

  function fieldGroup(bit) {
    return NG.FIELD_GROUP.field[bit];
  }

  function flags3Group(bit) {
    return NG.FIELD_GROUP.flags3[bit];
  }

  function flags4Group(bit, baseTemplate) {
    var m = baseTemplate === 3 ? NG.FIELD_GROUP.flags4_contact : NG.FIELD_GROUP.flags4_financial;
    return m[bit];
  }

  function splitFlagsByGroup(fieldFlags, flags3, flags4, baseTemplate) {
    var ff = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    var f3 = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    var f4 = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    var fi, g, m, f4bits;

    for (fi = 0; fi < 15; fi++) {
      if (!(fieldFlags & (1 << fi))) continue;
      g = fi === 12 ? 1 : fieldGroup(fi);
      ff[g] |= (1 << fi);
    }
    for (fi = 0; fi < 7; fi++) {
      if (!(flags3 & (1 << fi))) continue;
      g = flags3Group(fi);
      f3[g] |= (1 << fi);
      ff[g] |= (1 << 15);
    }
    if (flags4) {
      m = baseTemplate === 3 ? NG.FIELD_GROUP.flags4_contact : NG.FIELD_GROUP.flags4_financial;
      f4bits = baseTemplate === 3 ? [0, 1, 2, 3, 4, 5] : [0, 1, 2];
      for (fi = 0; fi < f4bits.length; fi++) {
        if (!(flags4 & (1 << f4bits[fi]))) continue;
        g = m[f4bits[fi]];
        f4[g] |= (1 << f4bits[fi]);
        f3[g] |= (1 << 7);
        ff[g] |= (1 << 15);
      }
    }
    return { field: ff, flags3: f3, flags4: f4 };
  }

  function popQ(queues, g) {
    var q = queues[g];
    return q && q.length ? q.shift() : new Uint8Array(0);
  }

  function encodeFlagsBlock(ff, f3, f4, flags5Follow) {
    var parts = [];
    var buf;
    if (!ff && !f3) return new Uint8Array(0);
    buf = new Uint8Array(2);
    buf[0] = (ff >> 8) & 0xff;
    buf[1] = ff & 0xff;
    parts.push(buf);
    if ((ff & (1 << 15)) || f3) {
      parts.push(new Uint8Array([f3 & 0xff]));
      if (f3 & (1 << 7)) {
        parts.push(new Uint8Array([f4 & 0xff]));
        if ((f4 & (1 << 7)) && flags5Follow) parts.push(new Uint8Array([flags5Follow & 0xff]));
      }
    }
    return concatArr(parts);
  }

  function prependGroupLocal(body, g, record, opts) {
    if (!NG || !record || (opts && opts.nativePhase3 === false)) return body;
    var lf = NG.groupLocalFlags(g, record);
    if (!lf) return body;
    var out = new Uint8Array(1 + body.length);
    out[0] = lf;
    out.set(body, 1);
    return out;
  }

  function stripGroupLocal(bytes, ctx) {
    if (!ctx || !ctx.groupLocalPrefix || !bytes.length) return { local: 0, body: bytes };
    return { local: bytes[0], body: bytes.subarray(1) };
  }

  function encodeGroupFieldBody(g, ffG, f3G, f4G, queues, flags5Follow, record, opts) {
    var parts = [];
    var fi, f, f4defs, f4b;

    if (!ffG && !f3G && !f4G) {
      if (!queues[g] || !queues[g].length) return new Uint8Array(0);
    }

    if (ffG || f3G) {
      if (!ffG && f3G) ffG = (1 << 15);
      pushBuf(parts, encodeFlagsBlock(ffG, f3G, f4G, flags5Follow));
    }

    for (fi = 0; fi < FIELDS.length; fi++) {
      f = FIELDS[fi];
      if (!(ffG & (1 << f.bit))) continue;
      if (f.bit === 15) continue;
      if (f.bit === 12) pushBuf(parts, popQ(queues, 1));
      else if (fieldGroup(f.bit) === g) pushBuf(parts, popQ(queues, g));
    }
    for (fi = 0; fi < FIELDS3.length; fi++) {
      f = FIELDS3[fi];
      if (!(f3G & (1 << f.bit))) continue;
      if (flags3Group(f.bit) === g) pushBuf(parts, popQ(queues, g));
    }
    if (f4G && (f3G & (1 << 7))) {
      f4defs = queues._baseTemplate === 3
        ? [{ bit: 0 }, { bit: 1 }, { bit: 2 }, { bit: 3 }, { bit: 4 }, { bit: 5 }]
        : [{ bit: 0 }, { bit: 1 }, { bit: 2 }];
      for (fi = 0; fi < f4defs.length; fi++) {
        f = f4defs[fi];
        if (!(f4G & (1 << f.bit))) continue;
        if (flags4Group(f.bit, queues._baseTemplate) === g) pushBuf(parts, popQ(queues, g));
      }
    }
    return prependGroupLocal(concatArr(parts), g, record, opts);
  }

  function skipFieldData(bytes, pos, f, compactTime) {
    var start = pos;
    if (f.type === 'fin') return { next: pos, slice: new Uint8Array(0) };
    if (f.type === 'text' || (f.type === 'date' && !compactTime)) {
      var len = readU16BE(bytes, pos);
      return { next: pos + 2 + len, slice: bytes.subarray(start, pos + 2 + len) };
    }
    if (f.type === 'compact') {
      var cl = bytes[pos];
      return { next: pos + 1 + cl, slice: bytes.subarray(start, pos + 1 + cl) };
    }
    if (f.type === 'date' || f.type === 'time') {
      if (compactTime) return { next: pos + 2, slice: bytes.subarray(start, pos + 2) };
      var len2 = readU16BE(bytes, pos);
      return { next: pos + 2 + len2, slice: bytes.subarray(start, pos + 2 + len2) };
    }
    return { next: pos, slice: new Uint8Array(0) };
  }

  function skipFinBlock(bytes, pos, isStateCommit) {
    var start = pos;
    if (isStateCommit) return { next: pos + 4, slice: bytes.subarray(start, pos + 4) };

    if (pos >= bytes.length) throw new Error('native-v1-split: truncated fin');
    var fc = bytes[pos++];
    var fcCust = (fc >> 1) & 1;
    var fcWork = fc & 1;
    var fcBit6 = (fc >> 6) & 1;

    if (fcBit6) {
      if (fcCust) pos += 3;
      if (fcWork) pos += 3;
      return { next: pos, slice: bytes.subarray(start, pos) };
    }

    var finQtySplit = !!(fc & 0x04);
    if (fcCust) pos += 3;
    if (fcWork) pos += 3;
    if (pos < bytes.length) {
      var maybeTax = bytes[pos];
      if (maybeTax <= 255 && pos + 2 < bytes.length) pos += 3;
    }
    if (finQtySplit) pos += 6;
    if (pos + 1 < bytes.length) {
      var ch1 = bytes[pos];
      if (((ch1 >> 3) & 0x1f) > 0) {
        pos += 2;
        var lc = (bytes[pos - 2] >> 3) & 0x1f;
        var lfp = !!(bytes[pos - 2] & 0x01);
        var li;
        for (li = 0; li < lc; li++) {
          if (lfp) pos++;
          pos = skipCompactOnly(bytes, pos);
          pos += 3;
        }
      }
    }
    return { next: pos, slice: bytes.subarray(start, pos) };
  }

  function skipCompactOnly(bytes, pos) {
    var cl = bytes[pos];
    return pos + 1 + cl;
  }

  function skipTextBE(bytes, pos) {
    var len = readU16BE(bytes, pos);
    return pos + 2 + len;
  }

  function skipParticipants(bytes, pos) {
    var start = pos;
    var bh = bytes[pos++];
    var pCount = (bh >> 5) & 0x07;
    var pi, pf, pRole;
    for (pi = 0; pi < pCount; pi++) {
      pf = bytes[pos++];
      pRole = (pf >> 5) & 0x03;
      pos = skipTextBE(bytes, pos);
      if (pRole !== 3 && (pf & 0x02)) pos = skipTextBE(bytes, pos);
      if (pf & 0x08) pos = skipTextBE(bytes, pos);
      if (pf & 0x04) pos = skipTextBE(bytes, pos);
      if (pRole === 3) {
        if (pf & 0x02) pos = skipTextBE(bytes, pos);
        else {
          pos++;
          if (((bytes[pos - 1] >> 3) & 0x1f) === 31) pos++;
        }
      }
      if (pf & 0x10) {
        pos++;
        pos = skipCompactOnly(bytes, pos);
      }
    }
    return { next: pos, slice: bytes.subarray(start, pos) };
  }

  function skipTrig(bytes, pos) {
    var start = pos;
    var tlen = bytes[pos++];
    return { next: pos + tlen, slice: bytes.subarray(start, pos + tlen) };
  }

  function skipDisplay(bytes, pos) {
    var start = pos;
    if (pos >= bytes.length) return { next: pos, slice: new Uint8Array(0) };
    var dc = bytes[pos++];
    if (dc & 0x02) pos++;
    if (dc & 0x01) pos++;
    var dsType = (dc >> 6) & 0x03;
    if (dsType >= 2 && pos < bytes.length) {
      var fc = bytes[pos++];
      if (fc & 0x01) {
        var fCount = bytes[pos++];
        var fj;
        for (fj = 0; fj < fCount; fj++) {
          pos += 2;
          if (bytes[pos - 1] === 0xff) pos = skipCompactOnly(bytes, pos);
        }
      }
    }
    return { next: pos, slice: bytes.subarray(start, pos) };
  }

  function fieldTargetGroup(bit) {
    return bit === 12 ? 1 : fieldGroup(bit);
  }

  function decodeGroupFieldBody(bytes, g, ctx) {
    var stripped = stripGroupLocal(bytes, ctx);
    if (stripped.local && ctx) ctx.decodedGroupLocal = ctx.decodedGroupLocal || {};
    if (stripped.local && ctx) ctx.decodedGroupLocal[g] = stripped.local;
    bytes = stripped.body;
    var pos = 0;
    var end = bytes.length;
    var items = [];
    if (pos + 2 > end) {
      return { fieldFlags: 0, flags3: 0, flags4: 0, items: items, rest: bytes.subarray(pos) };
    }

    var ff = readU16BE(bytes, pos);
    pos += 2;
    var f3 = 0;
    var f4 = 0;
    if (ff & (1 << 15)) {
      if (pos >= end) throw new Error('native-v1-split: truncated flags3');
      f3 = bytes[pos++];
      if (f3 & (1 << 7)) {
        if (pos >= end) throw new Error('native-v1-split: truncated flags4');
        f4 = bytes[pos++];
        if (f4 & (1 << 7) && pos < end) pos++;
      }
    }

    var fi, f, sl, f4defs;
    for (fi = 0; fi < FIELDS.length; fi++) {
      f = FIELDS[fi];
      if (!(ff & (1 << f.bit))) continue;
      if (f.bit === 15) continue;
      if (fieldTargetGroup(f.bit) !== g) continue;
      if (f.type === 'fin') {
        sl = skipFinBlock(bytes, pos, ctx.isStateCommit);
        items.push({ kind: 'fin', slice: sl.slice });
        pos = sl.next;
        continue;
      }
      sl = skipFieldData(bytes, pos, f, ctx.compactTime);
      items.push({ kind: 'f', bit: f.bit, slice: sl.slice });
      pos = sl.next;
    }
    for (fi = 0; fi < FIELDS3.length; fi++) {
      f = FIELDS3[fi];
      if (!(f3 & (1 << f.bit))) continue;
      if (flags3Group(f.bit) !== g) continue;
      sl = skipFieldData(bytes, pos, f, ctx.compactTime);
      items.push({ kind: 'f3', bit: f.bit, slice: sl.slice });
      pos = sl.next;
    }
    if (f4) {
      f4defs = ctx.baseTemplate === 3
        ? [{ bit: 0, type: 'text' }, { bit: 1, type: 'compact' }, { bit: 2, type: 'text' },
           { bit: 3, type: 'u8enum' }, { bit: 4, type: 'text' }, { bit: 5, type: 'text' }]
        : [{ bit: 0, type: 'compact' }, { bit: 1, type: 'date' }, { bit: 2, type: 'gps' }];
      for (fi = 0; fi < f4defs.length; fi++) {
        f = f4defs[fi];
        if (!(f4 & (1 << f.bit))) continue;
        if (flags4Group(f.bit, ctx.baseTemplate) !== g) continue;
        var f4start = pos;
        if (f.type === 'text') pos = skipTextBE(bytes, pos);
        else if (f.type === 'compact') pos = skipCompactOnly(bytes, pos);
        else if (f.type === 'u8enum') pos++;
        else if (f.type === 'date') pos += 2;
        else if (f.type === 'gps') pos += 4;
        items.push({ kind: 'f4', bit: f.bit, slice: bytes.subarray(f4start, pos) });
      }
    }
    return { fieldFlags: ff, flags3: f3, flags4: f4, items: items, rest: bytes.subarray(pos) };
  }

  function parseG1SetupLen(g1bytes, headerPrefix) {
    if (!g1bytes || !g1bytes.length || !headerPrefix || !headerPrefix.length) return 0;
    var meta1 = headerPrefix[0];
    var meta2Present = !!(meta1 & 0x80);
    var extTemplate = !!(meta1 & 0x40);
    var baseOrSig = (meta1 >> 3) & 0x07;
    if (extTemplate) return 0;
    var isStateCommit = baseOrSig === 5;
    var domain = 0;
    if (meta2Present && headerPrefix.length > 1) domain = (headerPrefix[1] >> 2) & 0x03;
    if (domain === 0 && !isStateCommit) return 0;

    var pos = 0;
    if (pos >= g1bytes.length) return 0;
    pos++;
    var finCur = (g1bytes[0] >> 3) & 0x03;
    var finSfP = !!(g1bytes[0] & 0x1);
    if (finCur === 3) pos++;
    if (finSfP) pos++;
    if (isStateCommit) pos++;
    else {
      pos++;
      if (domain === 3 && pos <= g1bytes.length) {
        var apb = g1bytes[pos - 1];
        if (apb & 1) pos++;
      }
    }
    return pos;
  }

  function ingestGroupFields(byKey, body, g, ctx) {
    if (!body || !body.length) return new Uint8Array(0);
    var dec = decodeGroupFieldBody(body, g, ctx);
    var i, it, k;
    ctx.accFf |= dec.fieldFlags;
    ctx.accF3 |= dec.flags3;
    ctx.accF4 |= dec.flags4;
    for (i = 0; i < dec.items.length; i++) {
      it = dec.items[i];
      if (it.kind === 'fin') byKey.fin = it.slice;
      else if (it.kind === 'f') byKey['f' + it.bit] = it.slice;
      else if (it.kind === 'f3') byKey['f3_' + it.bit] = it.slice;
      else if (it.kind === 'f4') byKey['f4_' + it.bit] = it.slice;
    }
    return dec.rest;
  }

  function emitMergedFieldStream(groups, presence, headerPrefix, flags5Follow, mergeOpts) {
    mergeOpts = mergeOpts || {};
    var meta1 = headerPrefix && headerPrefix.length ? headerPrefix[0] : 0;
    var meta2 = headerPrefix && headerPrefix.length > 1 ? headerPrefix[1] : 0;
    var ctx = {
      compactTime: !!(meta2 & 0x40),
      baseTemplate: (meta1 & 0x40) ? null : ((meta1 >> 3) & 0x07),
      isStateCommit: headerPrefix && headerPrefix.length && !((meta1 & 0x40)) && ((meta1 >> 3) & 7) === 5,
      accFf: 0,
      accF3: 0,
      accF4: 0,
      groupLocalPrefix: !!mergeOpts.groupLocalPrefix
    };
    var byKey = {};
    var g, body, setupLen, g5Tail = new Uint8Array(0);
    var ingestOrder = [1, 0, 2, 3, 4, 5];

    for (var oi = 0; oi < ingestOrder.length; oi++) {
      g = ingestOrder[oi];
      if (!(presence & (1 << g))) continue;
      body = groups[g];
      if (!body || !body.length) continue;
      if (g === 1) {
        setupLen = parseG1SetupLen(body, headerPrefix);
        ingestGroupFields(byKey, body.subarray(setupLen), 1, ctx);
        continue;
      }
      if (g === 5) {
        g5Tail = ingestGroupFields(byKey, body, 5, ctx);
        continue;
      }
      ingestGroupFields(byKey, body, g, ctx);
    }

    var parts = [];
    pushBuf(parts, encodeFlagsBlock(ctx.accFf, ctx.accF3, ctx.accF4, flags5Follow));

    var fi, f, f4defs, k;
    for (fi = 0; fi < FIELDS.length; fi++) {
      f = FIELDS[fi];
      if (!(ctx.accFf & (1 << f.bit))) continue;
      if (f.bit === 15) continue;
      if (f.type === 'fin') {
        if (byKey.fin) pushBuf(parts, byKey.fin);
        continue;
      }
      k = 'f' + f.bit;
      if (byKey[k]) pushBuf(parts, byKey[k]);
    }
    for (fi = 0; fi < FIELDS3.length; fi++) {
      f = FIELDS3[fi];
      if (!(ctx.accF3 & (1 << f.bit))) continue;
      k = 'f3_' + f.bit;
      if (byKey[k]) pushBuf(parts, byKey[k]);
    }
    if (ctx.accF4) {
      f4defs = ctx.baseTemplate === 3
        ? [{ bit: 0 }, { bit: 1 }, { bit: 2 }, { bit: 3 }, { bit: 4 }, { bit: 5 }]
        : [{ bit: 0 }, { bit: 1 }, { bit: 2 }];
      for (fi = 0; fi < f4defs.length; fi++) {
        f = f4defs[fi];
        if (!(ctx.accF4 & (1 << f.bit))) continue;
        k = 'f4_' + f.bit;
        if (byKey[k]) pushBuf(parts, byKey[k]);
      }
    }
    global.WPNativeV1Split._lastDecodedGroupLocal = ctx.decodedGroupLocal || null;
    return { stream: concatArr(parts), g5Tail: g5Tail };
  }

  function splitV1ToNativeGroups(bytes, record, opts) {
    opts = opts || {};
    if (!NG) throw new Error('native-v1-split: WPNativeGroups required');
    if (!bytes || bytes.length < 3) throw new Error('native-v1-split: frame too short');

    var buckets = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
    var queues = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
    var headerParts = [];
    var pos = 0;

    var meta1 = bytes[pos++];
    headerParts.push(new Uint8Array([meta1]));
    var meta2Present = !!(meta1 & 0x80);
    var extTemplate = !!(meta1 & 0x40);
    var baseOrSig = (meta1 >> 3) & 0x07;
    var baseTemplate = extTemplate ? null : baseOrSig;

    if (extTemplate) {
      var sig = baseOrSig;
      var extStart = pos;
      if (sig === 1) pos += 1;
      else if (sig === 2) pos += 2;
      else if (sig === 3) pos += 3;
      else if (sig === 4) pos += 3;
      pushBuf(buckets[0], bytes.subarray(extStart, pos));
    }

    var compactTime = false;
    var domain = 0;
    var hasParticipants = false;
    var hasTrig = false;
    if (meta2Present) {
      var meta2 = bytes[pos++];
      headerParts.push(new Uint8Array([meta2]));
      compactTime = !!(meta2 & 0x40);
      domain = (meta2 >> 2) & 0x03;
      hasParticipants = !!(meta2 & 0x10);
      hasTrig = !!(meta2 & 0x20);
    }

    if (!extTemplate && baseOrSig === 6) {
      return {
        groups: { 0: bytes },
        presence: 1,
        headerPrefix: concatArr(headerParts),
        amendment: true
      };
    }

    var isStateCommit = (!extTemplate && baseOrSig === 5);
    var flags5Follow = 0;

    if (domain > 0 || isStateCommit) {
      var setupStart = pos;
      pos++;
      var finCur = (bytes[setupStart] >> 3) & 0x03;
      var finSfP = !!(bytes[setupStart] & 0x1);
      if (finCur === 3) pos++;
      if (finSfP) pos++;
      if (isStateCommit) pos++;
      else {
        pos++;
        if (domain === 3) {
          var apb = bytes[pos - 1];
          if (apb & 1) pos++;
        }
      }
      pushBuf(buckets[1], bytes.subarray(setupStart, pos));
    }

    if (pos + 2 > bytes.length) throw new Error('native-v1-split: truncated field_flags');
    var fieldFlags = readU16BE(bytes, pos);
    pos += 2;

    var flags3 = 0;
    if (fieldFlags & (1 << 15)) {
      flags3 = bytes[pos++];
    }

    var flags4 = 0;
    if (flags3 & (1 << 7)) {
      flags4 = bytes[pos++];
      if (flags4 & (1 << 7)) {
        flags5Follow = bytes[pos++];
        pos++;
      }
    }

    var fi, f, sl, g5FieldBody;
    for (fi = 0; fi < FIELDS.length; fi++) {
      f = FIELDS[fi];
      if (!(fieldFlags & (1 << f.bit))) continue;
      if (f.bit === 15) continue;
      if (f.type === 'fin') {
        sl = skipFinBlock(bytes, pos, isStateCommit);
        queues[1].push(sl.slice);
        pos = sl.next;
        continue;
      }
      sl = skipFieldData(bytes, pos, f, compactTime);
      queues[fieldGroup(f.bit)].push(sl.slice);
      pos = sl.next;
    }

    for (fi = 0; fi < FIELDS3.length; fi++) {
      f = FIELDS3[fi];
      if (!(flags3 & (1 << f.bit))) continue;
      sl = skipFieldData(bytes, pos, f, compactTime);
      queues[flags3Group(f.bit)].push(sl.slice);
      pos = sl.next;
    }

    if (flags4) {
      var f4defs = baseTemplate === 3
        ? [{ bit: 0, type: 'text' }, { bit: 1, type: 'compact' }, { bit: 2, type: 'text' },
           { bit: 3, type: 'u8enum' }, { bit: 4, type: 'text' }, { bit: 5, type: 'text' }]
        : [{ bit: 0, type: 'compact' }, { bit: 1, type: 'date' }, { bit: 2, type: 'gps' }];
      for (fi = 0; fi < f4defs.length; fi++) {
        f = f4defs[fi];
        if (!(flags4 & (1 << f.bit))) continue;
        var f4start = pos;
        if (f.type === 'text') pos = skipTextBE(bytes, pos);
        else if (f.type === 'compact') pos = skipCompactOnly(bytes, pos);
        else if (f.type === 'u8enum') pos++;
        else if (f.type === 'date') pos += 2;
        else if (f.type === 'gps') pos += 4;
        queues[flags4Group(f.bit, baseTemplate)].push(bytes.subarray(f4start, pos));
      }
    }

    queues._baseTemplate = baseTemplate;
    var fg = splitFlagsByGroup(fieldFlags, flags3, flags4, baseTemplate);
    var gi, gBody, g5FieldBody;
    for (gi = 0; gi <= 4; gi++) {
      gBody = encodeGroupFieldBody(gi, fg.field[gi], fg.flags3[gi], fg.flags4[gi], queues, flags5Follow, record, opts);
      if (gBody.length) pushBuf(buckets[gi], gBody);
    }
    g5FieldBody = encodeGroupFieldBody(5, fg.field[5], fg.flags3[5], fg.flags4[5], queues, flags5Follow, record, opts);
    if (g5FieldBody.length) pushBuf(buckets[5], g5FieldBody);

    if (hasParticipants) {
      sl = skipParticipants(bytes, pos);
      pushBuf(buckets[5], sl.slice);
      pos = sl.next;
    }

    if (hasTrig && pos < bytes.length) {
      sl = skipTrig(bytes, pos);
      pushBuf(buckets[6], sl.slice);
      pos = sl.next;
    }

    if (pos < bytes.length && bytes[pos] !== PRG_TAG) {
      try {
        sl = skipDisplay(bytes, pos);
        if (sl.slice.length) pushBuf(buckets[6], sl.slice);
        pos = sl.next;
      } catch (e) { /* not display */ }
    }

    if (pos < bytes.length && bytes[pos] === PRG_TAG) {
      pushBuf(buckets[6], bytes.subarray(pos));
      pos = bytes.length;
    }

    var groups = {};
    var presence = 0;
    for (gi = 0; gi <= 6; gi++) {
      groups[gi] = concatArr(buckets[gi]);
      if (groups[gi].length) presence |= (1 << gi);
    }
    return {
      groups: groups,
      presence: presence,
      headerPrefix: concatArr(headerParts)
    };
  }

  function mergeNativeGroupsToV1(groups, presence, headerPrefix, mergeOpts) {
    mergeOpts = mergeOpts || {};
    var parts = [];
    if (headerPrefix && headerPrefix.length) parts.push(headerPrefix);

    var g1 = groups[1] || new Uint8Array(0);
    var setupLen = parseG1SetupLen(g1, headerPrefix);
    if ((presence & (1 << 1)) && g1.length) {
      parts.push(g1.subarray(0, setupLen));
    }

    var merged = emitMergedFieldStream(groups, presence, headerPrefix, 0, mergeOpts);
    if (merged.stream.length) parts.push(merged.stream);

    if ((presence & (1 << 5)) && groups[5] && groups[5].length) {
      if (merged.g5Tail && merged.g5Tail.length) parts.push(merged.g5Tail);
      else parts.push(groups[5]);
    }
    if ((presence & (1 << 6)) && groups[6] && groups[6].length) parts.push(groups[6]);

    if (!parts.length) throw new Error('native-v1-split: empty merge');
    return concatArr(parts);
  }

  global.WPNativeV1Split = {
    splitV1ToNativeGroups: splitV1ToNativeGroups,
    mergeNativeGroupsToV1: mergeNativeGroupsToV1,
    emitMergedFieldStream: emitMergedFieldStream,
    concatArr: concatArr
  };

}(typeof window !== 'undefined' ? window : global));
