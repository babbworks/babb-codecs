// native-groups-table.js — G0–G6 definitions + mandatory matrix + field split map
// Spec: system/dev_refs/NATIVE-GROUPS-TABLE.md
(function(global) {
  'use strict';

  var GROUP = { G0: 0, G1: 1, G2: 2, G3: 3, G4: 4, G5: 5, G6: 6 };

  var GROUP_NAME = [
    'identity', 'financial', 'time_place', 'references',
    'work_content', 'narrative_parties', 'chain_extensions'
  ];

  var MANDATORY = {
    invoice: [0, 1, 6], quote: [0, 1, 6], work_record: [0, 4], task: [0, 4],
    note: [0, 5], log: [0, 5], payment: [0, 1], schedule: [0, 2], broadcast: [0, 5],
    receipt: [0, 1, 6], contract: [0, 4, 6], order: [0, 1, 4], credit_note: [0, 1, 6],
    report: [0, 5], template: [0, 6], need: [0, 4], offer: [0, 4], connection: [0, 5],
    contact: [0], job: [0, 4], expense: [0, 1], amendment: [0], state_commit: [0, 1],
    ack: [0, 6], default: [0, 6]
  };

  /** field_flags / FLAGS3 / FLAGS4 bit → group for native split (phase 2) */
  var FIELD_GROUP = {
    field: {
      0: 0, 1: 0, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 0, 8: 0,
      9: 4, 10: 4, 11: 5, 12: 1, 13: 0, 14: 2
    },
    flags3: { 0: 0, 1: 3, 2: 3, 3: 2, 4: 3, 5: 0, 6: 3 },
    flags4_contact: { 0: 3, 1: 3, 2: 3, 3: 3, 4: 0, 5: 2 },
    flags4_financial: { 0: 3, 1: 3, 2: 2 }
  };

  var BLOCK_GROUP = {
    meta_ext_template: 0,
    setup_financial: 1,
    participants: 5,
    trig: 6,
    display_schema: 6,
    form_schema: 6,
    programmable: 6,
    chain_ref_inline: 5
  };

  function recordTypeKey(record) {
    return String((record && (record.record_type || record.recordType)) || 'job').toLowerCase();
  }

  function mandatoryGroupIds(record) {
    var key = recordTypeKey(record);
    return MANDATORY[key] || MANDATORY.default;
  }

  function presenceWithMandatory(record, splitPresence) {
    var pres = splitPresence || 0;
    var mand = mandatoryGroupIds(record);
    var i;
    for (i = 0; i < mand.length; i++) pres |= (1 << mand[i]);
    return pres & 0x7f;
  }

  /** Phase 3 — u8 group_local_flags prefix (Path C optional group hints) */
  var GROUP_LOCAL = {
    PROGRAMMABLE: 0x01,
    INFORMATIONAL_ACK: 0x02,
    DISPLAY: 0x04
  };

  function groupLocalFlags(g, record) {
    if (!record) return 0;
    var f = 0;
    if (g === 6) {
      if (Array.isArray(record.programmable_rules) && record.programmable_rules.length) {
        f |= GROUP_LOCAL.PROGRAMMABLE;
      }
      if (record.displaySchema || record.display_schema || record.formSchema || record.form_schema) {
        f |= GROUP_LOCAL.DISPLAY;
      }
    }
    if (g === 0 && record.informational_ack) f |= GROUP_LOCAL.INFORMATIONAL_ACK;
    return f & 0xff;
  }

  function anyGroupLocalFlags(record) {
    var g;
    for (g = 0; g <= 6; g++) {
      if (groupLocalFlags(g, record)) return true;
    }
    return false;
  }

  global.WPNativeGroups = {
    GROUP: GROUP,
    GROUP_NAME: GROUP_NAME,
    MANDATORY: MANDATORY,
    FIELD_GROUP: FIELD_GROUP,
    BLOCK_GROUP: BLOCK_GROUP,
    recordTypeKey: recordTypeKey,
    mandatoryGroupIds: mandatoryGroupIds,
    presenceWithMandatory: presenceWithMandatory,
    GROUP_LOCAL: GROUP_LOCAL,
    groupLocalFlags: groupLocalFlags,
    anyGroupLocalFlags: anyGroupLocalFlags
  };

}(typeof window !== 'undefined' ? window : global));
