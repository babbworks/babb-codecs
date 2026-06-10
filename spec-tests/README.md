# spec-tests — workpads-codec

Cross-implementation conformance for npm consumers.

| Asset | Role |
|-------|------|
| `test/fixtures/1pv-vectors.json` | Eight native-2b scenarios — sync with kaios |
| `test/1pv-fixtures.test.js` | Round-trip decode per vector |
| `test/native-v1-split.test.js` | G2/G4 split + merge |

Regenerate vectors from kaios: `node scripts/regen-1pv-vectors.js` (writes both repos).

**Run:** `npm test`

---

_End._
