# XMR Accumulation Bot

## Setup

1. In Bitfinex, make a **sub-account** for this bot and move in only the XMR (or BTC) you want it to manage. The bot reads any non-bot wallet change as a deposit or withdrawal, so do not trade by hand in that account.
2. Create an API key for the sub-account with **Wallets: read**, **Orders: read and write**. Do **not** enable withdrawals. Add this server's IP to the key's allow list if you use one.
3. Open the dashboard and paste the key and secret under "Bitfinex API key".
4. Leave the bot in **DRY_RUN** for a few days. The Activity log shows each conversion it would make.
5. When happy: tick "Bot enabled", set Trading mode to **LIVE**, Save. Start with a small order size (default $1,000 per order).

## How it decides

Every minute it reads the daily XMR/BTC candles, inverts them, and applies the Larsson Line. After each UTC daily close, if the line says orange it wants BTC; otherwise XMR. It then converts the difference between your wallets and that target.

## Caps

All three caps are off by default; see Settings. The strategy entry cap changes *when the strategy enters*; the new-money cap changes *what happens to money you add*; the position cap limits the total size in BTC.

## Notes

- Fees and spread are paid on every rotation. The strategy trades rarely, but a backtest is not a promise.
- Experimental software; never risk more than you can afford to lose.
