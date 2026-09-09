# Billing configuration

Hosted payment actions are unavailable until Square is configured. Set
`SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_APP_ID`, `SQUARE_PLAN_Q3M`,
`SQUARE_PLAN_Y1`, and the webhook signature key and public webhook URL. Keep the
Square catalog at $7.50 AUD quarterly and $20 AUD annually. Trial duration is 30 days.

For development or tests only, set `CARBON_BILLING_SIMULATION=1` and
`NODE_ENV=development` or `NODE_ENV=test`. Simulation is always denied when
`NODE_ENV=production` or `ENV=production`. Missing provider configuration never
grants paid access. Self-hosted workspaces do not require billing configuration.
