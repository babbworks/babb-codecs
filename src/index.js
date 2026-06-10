// @workpads/codec — public API
// Spec: workpads-standard/codec.md
// Scheme: workpads.me/p#1pa/  (pads-v1, package a)

'use strict';

var fflate = require('fflate');
var codec  = require('./codec');

// Native #1pv/ stack (load order)
if (!global.window) global.window = global;
require('./native-groups-table.js');
require('./native-v1-split.js');
require('./pathc-v2.js');
require('./pathc-native.js');
var pathc = global.WPPathC;

var URL_PREFIX = 'workpads.me/p#1pa/';
var URL_PREFIX_V2 = 'workpads.me/p#1pv/';

var SCHEME_V2     = /^(?:https?:\/\/workpads\.me\/p[/?]?)?#?1pv\//;
var SCHEME_V1     = /^(?:https?:\/\/workpads\.me\/p[/?]?)?#?1pa\//;
var SCHEME_LEGACY = /^(?:https?:\/\/workpads\.me\/p[/?]?)?#?(1[abde]g)\//;
var SCHEME_BITPAD = /[#&]alg=bitpad-v1/;

function toBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromBase64Url(str) {
  var padded = str + '=='.slice(0, (4 - str.length % 4) % 4);
  return new Uint8Array(Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

function parseHashExtras(hash) {
  var amp = hash.indexOf('&');
  if (amp === -1) return { body: hash };
  return { body: hash.slice(0, amp), chainRef: hash.slice(amp + 1).replace(/^c=/, '') };
}

function encode(record, opts) {
  opts = opts || {};
  var result = codec.validate(record);
  if (!result.valid) throw new Error('@workpads/codec encode: ' + result.errors.join('; '));
  if (opts.padsV2 || opts.schemeTag === '1pv') {
    var frame = new Uint8Array(codec.encodeFrame(record, opts));
    var useBridge = opts.bridgeV1 === true;
    var inner = (useBridge || !global.WPPathCNative)
      ? pathc.wrapV1Frame(frame, record, opts)
      : global.WPPathCNative.wrapNative(frame, record, opts);
    var compressed = fflate.deflateSync(inner, { level: 9 });
    var url = URL_PREFIX_V2 + toBase64Url(compressed);
    if (opts.chain && opts.chainRef) {
      var cr = opts.chainRef;
      url += '&c=' + (typeof cr === 'string' ? cr : toBase64Url(new Uint8Array(cr)));
    }
    return url;
  }
  var frame = codec.encodeFrame(record, opts);
  var compressed = fflate.deflateSync(frame, { level: 9 });
  return URL_PREFIX + toBase64Url(compressed);
}

function decode(url) {
  var s = String(url);
  var hashIdx = s.indexOf('#');
  if (hashIdx !== -1) s = s.slice(hashIdx + 1);

  if (SCHEME_V2.test('#' + s)) {
    var extras = parseHashExtras(s.replace(/^(?:.*#)?1pv\//, ''));
    var inflated = fflate.inflateSync(fromBase64Url(extras.body.split('&')[0]));
    var unwrapped = (global.WPPathCNative && global.WPPathCNative.unwrapNative)
      ? global.WPPathCNative.unwrapNative(new Uint8Array(inflated))
      : pathc.unwrapToV1Frame(new Uint8Array(inflated));
    var rec = codec.decodeFrame(unwrapped.v1Frame);
    rec = pathc.attachMetaToRecord(rec, unwrapped.meta, unwrapped.bridge);
    if (unwrapped.native) rec._nativeGroups = true;
    if (extras.chainRef) rec._chainRef = extras.chainRef;
    return rec;
  }

  if (SCHEME_V1.test('#' + s)) {
    var data1 = s.replace(/^(?:.*#)?1pa\//, '');
    var frame1 = fflate.inflateSync(fromBase64Url(data1));
    return codec.decodeFrame(new Uint8Array(frame1));
  }

  var legacyMatch = ('#' + s).match(SCHEME_LEGACY);
  if (legacyMatch) {
    var data2 = s.replace(/^[^/]+\//, '');
    var frame2 = fflate.inflateSync(fromBase64Url(data2));
    return decodeLegacyFrame(new Uint8Array(frame2), legacyMatch[1]);
  }

  if (SCHEME_BITPAD.test(s)) {
    var dIdx = s.indexOf('d=');
    if (dIdx === -1) throw new Error('@workpads/codec: bitpad-v1 URL missing d= param');
    var dVal  = s.slice(dIdx + 2).split('&')[0];
    var frame3 = fflate.inflateSync(fromBase64Url(dVal));
    return decodeBitpadV1Frame(new Uint8Array(frame3));
  }

  throw new Error('@workpads/codec: unsupported URL scheme: ' + url);
}

function validate(record) {
  return codec.validate(record);
}

var LEGACY_SCALAR = [
  { id: 'job',            bit:  0 },
  { id: 'customer',       bit:  1 },
  { id: 'location',       bit:  3 },
  { id: 'meeting_time',   bit:  4 },
  { id: 'start_time',     bit:  5 },
  { id: 'end_time',       bit:  6 },
  { id: 'customer_phone', bit:  7 },
  { id: 'worker',         bit:  8 },
  { id: 'details',        bit: 10 },
  { id: 'story',          bit: 11 },
];

function readLegacyText(bytes, pos) {
  var len = ((bytes[pos] & 0xff) << 8) | (bytes[pos+1] & 0xff);
  return { value: Buffer.from(bytes.subarray(pos + 2, pos + 2 + len)).toString('utf8'), advance: 2 + len };
}

function decodeLegacyFrame(bytes, tag) {
  if (bytes.length < 4) throw new Error('@workpads/codec: legacy frame too short');
  var pos = 0, record = {};
  var templateByte = bytes[pos++];
  record._meta = { baseTemplate: templateByte, legacyTag: tag };
  var flagsWidth = (tag === '1eg' || tag === '1dg') ? 3 : 2;
  var flags = 0;
  for (var fi = 0; fi < flagsWidth; fi++) flags |= (bytes[pos++] << (8 * (flagsWidth - 1 - fi)));
  for (var i = 0; i < LEGACY_SCALAR.length; i++) {
    var f = LEGACY_SCALAR[i]; if (!(flags & (1 << f.bit))) continue;
    var r = readLegacyText(bytes, pos); pos += r.advance; record[f.id] = r.value;
  }
  return record;
}

var BITPAD_SCALAR = [
  { id: 'job',            bit:  0 }, { id: 'customer',       bit:  1 },
  { id: 'date',           bit:  2 }, { id: 'location',       bit:  3 },
  { id: 'meeting_time',   bit:  4 }, { id: 'start_time',     bit:  5 },
  { id: 'end_time',       bit:  6 }, { id: 'customer_phone', bit:  7 },
  { id: 'worker',         bit:  8 }, { id: 'details',        bit:  10 },
  { id: 'story',          bit:  11 },
];

function decodeBitpadV1Frame(bytes) {
  if (bytes.length < 3) throw new Error('@workpads/codec: bitpad-v1 frame too short');
  var pos = 1;
  var flags = ((bytes[pos] & 0xff) << 8) | (bytes[pos+1] & 0xff); pos += 2;
  var record = {};
  for (var i = 0; i < BITPAD_SCALAR.length; i++) {
    var f = BITPAD_SCALAR[i]; if (f.bit >= 9) break;
    if (!(flags & (1 << f.bit))) continue;
    var r = readLegacyText(bytes, pos); pos += r.advance; record[f.id] = r.value;
  }
  if (flags & (1 << 9)) {
    var count = bytes[pos++], actions = [];
    for (var k = 0; k < count; k++) {
      var tr = readLegacyText(bytes, pos); pos += tr.advance;
      var nr = readLegacyText(bytes, pos); pos += nr.advance;
      actions.push({ title: tr.value, notes: nr.value });
    }
    record.actions = actions;
  }
  for (var j = 0; j < BITPAD_SCALAR.length; j++) {
    var sf = BITPAD_SCALAR[j]; if (sf.bit <= 9) continue;
    if (!(flags & (1 << sf.bit))) continue;
    var rs = readLegacyText(bytes, pos); pos += rs.advance; record[sf.id] = rs.value;
  }
  return record;
}

function encodeBinary(record, opts) {
  var result = codec.validate(record);
  if (!result.valid) throw new Error('@workpads/codec encodeBinary: ' + result.errors.join('; '));
  if (opts && (opts.padsV2 || opts.schemeTag === '1pv')) {
    var frame = new Uint8Array(codec.encodeFrame(record, opts));
    var useBridge = opts.bridgeV1 === true;
    var inner = (useBridge || !global.WPPathCNative)
      ? pathc.wrapV1Frame(frame, record, opts)
      : global.WPPathCNative.wrapNative(frame, record, opts);
    var compressed = fflate.deflateSync(inner, { level: 9 });
    return { compressed: compressed, frameSize: frame.length };
  }
  var frame      = codec.encodeFrame(record, opts);
  var compressed = fflate.deflateSync(frame, { level: 9 });
  return { compressed: compressed, frameSize: frame.length };
}

function decodeBinary(buffer) {
  if (buffer.length < 4) throw new Error('@workpads/codec: binary too short');
  var tag  = String.fromCharCode(buffer[0], buffer[1], buffer[2]);
  var data = buffer.slice(3);

  if (tag === '1pv') {
    var inflated = fflate.inflateSync(new Uint8Array(data));
    var unwrapped = (global.WPPathCNative && global.WPPathCNative.unwrapNative)
      ? global.WPPathCNative.unwrapNative(new Uint8Array(inflated))
      : pathc.unwrapToV1Frame(new Uint8Array(inflated));
    var rec = codec.decodeFrame(unwrapped.v1Frame);
    rec = pathc.attachMetaToRecord(rec, unwrapped.meta, unwrapped.bridge);
    if (unwrapped.native) rec._nativeGroups = true;
    return rec;
  }

  if (tag === '1pa') {
    var frame = fflate.inflateSync(new Uint8Array(data));
    return codec.decodeFrame(new Uint8Array(frame));
  }

  var pseudoUrl = '#' + tag + '/' + toBase64Url(new Uint8Array(data));
  return decode(pseudoUrl);
}

module.exports = { encode: encode, decode: decode, validate: validate,
                   encodeBinary: encodeBinary, decodeBinary: decodeBinary };
