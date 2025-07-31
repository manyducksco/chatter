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
    // greet: {
    //   input: z.object({
    //     name: z.string(),
    //   }),
    //   output: z.string(),
    // },
  },
  client: {
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
    joinRoom(client, input) {
      client.subscribe(input.roomId);
      client.set("username", input.username);
    },
    sendMessage(client, input) {
      client.publish(input.roomId, "receiveMessage", {
        roomId: input.roomId,
        username: client.get("username"),
        message: input.message,
      });
    },
    // greet(client, input) {
    //   return `Hello ${input.name}!`;
    // },
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

const client = createClient({
  url: "ws://localhost:5000",
  schema,
  procedures: {
    // ... client procedures ...
  },
});

// Call a server procedure from the client.
const message = await client.call("greet", { name: "World" });
console.log(message); // "Hello World!"
```
