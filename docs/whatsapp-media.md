# WhatsApp Media (Standalone)

Language: **English** | [Português (pt-BR)](whatsapp-media.pt-BR.md)

This project does not depend on `backend-whatsapp-api` for media send/download.

All message and file exchange runs internally through Baileys (`@whiskeysockets/baileys`).

## How it works

- Send text/image: `src/services/whatsapp.js` (`sendMessage`, `sendImage`)
- Receive audio/image: Baileys `messages.upsert` listener
- Download incoming media: Baileys `downloadMediaMessage`

## Incoming media flow

1. Message arrives in Baileys socket.
2. Internal payload is routed to `src/services/inbound-core.js`.
3. Media is downloaded and saved to `RUNS_DIR/<taskId>/inbox/<messageId>/`.
4. Audio is transcribed (OpenAI Whisper) and image is described (OpenRouter multimodal).
5. Result is converted to canonical text for orchestrator input.

## Note

The HTTP `/webhook` endpoint remains available for compatibility, but standalone Baileys mode is the recommended path.
