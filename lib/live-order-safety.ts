export const LIVE_ORDER_CONFIRMATION_PHRASE = "I understand this places real exchange orders"

export function liveOrderPlacementEnabled(): boolean {
  return process.env.ALLOW_LIVE_ORDER_PLACEMENT === "1"
}

export function hasLiveOrderConfirmation(body: unknown): boolean {
  if (!body || typeof body !== "object") return false
  const payload = body as Record<string, unknown>
  return (
    payload.confirmLiveOrderPlacement === true ||
    payload.confirm_live_order_placement === true ||
    payload.liveOrderConfirmation === LIVE_ORDER_CONFIRMATION_PHRASE ||
    payload.live_order_confirmation === LIVE_ORDER_CONFIRMATION_PHRASE
  )
}

export function getLiveOrderSafetyFailure(body: unknown): string | null {
  if (!liveOrderPlacementEnabled()) {
    return "Live order placement is disabled on this server. Set ALLOW_LIVE_ORDER_PLACEMENT=1 only in an intentional, supervised trading environment."
  }

  if (!hasLiveOrderConfirmation(body)) {
    return `Live order placement requires explicit request confirmation: confirmLiveOrderPlacement=true or liveOrderConfirmation=\"${LIVE_ORDER_CONFIRMATION_PHRASE}\".`
  }

  return null
}
