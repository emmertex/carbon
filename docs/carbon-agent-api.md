# External webhook clients and built-in AI

Generic external webhooks remain supported. In Settings → AI agents, choose External
webhook, set its endpoint and optional shared secret, then create a scoped personal key under Settings → Personal API keys.
Carbon posts task triggers to that endpoint. Your client uses that key to read tasks and post replies/completions through the
REST API. Select the projects it needs and an expiry. Keep the secret out of logs.
Direct-model providers remain OpenAI-compatible and Anthropic.

For external clients acting as a human user, [personal API keys](api.md) offer expiry
and project subtree restrictions. Generic webhook bot integration keys retain their
existing task/agent route contract and assignment rules. Revoke unused keys in admin.
The Hermes-specific scripts and setup have been removed; the webhook protocol remains.
