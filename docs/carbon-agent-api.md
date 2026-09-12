# AI agents and webhooks

## Direct models

In **Settings → AI agents**, configure an OpenAI-compatible or Anthropic provider
with its endpoint, model and API key. Assign a task to the agent or mention it in a
comment to trigger a response.

## External webhooks

Choose **External webhook** and set an endpoint and optional shared secret.
Carbon posts task triggers to that endpoint. The client uses a scoped key to read
tasks and post comments or completions through the [REST API](api.md).

Personal keys support expiry and project subtree restrictions. Existing bot
integration keys retain their task and agent routes and assignment restrictions.
Revoke unused keys in Settings.
