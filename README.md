# @workpads/codec

Workpads record encoder and decoder. Implements the **pads-v1** binary frame format (`codec.md` §5) with fflate DEFLATE compression and base64url URL encoding.

Compatible with Node.js (>= 14). Used by **workpads-cli** v0.2+ and tested for interop with **workpadskaios** (`test/flow.test.js` in the KaiOS repo).

**Cross-repo process:** [`workpadskaios/system/project-process.md`](../workpadskaios/system/project-process.md)

---

## Install

```bash
npm install @workpads/codec
```

Or use directly from a local path during development:

```json
{ "@workpads/codec": "file:../workpads-codec" }
```

---

## Usage

```js
const { encode, decode, validate } = require('@workpads/codec');

const record = {
  job: 'Replace faucet',
  customer: 'Alice Smith',
  date: '2026-04-27',
  location: '11 River Rd',
  worker: 'Bob Jones',
  actions: [
    { title: 'Arrive', notes: 'Check scope' },
    { title: 'Install', notes: 'Replace fixture' },
  ],
};

const v = validate(record);
if (!v.valid) throw new Error(v.errors.join(', '));

const url = encode(record);
console.log(url);
// -> workpads.me/p#1pa/<base64url>

const decoded = decode(url);
console.log(decoded.job); // -> 'Replace faucet'
```

---

## API

### `encode(record, opts?) -> string`

Returns a full share URL: `workpads.me/p#1pa/<payload>`.

### `decode(urlOrHash) -> record`

Accepts full URL or hash fragment. Decodes `#1pa/` (pads-v1) and legacy schemes (`1ag/`, `1bg/`, `alg=bitpad-v1`) for compatibility.

### `validate(record) -> { valid, errors }`

Requires `job`. `actions` must be an array of `{ title, notes? }` objects when present.

### `encodeBinary(record)` / `decodeBinary(buffer)`

`[3-byte tag 1pa][deflated frame]` for `.wpf` files (see `workpads-cli/workpads-file-format.md`).

---

## pads-v1 wire format (summary)

- **Scheme tag:** `#1pa/` (pads-v1 codebook `a`)
- **Compression:** `fflate.deflateSync` level 9 (zlib wrapper)
- **Frame:** meta bytes + `field_flags` (+ optional FLAGS3/FLAGS4) + conditional blocks
- **Actions on wire:** newline-joined action **titles** (notes are not preserved on decode)

Normative detail: [`workpads-standard/codec.md`](../workpads-standard/codec.md).

The KaiOS app inlines a larger copy in `workpadskaios/js/lib/codec.js` (presentation `#1pb/`, security `#1ps/`, legacy decoders). Plain `#1pa/` records must round-trip between this package and KaiOS.

---

## Test

```bash
node test/codec.test.js
```

---

## Related

| Repo | Description |
|------|-------------|
| `workpads-standard/` | Normative specification |
| `workpads-cli/` | CLI consumer (v0.2+) |
| `workpadskaios/` | KaiOS app — inlined codec + `flow.test.js` interop |
