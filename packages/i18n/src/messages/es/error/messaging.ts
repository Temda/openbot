import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/messaging";

export const messages = {
  "error.messaging.notConnected": "Este espacio de trabajo de Slack no está conectado.",
  "error.messaging.unsupported": "Este equipo no puede conectarse a Slack.",
  "error.messaging.relayUnavailable":
    "OpenBot no puede recibir eventos de Slack en este equipo. Inicia sesión, ponle un nombre a este equipo e inténtalo de nuevo.",
  "error.messaging.discordNotConnected": "Este servidor de Discord no está conectado.",
  "error.messaging.discordUnsupported": "Este equipo no puede conectarse a Discord.",
  "error.messaging.discordRelayUnavailable":
    "OpenBot no puede recibir eventos de Discord en este equipo. Inicia sesión, ponle un nombre a este equipo e inténtalo de nuevo.",
  "error.messaging.discordRolesUnsupported":
    "OpenBot todavía no puede mostrar los roles de Discord. Inténtalo más tarde.",
  "error.messaging.telegramNotConnected": "Este chat de Telegram no está conectado.",
  "error.messaging.telegramUnsupported": "Este equipo no puede conectarse a Telegram.",
  "error.messaging.telegramRelayUnavailable":
    "OpenBot no puede acceder a Telegram en este equipo. Inicia sesión, ponle un nombre a este equipo e inténtalo de nuevo.",
  "error.messaging.telegramRelayUnreachable":
    "OpenBot no puede conectarse a su servicio desde este equipo. Comprueba la conexión a internet, la VPN, el proxy o el cortafuegos, y vuelve a intentarlo.",
  "error.messaging.telegramServiceUnavailable":
    "OpenBot no puede conectar Telegram ahora. Inténtalo de nuevo más tarde.",
  "error.messaging.whatsappNotConnected": "Este número de WhatsApp no está conectado.",
  "error.messaging.whatsappUnsupported": "Este equipo no puede conectarse a WhatsApp.",
  "error.messaging.whatsappTooManySenders": "Un número de WhatsApp puede permitir hasta 200 contactos y grupos.",
  "error.messaging.whatsappNumberNotFound":
    "Este número no tiene cuenta de WhatsApp. Escríbelo con el código de país, como +44 7700 900123.",
  "error.messaging.whatsappSenderNotFound": "Este contacto o grupo ya no está en la lista.",
  "error.messaging.whatsappRequestEnded":
    "Esta solicitud terminó. Pide a la persona que vuelva a escribir para obtener un código nuevo.",
  "error.messaging.lineNotConnected": "Esta cuenta de LINE no está conectada.",
  "error.messaging.lineUnsupported": "Este equipo no puede conectarse a LINE.",
  "error.messaging.lineInvalidToken":
    "LINE no aceptó el Channel access token. Cópialo de nuevo desde la LINE Developers Console.",
  "error.messaging.lineUnreachable":
    "OpenBot no puede conectar con LINE ahora. Comprueba la conexión a internet e inténtalo de nuevo.",
  "error.messaging.lineTooManySenders": "Una cuenta de LINE puede permitir hasta 200 personas.",
  "error.messaging.lineRequestEnded": "Esta solicitud terminó. Pide a la persona que vuelva a escribir.",
  "error.messaging.linePublicUrlInvalid": "Escribe una dirección que empiece por https://, como https://example.com.",
  "error.messaging.memoryLimit":
    "Un espacio de trabajo conectado puede tener hasta {limit} recuerdos. Borra uno primero.",
} as const satisfies PartialTranslation<typeof source>;
