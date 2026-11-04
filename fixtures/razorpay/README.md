# Razorpay settlement recon: SYNTHETIC demo fixtures

**These files are synthetic.** CloseLoop generated them from its own demo dataset (seed 42). They are not real Razorpay data. Every row carries `"notes": {"source": "SYNTHETIC: …"}`.

| File | Format |
|---|---|
| `recon-combined.synthetic.json` | The response shape of Razorpay's documented `GET /v1/settlements/recon/combined` (`{"entity": "collection", "count", "items": [...]}`), with items in the documented field order. This is the same data Razorpay's MCP server returns from `fetch_settlement_recon_details`. |
| `recon-combined.synthetic.csv` | The same rows, with the API's field names as headers. Amounts are integers in paise, as in the API. |

There are 4,864 rows: one per payment and refund in each of the demo data's 293 settlements. `settlement_utr` is the UTR of the bank transfer that paid the settlement. For the demo's consolidated payouts, several settlements share one UTR, the one printed on the bank statement. That shared UTR is what lets CloseLoop match a batched bank credit from the report instead of from amounts alone.

Use them with the MCP server's demo database (it seeds the same dataset on first run):

```
import_razorpay_recon({ "file_path": "/absolute/path/to/fixtures/razorpay/recon-combined.synthetic.json" })
run_reconciliation({ "from": "2026-10-01", "to": "2026-10-31" })
```

`npx -y closeloop-mcp demo-report recon.json` writes the same report without a clone. To regenerate these files, run `pnpm fixtures`; a test fails if they drift from the generator.
