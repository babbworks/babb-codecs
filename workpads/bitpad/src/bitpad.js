// bitpad.js — bitpad-v1 binary frame encoder/decoder
// Spec: workpads-standard/bitpad-record-encoding.md
// Pure JS, no external dependencies. Compatible with Gecko 48+ and Node.js 14+.

'use strict';

var TEMPLATE_SVC_BASIC_V2 = 0x01;

// Scalar fields in bit-position order (bits 0-8, 10, 11)
var SCALAR_FIELDS = [
  { id: 'job',            bit: 0  },
  { id: 'customer',       bit: 1  },
  { id: 'date',           bit: 2  },
  { id: 'location',       bit: 3  },
  { id: 'meeting_time',   bit: 4  },
  { id: 'start_time',     bit: 5  },
  { id: 'end_time',       bit: 6  },
  { id: 'customer_phone', bit: 7  },
  { id: 'worker',         bit: 8  },
  { id: 'details',        bit: 10 },
  { id: 'story',          bit: 11 },
];

var ACTIONS_BIT = 9;
var MAX_ACTIONS = 20;

// UTF-8 helpers — work in both browser (TextEncoder) and Node.js (Buffer)
function toUtf8(str) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str);
  }
  return new Uint8Array(Buffer.from(str, 'utf8'));
}

function fromUtf8(bytes) {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(bytes).toString('utf8');
}

// Write big-endian uint16 into buf at offset
function writeU16(buf, offset, value) {
  buf[offset]     = (value >>> 8) & 0xff;
  buf[offset + 1] = value & 0xff;
}

// Read big-endian uint16 from buf at offset
function readU16(buf, offset) {
  return ((buf[offset] & 0xff) << 8) | (buf[offset + 1] & 0xff);
}

// Encode a svc-basic v2 record to a bitpad-v1 Uint8Array frame.
// record: plain object with field IDs as keys.
// Returns: Uint8Array
function encode(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('bitpad.encode: record must be an object');
  }

  // --- Pass 1: encode all present field values to UTF-8 bytes and build flags ---
  var flags = 0;
  var scalarBytes = {};  // field id -> Uint8Array

  for (var i = 0; i < SCALAR_FIELDS.length; i++) {
    var f = SCALAR_FIELDS[i];
    var val = record[f.id];
    if (val !== null && val !== undefined) {
      var bytes = toUtf8(String(val));
      scalarBytes[f.id] = bytes;
      flags |= (1 << f.bit);
    }
  }

  // Actions array
  var actions = record.actions;
  var hasActions = Array.isArray(actions) && actions.length > 0;
  var actionItems = hasActions ? actions.slice(0, MAX_ACTIONS) : [];
  if (hasActions || (Array.isArray(actions) && actions.length === 0)) {
    // include actions block if array is present (even if empty)
    if (Array.isArray(actions)) {
      flags |= (1 << ACTIONS_BIT);
    }
  }
  // re-encode: actions bit is set if actions array exists (including empty)
  if (Array.isArray(record.actions)) {
    flags |= (1 << ACTIONS_BIT);
    actionItems = record.actions.slice(0, MAX_ACTIONS);
  }

  // Encode action title/notes bytes
  var actionBytes = actionItems.map(function(a) {
    return {
      title: toUtf8(a && a.title ? String(a.title) : ''),
      notes: toUtf8(a && a.notes ? String(a.notes) : ''),
    };
  });

  // --- Pass 2: calculate total buffer size ---
  var size = 3; // 1 template byte + 2 flag bytes

  for (var j = 0; j < SCALAR_FIELDS.length; j++) {
    var sf = SCALAR_FIELDS[j];
    if (scalarBytes[sf.id]) {
      size += 2 + scalarBytes[sf.id].length; // uint16 len + bytes
    }
  }

  if (flags & (1 << ACTIONS_BIT)) {
    size += 1; // count byte
    for (var k = 0; k < actionBytes.length; k++) {
      size += 2 + actionBytes[k].title.length; // title len + bytes
      size += 2 + actionBytes[k].notes.length; // notes len + bytes
    }
  }

  // --- Pass 3: write buffer ---
  var buf = new Uint8Array(size);
  var pos = 0;

  buf[pos++] = TEMPLATE_SVC_BASIC_V2;
  writeU16(buf, pos, flags); pos += 2;

  // Write scalar fields in bit order 0 → 11
  for (var m = 0; m < SCALAR_FIELDS.length; m++) {
    var sf2 = SCALAR_FIELDS[m];
    if (sf2.bit < ACTIONS_BIT) {
      // bits 0-8: write before actions
      if (scalarBytes[sf2.id]) {
        var sb = scalarBytes[sf2.id];
        writeU16(buf, pos, sb.length); pos += 2;
        buf.set(sb, pos); pos += sb.length;
      }
    }
  }

  // Write actions block (bit 9) if present
  if (flags & (1 << ACTIONS_BIT)) {
    buf[pos++] = actionItems.length;
    for (var n = 0; n < actionBytes.length; n++) {
      var ab = actionBytes[n];
      writeU16(buf, pos, ab.title.length); pos += 2;
      buf.set(ab.title, pos); pos += ab.title.length;
      writeU16(buf, pos, ab.notes.length); pos += 2;
      buf.set(ab.notes, pos); pos += ab.notes.length;
    }
  }

  // Write scalar fields bits 10-11 (details, story) after actions
  for (var p = 0; p < SCALAR_FIELDS.length; p++) {
    var sf3 = SCALAR_FIELDS[p];
    if (sf3.bit > ACTIONS_BIT) {
      if (scalarBytes[sf3.id]) {
        var sb3 = scalarBytes[sf3.id];
        writeU16(buf, pos, sb3.length); pos += 2;
        buf.set(sb3, pos); pos += sb3.length;
      }
    }
  }

  return buf;
}

