# Fyxtez Terminal — Demo

Standalone paper-trading demo of the Fyxtez charting terminal.

## Demo safety

- No exchange credentials, API tokens, or private backend URLs are included.
- Trading actions are simulated in the browser and cannot place real orders.
- Demo balance, positions, orders, leverage and sizing are stored in `localStorage`.
- Market and Auto Market entries create visible paper positions with demo TP/SL zones.
- Limit, Add, Reduce, Reverse, Chase, Cancel, TP/SL and Close actions update the same local paper account.
- Public price ticks update demo PNL and can fill crossed limit/stop orders.
- Charts use public exchange market-data endpoints only.
- Notifications remain inside the browser; the production ntfy topic is not included.

## Run

```bash
npm install
npm run dev
```

To reset the paper account, clear this site's browser storage.
