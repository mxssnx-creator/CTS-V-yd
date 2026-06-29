import "./../lib/instrumentation";
import { createExchangeConnector } from "@/lib/exchange-connectors"
import { BASE_CONNECTION_CREDENTIALS } from "@/lib/base-connection-credentials"

async function main() {
  if (process.env.ALLOW_LIVE_ORDER_PLACEMENT !== "1") {
    console.error(
      "[test] Refusing to place a live market order. Set ALLOW_LIVE_ORDER_PLACEMENT=1 only when intentional real/testnet order placement is acceptable.",
    )
    process.exit(2)
  }

  const creds = BASE_CONNECTION_CREDENTIALS["bingx-x01"]
  console.log('[test] Using stored base credentials for bingx-x01 (apiKey masked)')
  const connector = await createExchangeConnector('bingx', {
    apiKey: creds.apiKey,
    apiSecret: creds.apiSecret,
    apiPassphrase: '',
    isTestnet: true,
    apiType: 'perpetual_futures',
    contractType: 'usdt-perpetual'
  })

  if (!connector) {
    console.error('Failed to create connector')
    process.exit(1)
  }

  console.log('Connector created, testing account balance...')
  const bal = await connector.getBalance().catch(e => ({ success: false, error: String(e) }))
  console.log('Balance result:', bal)

  console.log('Placing market order (small qty)')
  const res = await connector.placeOrder('PLAYSOUTUSDT', 'buy', 0.1, undefined, 'market').catch(e => ({ success: false, error: String(e) }))
  console.log('PlaceOrder result:', res)
}

main().catch(e => { console.error(e); process.exit(1) })
