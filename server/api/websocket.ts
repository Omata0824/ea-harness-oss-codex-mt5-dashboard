import type http from "node:http";
import { WebSocketServer } from "ws";

export class WebSocketHub {
  readonly wss: WebSocketServer;

  constructor(server: http.Server) {
    this.wss = new WebSocketServer({ server, path: "/ws" });
  }

  broadcast(event: string, payload: unknown): void {
    const message = JSON.stringify({ event, payload });
    for (const client of this.wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(message);
      }
    }
  }
}
