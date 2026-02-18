# Mídia do WhatsApp (Standalone)

Idioma: [English](whatsapp-media.md) | **Português (pt-BR)**

Este projeto não depende de `backend-whatsapp-api` para enviar/baixar mídia.

Toda a troca de mensagens e arquivos roda internamente via Baileys (`@whiskeysockets/baileys`).

## Como funciona

- Envio de texto/imagem: `src/services/whatsapp.js` (`sendMessage`, `sendImage`)
- Recebimento de áudio/imagem: listener `messages.upsert` do Baileys
- Download da mídia recebida: `downloadMediaMessage` (Baileys)

## Fluxo de mídia recebida

1. Mensagem chega no socket Baileys.
2. O payload interno é roteado para `src/services/inbound-core.js`.
3. A mídia é baixada e salva em `RUNS_DIR/<taskId>/inbox/<messageId>/`.
4. Áudio é transcrito (OpenAI Whisper) e imagem é descrita (OpenRouter multimodal).
5. O resultado vira texto canônico para o orquestrador.

## Observação

O endpoint HTTP `/webhook` continua disponível apenas para compatibilidade, mas o modo recomendado é standalone via Baileys.
