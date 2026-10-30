export const short = {
  en_US: 'Accumulates XMR on Bitfinex by rotating between XMR and BTC with a mirrored Larsson Line',
}

export const long = {
  en_US:
    'Runs the Larsson Line on BTC priced in XMR (the inverted XMR/BTC chart). When the BTC trend turns up the bot holds BTC; when it ends the bot rotates back to XMR. ' +
    'Success is measured in XMR, not USD. Orders are small limit orders, one at a time, routed through the USDT pairs. ' +
    'Optional caps (off by default): a strategy entry cap, and a separate cap for new money added mid-uptrend. ' +
    'Boots disabled and in dry-run mode: it will not place real orders until you enable it and switch on live trading. Use a dedicated Bitfinex sub-account.',
}
