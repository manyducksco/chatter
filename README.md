# Chatter

Chatter is a two-way RPC system built on Bun websockets. You implement procedures (remote functions), then call those functions from the other end of a websocket connection. Once the socket conection is established the server can call the client's procedures and the client can call the server's procedures.

Type inference and validation is handled with Zod.

```js
// ... in schema.js ...

import { createSchema } from "@manyducks.co/chatter";
import { z } from "zod";

// Client and server share one schema where all procedures are defined.
export const schema = createSchema({
  server: {
    // The server will implement these procedures for the client to call
    joinRoom: {
      input: z.object({
        roomId: z.string(),
        username: z.string(),
      }),
    },
    sendMessage: {
      input: z.object({
        roomId: z.string(),
        message: z.string(),
      }),
    },
  },
  client: {
    // The client will implement these procedures for the server to call
    receiveMessage: {
      roomId: z.string(),
      username: z.string(),
      message: z.string(),
    },
  },
});

// ... in server.js ...

import { createServer } from "@manyducks.co/chatter";
import { schema } from "./schema.js";

// The server implements the server procedures.
const server = createServer({
  schema,
  procedures: {
    joinRoom(input, client) {
      client.subscribe(input.roomId);
      client.set("username", input.username);
    },
    sendMessage(input, client) {
      client.publish(input.roomId, "receiveMessage", {
        roomId: input.roomId,
        username: client.get("username"),
        message: input.message,
      });
    },
  },
});

// Bun.serve handles the websocket upgrade with the server acting as a websocket handler.
Bun.serve({
  fetch(req) {
    // upgrade the request to a WebSocket
    if (server.upgrade(req)) {
      return; // do not return a Response
    }
    return new Response("Upgrade failed", { status: 500 });
  },
  websocket: server.handler,
  port: 5000,
});

// ... in client.js ...

import { createClient } from "@manyducks.co/chatter";
import { schema } from "./schema.js";

const socket = createClient({
  url: "ws://localhost:5000",
  schema,
  procedures: {
    // ... client procedures ...
  },
});

// Call a server procedure from the client. Resolves to whatever the procedure returned on the server side.
const message = await socket.call("joinRoom", {
  roomId: 1,
  username: "schwingbat",
});
```
