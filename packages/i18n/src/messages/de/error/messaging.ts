import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/messaging";

export const messages = {
  "error.messaging.notConnected": "Dieser Slack-Arbeitsbereich ist nicht verbunden.",
  "error.messaging.unsupported": "Dieser Computer kann keine Verbindung zu Slack herstellen.",
  "error.messaging.relayUnavailable":
    "OpenBot kann auf diesem Computer keine Slack-Ereignisse empfangen. Melde dich an, gib diesem Computer einen Namen und versuche es erneut.",
  "error.messaging.discordNotConnected": "Dieser Discord-Server ist nicht verbunden.",
  "error.messaging.discordUnsupported": "Dieser Computer kann keine Verbindung zu Discord herstellen.",
  "error.messaging.discordRelayUnavailable":
    "OpenBot kann auf diesem Computer keine Discord-Ereignisse empfangen. Melde dich an, gib diesem Computer einen Namen und versuche es erneut.",
  "error.messaging.discordRolesUnsupported":
    "OpenBot kann die Discord-Rollen noch nicht auflisten. Versuche es später noch einmal.",
  "error.messaging.telegramNotConnected": "Dieser Telegram-Chat ist nicht verbunden.",
  "error.messaging.telegramUnsupported": "Dieser Computer kann keine Verbindung zu Telegram herstellen.",
  "error.messaging.telegramRelayUnavailable":
    "OpenBot kann Telegram auf diesem Computer nicht erreichen. Melde dich an, gib diesem Computer einen Namen und versuche es erneut.",
  "error.messaging.telegramRelayUnreachable":
    "OpenBot kann von diesem Computer aus keine Verbindung zu seinem Dienst herstellen. Prüfe die Internetverbindung, das VPN, den Proxy oder die Firewall und versuche es erneut.",
  "error.messaging.telegramServiceUnavailable":
    "OpenBot kann Telegram gerade nicht verbinden. Versuche es später erneut.",
  "error.messaging.whatsappNotConnected": "Diese WhatsApp-Nummer ist nicht verbunden.",
  "error.messaging.whatsappUnsupported": "Dieser Computer kann keine Verbindung zu WhatsApp herstellen.",
  "error.messaging.whatsappTooManySenders": "Eine WhatsApp-Nummer kann bis zu 200 Kontakte und Gruppen zulassen.",
  "error.messaging.whatsappNumberNotFound":
    "Diese Nummer hat kein WhatsApp-Konto. Gib sie mit der Ländervorwahl ein, zum Beispiel +44 7700 900123.",
  "error.messaging.whatsappSenderNotFound": "Dieser Kontakt oder diese Gruppe ist nicht mehr in der Liste.",
  "error.messaging.whatsappRequestEnded":
    "Diese Anfrage ist beendet. Bitte die Person, erneut zu schreiben, um einen neuen Code zu bekommen.",
  "error.messaging.lineNotConnected": "Dieses LINE-Konto ist nicht verbunden.",
  "error.messaging.lineUnsupported": "Dieser Computer kann keine Verbindung zu LINE herstellen.",
  "error.messaging.lineInvalidToken":
    "LINE hat das Channel access token nicht akzeptiert. Kopiere es erneut aus der LINE Developers Console.",
  "error.messaging.lineUnreachable":
    "OpenBot kann LINE gerade nicht erreichen. Prüfe die Internetverbindung und versuche es erneut.",
  "error.messaging.lineTooManySenders": "Ein LINE-Konto kann bis zu 200 Personen zulassen.",
  "error.messaging.lineRequestEnded": "Diese Anfrage ist beendet. Bitte die Person, erneut zu schreiben.",
  "error.messaging.linePublicUrlInvalid":
    "Gib eine Adresse ein, die mit https:// beginnt, zum Beispiel https://example.com.",
  "error.messaging.memoryLimit":
    "Ein verbundener Arbeitsbereich kann bis zu {limit} Erinnerungen haben. Lösche zuerst eine.",
} as const satisfies PartialTranslation<typeof source>;
