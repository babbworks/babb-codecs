// Relational encode opts — v0.4 scaffold (gated by ui-phase relational_encode)
// Exposes: window.WPRelationalCodec

(function(global) {
  'use strict';

  function buildEncodeOpts(rec, baseOpts) {
    if (!rec) return {};
    var phaseOn = global.UIPhase && UIPhase.isOn('relational_encode');
    var peer = rec.linkedContactId || rec.counterparty_id || rec.linked_contact_id;
    var hasSymbols = peer && global.WPSymbolTable && WPSymbolTable.hasInlinePending(peer);
    if (!phaseOn && !rec.relational_mode && !hasSymbols && !(baseOpts && baseOpts.relationalMode)) {
      return {};
    }

    var out = {};

    if (rec.relational_mode) out.relationalMode = true;

    if (rec.chain_seq_compact != null) {
      out.chainRef24 = Number(rec.chain_seq_compact) & 0xffffff;
      out.relationalMode = true;
    }

    if (global.WPDomainProfile) {
      var pb = WPDomainProfile.profileByteForRecord(rec);
      if (pb > 0) {
        out.profileId = pb;
        out.relationalMode = true;
      }
    }

    if (peer && global.WPSymbolTable && WPSymbolTable.hasInlinePending(peer)) {
      out.counterpartyKey = String(peer);
      out.relationalMode = true;
    }

    if (baseOpts && baseOpts.relationalMode) out.relationalMode = true;
    if (baseOpts && baseOpts.chainRef24 != null) out.chainRef24 = baseOpts.chainRef24;
    if (baseOpts && baseOpts.profileId != null) out.profileId = baseOpts.profileId;
    if (baseOpts && baseOpts.counterpartyKey) out.counterpartyKey = baseOpts.counterpartyKey;

    return out;
  }

  function applyDecoded(rec, bridge) {
    if (!rec || !bridge || !bridge.v4) return rec;
    var v4 = bridge.v4;
    if (v4.relational_mode) rec.relational_mode = true;
    if (v4.chain_seq_compact != null) rec.chain_seq_compact = v4.chain_seq_compact;
    if (v4.profile_id) rec.profile_id = v4.profile_id;
    if (v4.inline_table_entry) {
      rec._inline_table_entry = v4.inline_table_entry;
      var peer = rec.linkedContactId || rec.counterparty_id;
      if (peer && global.WPSymbolTable) {
        WPSymbolTable.applyDecodedEntry(String(peer), v4.inline_table_entry);
      }
    }
    rec._codec_v4 = true;
    return rec;
  }

  global.WPRelationalCodec = {
    buildEncodeOpts: buildEncodeOpts,
    applyDecoded: applyDecoded
  };

}(typeof window !== 'undefined' ? window : global));
