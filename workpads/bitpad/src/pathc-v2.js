// pathc-v2.js — Path C header + pads-v1 payload bridge for #1pv/
// Spec: FRAME-SPEC-1pv-ADDENDUM.md §bridge-v1, CODEC-V2-SCOPE-LOCKED.md
// Load before codec.js; exposes window.WPPathC

(function(global) {
  'use strict';

  var FLAG_BRIDGE_V1   = 0x01;
  var FLAG_HAS_REL     = 0x02;
  var FLAG_HAS_ACK     = 0x04;
  var FLAG_HAS_V4_EXT  = 0x08;
  var FLAG_CRC         = 0x80;

  var V4_RELATIONAL    = 0x01;
  var V4_CHAIN_REF24   = 0x02;
  var V4_PROFILE_ID    = 0x04;
  var V4_TABLE_ENTRY   = 0x08;

  var RELATIONSHIP = {
    creates: 0, amends: 1, acknowledges: 2, pays: 3,
    disputes: 4, reverses: 5, responds: 6, confirms: 7
  };

  var RELATIONSHIP_NAME = [
    'creates', 'amends', 'acknowledges', 'pays',
    'disputes', 'reverses', 'responds', 'confirms'
  ];

  var TYPE_TO_BYTE = {
    invoice: 0x01, quote: 0x02, work_record: 0x03, task: 0x04,
    note: 0x05, log: 0x06, payment: 0x07, schedule: 0x08,
    broadcast: 0x09, receipt: 0x0a, contract: 0x0b, order: 0x0c,
    credit_note: 0x0d, report: 0x0e, template: 0x0f,
    need: 0x16, offer: 0x17, connection: 0x18,
    contact: 0x20, job: 0x21, expense: 0x22
  };

  var BYTE_TO_TYPE = {};
  var k;
  for (k in TYPE_TO_BYTE) BYTE_TO_TYPE[TYPE_TO_BYTE[k]] = k;

  var SHORTCUT_NIBBLE = {
    invoice: 0x1, work_record: 0x3, note: 0x4, log: 0x5, payment: 0x6
  };

  var CHAIN_MODE = {
    INITIATING: 0, LIVE: 1, INFORMATIONAL: 2, CLOSING: 3,
    DISPUTING: 4, WITNESSING: 5
  };

  function typeByte(record) {
    var rt = (record.record_type || record.recordType || 'job').toLowerCase();
    return TYPE_TO_BYTE[rt] != null ? TYPE_TO_BYTE[rt] : 0x21;
  }

  function chainModeBits(record) {
    var m = (record.chain_mode || record.chainMode || 'LIVE').toUpperCase();
    return CHAIN_MODE[m] != null ? CHAIN_MODE[m] : 1;
  }

  function d1Priority(record) {
    return record.priority || record.d1_priority ? 1 : 0;
  }

  function encodeDByte(record) {
    var b = 0;
    if (record.draft) b |= 0x04; // D0 in D-byte bit 2 per Path C spec
    if (record.restrict_forward) b |= 0x20;
    if (record.ack_request) b |= 0x10;
    return b;
  }

  /** Standard-path header (3 bytes) + uint16 v1 lengthdiv; variable groups deferred to v1 body. */
  function encodeStandardHeader(record) {
    var tb = typeByte(record);
    var b1 = d1Priority(record);
    if (tb === 0x01 || tb === 0x02) {
      b1 |= (chainModeBits(record) & 7) << 4;
    }
    return new Uint8Array([tb, b1, encodeDByte(record)]);
  }

  function canShortcut(record) {
    var rt = (record.record_type || record.recordType || '').toLowerCase();
    return SHORTCUT_NIBBLE[rt] != null && !record.chain_mode && !record.chainMode;
  }

  function encodeShortcutHeader(record) {
    var rt = (record.record_type || record.recordType || 'invoice').toLowerCase();
    var nib = SHORTCUT_NIBBLE[rt] || 0x1;
    var d = 0;
    if (d1Priority(record)) d |= 0x01;
    if (record.draft) d |= 0x02;
    return new Uint8Array([0x00, (nib << 4) | (d & 0x0f)]);
  }

  function encodeHeader(record, opts) {
    opts = opts || {};
    if (opts.forceStandard || !canShortcut(record)) return encodeStandardHeader(record);
    return encodeShortcutHeader(record);
  }

  function readU16LE(buf, pos) {
    return (buf[pos] & 0xff) | ((buf[pos + 1] & 0xff) << 8);
  }

  function writeU16LE(buf, pos, v) {
    buf[pos] = v & 0xff;
    buf[pos + 1] = (v >> 8) & 0xff;
  }

  function crc16Ccitt(bytes) {
    var crc = 0xffff;
    var i, j, b;
    for (i = 0; i < bytes.length; i++) {
      crc ^= (bytes[i] & 0xff) << 8;
      for (j = 0; j < 8; j++) {
        if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xffff;
        else crc = (crc << 1) & 0xffff;
      }
    }
    return crc;
  }

  function relationshipCore(name) {
    if (name == null) return null;
    var n = String(name).toLowerCase();
    return RELATIONSHIP[n] != null ? RELATIONSHIP[n] : null;
  }

  function encodeRelationshipByte(core, subtype) {
    var c = (typeof core === 'string') ? relationshipCore(core) : (core & 0x0f);
    if (c == null) c = 6;
    var s = (subtype != null && subtype !== '') ? (Number(subtype) & 0x0f) : 0;
    return new Uint8Array([(c & 0x0f) | ((s & 0x0f) << 4)]);
  }

  function decodeRelationshipByte(b) {
    var core = b & 0x0f;
    var subtype = (b >> 4) & 0x0f;
    var unknown = false;
    if (core > 7) {
      core = 6;
      unknown = true;
    }
    return {
      core: core,
      name: RELATIONSHIP_NAME[core] || 'responds',
      subtype: subtype,
      unknown: unknown
    };
  }

  function inferRelationship(record) {
    if (!record) return null;
    if (record.relationship) return String(record.relationship).toLowerCase();
    var rt = (record.record_type || record.recordType || '').toLowerCase();
    if (rt === 'amendment' || record.disputeLink) return 'amends';
    if (rt === 'dispute') return 'disputes';
    if (rt === 'payment') return 'pays';
    if (rt === 'ack') return 'acknowledges';
    if (rt === 'state_commit') return 'confirms';
    if (record._amendedFromId || record._disputedId) return 'amends';
    if (record.chainRef || record._chainRef) return 'creates';
    return null;
  }

  function hasAckMasks(record) {
    if (!record) return false;
    return record.confirmed_mask != null || record.declined_mask != null ||
      record.confirmedMask != null || record.declinedMask != null;
  }

  function ackMasksFromRecord(record) {
    var cm = record.confirmed_mask != null ? record.confirmed_mask : record.confirmedMask;
    var dm = record.declined_mask != null ? record.declined_mask : record.declinedMask;
    return {
      confirmed: (cm != null ? Number(cm) : 0) & 0xffff,
      declined: (dm != null ? Number(dm) : 0) & 0xffff
    };
  }

  function encodeAckMasksBuf(record) {
    var m = ackMasksFromRecord(record);
    var buf = new Uint8Array(4);
    writeU16LE(buf, 0, m.confirmed);
    writeU16LE(buf, 2, m.declined);
    return buf;
  }

  function readU24LE(buf, pos) {
    return (buf[pos] & 0xff) | ((buf[pos + 1] & 0xff) << 8) | ((buf[pos + 2] & 0xff) << 16);
  }

  function encodeV4Extension(record, opts) {
    opts = opts || {};
    record = record || {};
    var extFlags = 0;
    if (opts.relationalMode || record.relational_mode) extFlags |= V4_RELATIONAL;
    var chainRef24 = opts.chainRef24 != null ? opts.chainRef24 : record.chain_seq_compact;
    if (chainRef24 != null) extFlags |= V4_CHAIN_REF24;

    var profileByte = null;
    if (opts.profileId != null) {
      profileByte = Number(opts.profileId) & 0xff;
      extFlags |= V4_PROFILE_ID;
    } else if (global.WPDomainProfile) {
      var pb = global.WPDomainProfile.profileByteForRecord(record);
      if (pb > 0) {
        profileByte = pb;
        extFlags |= V4_PROFILE_ID;
      }
    }

    var tableBuf = null;
    if (opts.inlineTableEntry) {
      tableBuf = global.WPSymbolTable
        ? global.WPSymbolTable.encodeInlineEntry(opts.inlineTableEntry)
        : null;
    } else if (opts.counterpartyKey && global.WPSymbolTable) {
      var pending = global.WPSymbolTable.takeNextInlineEntry(opts.counterpartyKey);
      if (pending) tableBuf = global.WPSymbolTable.encodeInlineEntry(pending);
    }
    if (tableBuf && tableBuf.length) extFlags |= V4_TABLE_ENTRY;

    if (!extFlags) return null;

    var parts = [new Uint8Array([extFlags])];
    if (extFlags & V4_CHAIN_REF24) {
      var ref = Number(chainRef24) & 0xffffff;
      parts.push(new Uint8Array([ref & 0xff, (ref >> 8) & 0xff, (ref >> 16) & 0xff]));
    }
    if (extFlags & V4_PROFILE_ID) parts.push(new Uint8Array([profileByte & 0xff]));
    if (extFlags & V4_TABLE_ENTRY && tableBuf) parts.push(tableBuf);
    return concatParts(parts);
  }

  function decodeV4Extension(bytes, pos, end) {
    if (pos >= end) throw new Error('WPPathC: missing v4 extension');
    var extFlags = bytes[pos++];
    var v4 = { relational_mode: !!(extFlags & V4_RELATIONAL) };
    if (extFlags & V4_CHAIN_REF24) {
      if (pos + 3 > end) throw new Error('WPPathC: truncated chain_ref24');
      v4.chain_seq_compact = readU24LE(bytes, pos);
      pos += 3;
    }
    if (extFlags & V4_PROFILE_ID) {
      if (pos >= end) throw new Error('WPPathC: missing profile_id byte');
      var pb = bytes[pos++];
      if (global.WPDomainProfile) v4.profile_id = global.WPDomainProfile.profileNameFromByte(pb);
      else v4.profile_id_byte = pb;
    }
    if (extFlags & V4_TABLE_ENTRY) {
      if (pos >= end) throw new Error('WPPathC: missing table entry length');
      var elen = bytes[pos];
      if (pos + 1 + elen > end) throw new Error('WPPathC: truncated table entry');
      if (global.WPSymbolTable) {
        v4.inline_table_entry = global.WPSymbolTable.decodeInlineEntry(bytes.subarray(pos));
      }
      pos += 1 + elen;
    }
    return { v4: v4, next: pos };
  }

  function concatParts(parts) {
    var len = 0, i;
    for (i = 0; i < parts.length; i++) len += parts[i].length;
    var out = new Uint8Array(len);
    var off = 0;
    for (i = 0; i < parts.length; i++) {
      out.set(parts[i], off);
      off += parts[i].length;
    }
    return out;
  }

  /**
   * Wrap pads-v1 frame bytes in 1pv bridge envelope.
   * Layout: [flag][pathC header][u16 v1_len][v1 bytes][rel?][ack?][crc16?]
   */
  function wrapV1Frame(v1Frame, record, opts) {
    opts = opts || {};
    var useCrc = opts.crc !== false;
    record = record || {};
    var relName = opts.relationship || inferRelationship(record);
    var relCore = relationshipCore(relName);
    var hasRel = relCore != null || opts.relationshipByte != null;
    var hasAck = hasAckMasks(record) || opts.confirmed_mask != null || opts.declined_mask != null;
    var v4Ext = encodeV4Extension(record, opts);
    var flag = FLAG_BRIDGE_V1 | (useCrc ? FLAG_CRC : 0);
    if (hasRel) flag |= FLAG_HAS_REL;
    if (hasAck) flag |= FLAG_HAS_ACK;
    if (v4Ext) flag |= FLAG_HAS_V4_EXT;
    var hdr = encodeHeader(record, opts);
    var len = v1Frame.length;
    var lenBuf = new Uint8Array(2);
    writeU16LE(lenBuf, 0, len);
    var parts = [new Uint8Array([flag]), hdr, lenBuf, v1Frame];
    if (hasRel) {
      parts.push(opts.relationshipByte ||
        encodeRelationshipByte(relName || relCore, record.relationship_subtype));
    }
    if (hasAck) {
      parts.push(encodeAckMasksBuf({
        confirmed_mask: opts.confirmed_mask != null ? opts.confirmed_mask : record.confirmed_mask,
        declined_mask: opts.declined_mask != null ? opts.declined_mask : record.declined_mask,
        confirmedMask: record.confirmedMask,
        declinedMask: record.declinedMask
      }));
    }
    if (v4Ext) parts.push(v4Ext);
    var body = concatParts(parts);
    if (!useCrc) return body;
    var crc = crc16Ccitt(body);
    var crcBuf = new Uint8Array(2);
    writeU16LE(crcBuf, 0, crc);
    return concatParts([body, crcBuf]);
  }

  function decodeHeaderMeta(bytes, pos) {
    var meta = { path: 'standard', typeByte: 0, recordType: 'job', chain_mode: 'LIVE', draft: false, priority: false };
    if (bytes[pos] === 0x00) {
      meta.path = 'shortcut';
      var sc = bytes[pos + 1];
      var nib = (sc >> 4) & 0x0f;
      meta.typeByte = nib;
      meta.recordType = BYTE_TO_TYPE[nib] || ('type_' + nib);
      meta.priority = !!(sc & 0x01);
      meta.draft = !!(sc & 0x02);
      return { meta: meta, headerLen: 2, next: pos + 2 };
    }
    meta.typeByte = bytes[pos];
    meta.recordType = BYTE_TO_TYPE[meta.typeByte] || ('byte_' + meta.typeByte);
    var b1 = bytes[pos + 1];
    meta.priority = !!(b1 & 0x01);
    var cm = (b1 >> 4) & 7;
    var names = ['INITIATING', 'LIVE', 'INFORMATIONAL', 'CLOSING', 'DISPUTING', 'WITNESSING'];
    meta.chain_mode = names[cm] || 'LIVE';
    meta.draft = !!(bytes[pos + 2] & 0x04);
    return { meta: meta, headerLen: 3, next: pos + 3 };
  }

  /**
   * Unwrap to raw v1 frame bytes. Throws on CRC mismatch.
   */
  function unwrapToV1Frame(bytes) {
    if (!bytes || bytes.length < 6) throw new Error('WPPathC: 1pv frame too short');
    var flag = bytes[0];
    if ((flag & FLAG_BRIDGE_V1) === 0) throw new Error('WPPathC: not bridge-v1 flag');
    var useCrc = !!(flag & FLAG_CRC);
    var end = bytes.length - (useCrc ? 2 : 0);
    if (useCrc) {
      var expect = readU16LE(bytes, end);
      var got = crc16Ccitt(bytes.subarray(0, end));
      if (got !== expect) throw new Error('WPPathC: CRC-16 mismatch');
    }
    var dec = decodeHeaderMeta(bytes, 1);
    var lenPos = dec.next;
    var v1Len = readU16LE(bytes, lenPos);
    var v1Start = lenPos + 2;
    if (v1Start + v1Len > end) throw new Error('WPPathC: v1 payload length overflow');
    var pos = v1Start + v1Len;
    var bridge = {};
    if (flag & FLAG_HAS_REL) {
      if (pos >= end) throw new Error('WPPathC: missing relationship byte');
      var rd = decodeRelationshipByte(bytes[pos++]);
      bridge.relationship = rd.name;
      bridge.relationship_subtype = rd.subtype;
      if (rd.unknown) bridge._relationshipUnknown = true;
    }
    if (flag & FLAG_HAS_ACK) {
      if (pos + 4 > end) throw new Error('WPPathC: missing ack masks');
      bridge.confirmed_mask = readU16LE(bytes, pos); pos += 2;
      bridge.declined_mask = readU16LE(bytes, pos); pos += 2;
    }
    if (flag & FLAG_HAS_V4_EXT) {
      var v4dec = decodeV4Extension(bytes, pos, end);
      bridge.v4 = v4dec.v4;
      pos = v4dec.next;
    }
    if (pos !== end) throw new Error('WPPathC: trailing bridge bytes');
    return {
      meta: dec.meta,
      v1Frame: bytes.subarray(v1Start, v1Start + v1Len),
      bridge: bridge
    };
  }

  function attachMetaToRecord(record, meta, bridge) {
    if (!record) return record;
    record._pathc = meta;
    if (meta.recordType && !record.record_type) record.record_type = meta.recordType;
    if (meta.chain_mode) record.chain_mode = meta.chain_mode;
    if (meta.draft) record.draft = true;
    if (meta.priority) record.priority = true;
    record._codec = '1pv';
    bridge = bridge || {};
    if (bridge.relationship) record.relationship = bridge.relationship;
    if (bridge.relationship_subtype != null) record.relationship_subtype = bridge.relationship_subtype;
    if (bridge._relationshipUnknown) record._relationshipUnknown = true;
    if (bridge.confirmed_mask != null) record.confirmed_mask = bridge.confirmed_mask;
    if (bridge.declined_mask != null) record.declined_mask = bridge.declined_mask;
    if (bridge.v4 && global.WPRelationalCodec) global.WPRelationalCodec.applyDecoded(record, bridge);
    else if (bridge.v4) {
      if (bridge.v4.relational_mode) record.relational_mode = true;
      if (bridge.v4.chain_seq_compact != null) record.chain_seq_compact = bridge.v4.chain_seq_compact;
      if (bridge.v4.profile_id) record.profile_id = bridge.v4.profile_id;
      if (bridge.v4.inline_table_entry) record._inline_table_entry = bridge.v4.inline_table_entry;
    }
    return record;
  }

  global.WPPathC = {
    CODEBOOK: '1pv',
    FLAG_HAS_REL: FLAG_HAS_REL,
    FLAG_HAS_ACK: FLAG_HAS_ACK,
    FLAG_HAS_V4_EXT: FLAG_HAS_V4_EXT,
    V4_RELATIONAL: V4_RELATIONAL,
    encodeV4Extension: encodeV4Extension,
    decodeV4Extension: decodeV4Extension,
    RELATIONSHIP: RELATIONSHIP,
    RELATIONSHIP_NAME: RELATIONSHIP_NAME,
    TYPE_TO_BYTE: TYPE_TO_BYTE,
    BYTE_TO_TYPE: BYTE_TO_TYPE,
    wrapV1Frame: wrapV1Frame,
    unwrapToV1Frame: unwrapToV1Frame,
    encodeHeader: encodeHeader,
    decodeHeaderMeta: decodeHeaderMeta,
    encodeRelationshipByte: encodeRelationshipByte,
    decodeRelationshipByte: decodeRelationshipByte,
    encodeAckMasksBuf: encodeAckMasksBuf,
    inferRelationship: inferRelationship,
    crc16Ccitt: crc16Ccitt,
    attachMetaToRecord: attachMetaToRecord
  };

}(typeof window !== 'undefined' ? window : global));