// Decode a bitpad-v1 Uint8Array frame to a svc-basic v2 record object.
// bytes: Uint8Array
// Returns: plain object
function decode(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('bitpad.decode: bytes must be a Uint8Array');
  }
  if (bytes.length < 3) {
    throw new Error('bitpad.decode: frame too short');
  }

  var pos = 0;
  var templateId = bytes[pos++];
  if (templateId !== TEMPLATE_SVC_BASIC_V2) {
    throw new Error('bitpad.decode: unknown template id 0x' + templateId.toString(16));
  }

  var flags = readU16(bytes, pos); pos += 2;
  var record = {};

  // Helper: read a scalar block
  function readScalar() {
    var len = readU16(bytes, pos); pos += 2;
    var text = fromUtf8(bytes.subarray(pos, pos + len)); pos += len;
    return text;
  }

  // Read scalar fields bits 0-8 in order
  for (var i = 0; i < SCALAR_FIELDS.length; i++) {
    var f = SCALAR_FIELDS[i];
    if (f.bit < ACTIONS_BIT) {
      if (flags & (1 << f.bit)) {
        record[f.id] = readScalar();
      }
    }
  }

  // Read actions block (bit 9) if present
  if (flags & (1 << ACTIONS_BIT)) {
    var count = bytes[pos++];
    var actions = [];
    for (var k = 0; k < count; k++) {
      var titleLen = readU16(bytes, pos); pos += 2;
      var title = fromUtf8(bytes.subarray(pos, pos + titleLen)); pos += titleLen;
      var notesLen = readU16(bytes, pos); pos += 2;
      var notes = fromUtf8(bytes.subarray(pos, pos + notesLen)); pos += notesLen;
      actions.push({ title: title, notes: notes });
    }
    record.actions = actions;
  }

  // Read scalar fields bits 10-11 in order
  for (var j = 0; j < SCALAR_FIELDS.length; j++) {
    var sf = SCALAR_FIELDS[j];
    if (sf.bit > ACTIONS_BIT) {
      if (flags & (1 << sf.bit)) {
        record[sf.id] = readScalar();
      }
    }
  }

  return record;
}

module.exports = {
  encode: encode,
  decode: decode,
  TEMPLATE_SVC_BASIC_V2: TEMPLATE_SVC_BASIC_V2,
};
