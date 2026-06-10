// pathc-native.js — G0–G6 native envelope for #1pv/ (v0.4)
// Native G0–G6 field slices (native-v1-split.js); legacy bridge via pathc-v2 FLAG_BRIDGE_V1.
(function(global) {
  'use strict';

  var FLAG_BRIDGE_V1 = 0x01;
  var FLAG_GROUP_LOCAL = 0x10;
  var FLAG_HAS_TRAIL = 0x40;
  var FLAG_HAS_HDR = 0x20;
  var FLAG_CRC = 0x80;
  var TRAIL_HAS_REL = 0x02;
  var TRAIL_HAS_ACK = 0x04;
  var TRAIL_HAS_V4 = 0x08;

  var NG = global.WPNativeGroups;
  var GROUP = NG ? NG.GROUP : { G0: 0, G1: 1, G2: 2, G3: 3, G4: 4, G5: 5, G6: 6 };

  function mandatoryGroupIds(record) {
    return NG ? NG.mandatoryGroupIds(record) : [0, 6];
  }

  function presenceForRecord(record, splitPresence) {
    var pres = splitPresence || 0;
    return NG ? NG.presenceWithMandatory(record, pres) : (pres | 1);
  }

  function readU16LE(buf, pos) {
    return (buf[pos] & 0xff) | ((buf[pos + 1] & 0xff) << 8);
  }

  function writeU16LE(buf, pos, v) {
    buf[pos] = v & 0xff;
    buf[pos + 1] = (v >> 8) & 0xff;
  }

  function concatParts(parts) {
    var len = 0, i, out, off;
    for (i = 0; i < parts.length; i++) len += parts[i].length;
    out = new Uint8Array(len);
    off = 0;
    for (i = 0; i < parts.length; i++) {
      out.set(parts[i], off);
      off += parts[i].length;
    }
    return out;
  }

  function splitV1Frame(v1Frame, record, opts) {
    opts = opts || {};
    var useSplit = opts.nativeSplit !== false && global.WPNativeV1Split;
    var split = useSplit
      ? global.WPNativeV1Split.splitV1ToNativeGroups(v1Frame, record, opts)
      : null;
    var groups, presence;
    if (split) {
      groups = split.groups;
      presence = split.presence;
    } else {
      presence = 1 << GROUP.G0;
      groups = {};
      groups[GROUP.G0] = v1Frame;
    }
    presence = presenceForRecord(record, presence);
    return { groups: groups, presence: presence & 0x7f, headerPrefix: split ? split.headerPrefix : null };
  }

  function mergeV1Frame(groups, presence, headerPrefix, mergeOpts) {
    if (global.WPNativeV1Split) {
      return global.WPNativeV1Split.mergeNativeGroupsToV1(groups, presence, headerPrefix, mergeOpts);
    }
    var order = [0, 1, 2, 3, 4, 5, 6];
    var parts = [], gi, chunk;
    for (gi = 0; gi < order.length; gi++) {
      if (!(presence & (1 << order[gi]))) continue;
      chunk = groups[order[gi]];
      if (chunk && chunk.length) parts.push(chunk);
    }
    if (!parts.length) throw new Error('WPPathCNative: empty native groups');
    return concatParts(parts);
  }

  function encodeGroupChunk(payload) {
    payload = payload || new Uint8Array(0);
    var out = new Uint8Array(2 + payload.length);
    writeU16LE(out, 0, payload.length);
    if (payload.length) out.set(payload, 2);
    return out;
  }

  function decodeGroupChunk(bytes, pos, end) {
    if (pos + 2 > end) throw new Error('WPPathCNative: truncated group len');
    var len = readU16LE(bytes, pos);
    pos += 2;
    if (pos + len > end) throw new Error('WPPathCNative: truncated group body');
    return { payload: bytes.subarray(pos, pos + len), next: pos + len };
  }

  function decodeTrail(bytes, pos, end, bridge) {
    bridge = bridge || {};
    if (pos >= end) return { bridge: bridge, next: pos };
    var tf = bytes[pos++];
    if (tf & TRAIL_HAS_REL) {
      if (pos >= end) throw new Error('WPPathCNative: missing relationship');
      var rd = global.WPPathC.decodeRelationshipByte(bytes[pos++]);
      bridge.relationship = rd.name;
      bridge.relationship_subtype = rd.subtype;
    }
    if (tf & TRAIL_HAS_ACK) {
      if (pos + 4 > end) throw new Error('WPPathCNative: missing ack masks');
      bridge.confirmed_mask = readU16LE(bytes, pos); pos += 2;
      bridge.declined_mask = readU16LE(bytes, pos); pos += 2;
    }
    if (tf & TRAIL_HAS_V4) {
      var v4d = global.WPPathC.decodeV4Extension(bytes, pos, end);
      bridge.v4 = v4d.v4;
      pos = v4d.next;
    }
    return { bridge: bridge, next: pos };
  }

  function wrapNative(v1Frame, record, opts) {
    opts = opts || {};
    if (!global.WPPathC) throw new Error('WPPathCNative: WPPathC required');
    var split = splitV1Frame(v1Frame, record, opts);
    var groups = split.groups;
    var presence = split.presence;
    var headerPrefix = split.headerPrefix;

    var relName = opts.relationship || global.WPPathC.inferRelationship(record);
    var hasRel = global.WPPathC.RELATIONSHIP[relName] != null || opts.relationshipByte != null;
    var hasAck = record && (record.confirmed_mask != null || record.declined_mask != null ||
      record.confirmedMask != null || record.declinedMask != null);
    var v4Ext = global.WPPathC.encodeV4Extension(record, opts);
    var hasTrail = hasRel || hasAck || v4Ext;

    var useGroupLocal = opts.nativePhase3 !== false && NG && NG.anyGroupLocalFlags(record);
    var flag = (opts.crc !== false ? FLAG_CRC : 0) | (hasTrail ? FLAG_HAS_TRAIL : 0);
    if (headerPrefix && headerPrefix.length) flag |= FLAG_HAS_HDR;
    if (useGroupLocal) flag |= FLAG_GROUP_LOCAL;
    var hdr = global.WPPathC.encodeHeader(record, opts);
    var parts = [new Uint8Array([flag]), hdr, new Uint8Array([presence & 0xff])];
    if (flag & FLAG_HAS_HDR) {
      parts.push(new Uint8Array([headerPrefix.length & 0xff]));
      parts.push(headerPrefix);
    }

    var emitOrder = [1, 0, 2, 3, 4, 5, 6];
    var g, ei;
    for (ei = 0; ei < emitOrder.length; ei++) {
      g = emitOrder[ei];
      if (!(presence & (1 << g))) continue;
      parts.push(encodeGroupChunk(groups[g]));
    }

    if (hasTrail) {
      var tf = 0;
      if (hasRel) tf |= TRAIL_HAS_REL;
      if (hasAck) tf |= TRAIL_HAS_ACK;
      if (v4Ext) tf |= TRAIL_HAS_V4;
      var trail = [new Uint8Array([tf])];
      if (hasRel) {
        trail.push(opts.relationshipByte ||
          global.WPPathC.encodeRelationshipByte(relName, record.relationship_subtype));
      }
      if (hasAck) trail.push(global.WPPathC.encodeAckMasksBuf(record));
      if (v4Ext) trail.push(v4Ext);
      parts = parts.concat(trail);
    }

    var body = concatParts(parts);
    if (!(flag & FLAG_CRC)) return body;
    var crcBuf = new Uint8Array(2);
    writeU16LE(crcBuf, 0, global.WPPathC.crc16Ccitt(body));
    return concatParts([body, crcBuf]);
  }

  function unwrapNative(bytes) {
    if (!global.WPPathC) throw new Error('WPPathCNative: WPPathC required');
    if (!bytes || bytes.length < 5) throw new Error('WPPathCNative: frame too short');
    var flag = bytes[0];
    if (flag & FLAG_BRIDGE_V1) return global.WPPathC.unwrapToV1Frame(bytes);

    var useCrc = !!(flag & FLAG_CRC);
    var end = bytes.length - (useCrc ? 2 : 0);
    if (useCrc) {
      var expect = readU16LE(bytes, end);
      var got = global.WPPathC.crc16Ccitt(bytes.subarray(0, end));
      if (got !== expect) throw new Error('WPPathCNative: CRC-16 mismatch');
    }

    var dec = global.WPPathC.decodeHeaderMeta(bytes, 1);
    var pos = dec.next;
    if (pos >= end) throw new Error('WPPathCNative: missing presence');
    var presence = bytes[pos++];

    var headerPrefix = null;
    if (flag & FLAG_HAS_HDR) {
      if (pos >= end) throw new Error('WPPathCNative: missing header len');
      var hlen = bytes[pos++];
      if (pos + hlen > end) throw new Error('WPPathCNative: truncated header');
      headerPrefix = bytes.subarray(pos, pos + hlen);
      pos += hlen;
    }

    var emitOrder = [1, 0, 2, 3, 4, 5, 6];
    var groups = {};
    var ei, g;
    for (ei = 0; ei < emitOrder.length; ei++) {
      g = emitOrder[ei];
      if (!(presence & (1 << g))) continue;
      var gd = decodeGroupChunk(bytes, pos, end);
      groups[g] = gd.payload;
      pos = gd.next;
    }

    var bridge = {};
    if (flag & FLAG_HAS_TRAIL) {
      var tr = decodeTrail(bytes, pos, end, bridge);
      bridge = tr.bridge;
      pos = tr.next;
    }

    if (pos !== end) throw new Error('WPPathCNative: trailing bytes');

    var useGroupLocal = !!(flag & FLAG_GROUP_LOCAL);
    return {
      meta: dec.meta,
      v1Frame: mergeV1Frame(groups, presence, headerPrefix, { groupLocalPrefix: useGroupLocal }),
      bridge: bridge,
      native: true,
      presence: presence,
      groupLocalPrefix: useGroupLocal,
      decodedGroupLocal: global.WPNativeV1Split
        ? global.WPNativeV1Split._lastDecodedGroupLocal : null
    };
  }

  global.WPPathCNative = {
    GROUP: GROUP,
    MANDATORY: NG ? NG.MANDATORY : {},
    FLAG_BRIDGE_V1: FLAG_BRIDGE_V1,
    FLAG_GROUP_LOCAL: FLAG_GROUP_LOCAL,
    splitV1Frame: splitV1Frame,
    mergeV1Frame: mergeV1Frame,
    wrapNative: wrapNative,
    unwrapNative: unwrapNative,
    mandatoryGroupIds: mandatoryGroupIds,
    presenceForRecord: presenceForRecord
  };

}(typeof window !== 'undefined' ? window : global));
