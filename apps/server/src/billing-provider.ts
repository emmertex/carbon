/** Simulation is an explicit development/test capability, never a production fallback. */
export function billingProvider(configured: boolean, env: NodeJS.ProcessEnv = process.env): 'square' | 'simulate' | 'unavailable' {
  if (configured) return 'square';
  if (env.CARBON_BILLING_SIMULATION === '1' &&
      (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') &&
      env.ENV !== 'production') return 'simulate';
  return 'unavailable';
}
