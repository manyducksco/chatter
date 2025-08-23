# Chatter

Chatter is a two-way RPC system built on Bun websockets. Define your remote procedures in a central location, implement them on either the client or the server, and call them from the other side with full TypeScript support.

Type inference and validation is based on [Standard Schema](https://standardschema.dev/), so your schemas can come from any library you prefer.

---

## Installation

First, install Chatter and your schema library of choice.

```bash
# With Zod (recommended)
npm install @manyducks.co/chatter zod

# Or with Valibot, for example
npm install @manyducks.co/chatter valibot
```

---

## Quick Start

Here's an example. We'll define a single procedure and implement it on both client and server. Both implementations will simply take the message it received, wait one second, and send it back. The client and server will continue doing this in an infinite loop.

### 1\. Define a procedure

Create a shared file to define your procedures. By convention, procedures are named in `SCREAMING_SNAKE_CASE`.

```typescript
// src/procedures.ts
import { createProc } from "@manyducks.co/chatter";
import { z } from "zod";

export const REPEAT = createProc({
  name: "repeat", // A unique name

  // What you pass to the function when calling it
  takes: z.object({ message: z.string(), forwards: z.number() }),

  // What the function returns
  returns: z.string(),
});
```

### 2\. Set up the server

Create a Bun server and implement the `GREET` procedure.

```typescript
// src/server.ts
import { createServer } from "@manyducks.co/chatter";
import { REPEAT } from "./procedures";

const chatter = createServer();

// Implement the server's version:
chatter.on(REPEAT, (data, connection) => {
  console.log(`REPEAT #${data.forwards}: ${data.message}`);

  setTimeout(() => {
    connection.call(REPEAT, {
      message: data.message,
      forwards: data.forwards + 1,
    });
  }, 1000);
});

// Start the Bun server
Bun.serve({
  port: 3000,
  fetch(req, server) {
    if (!server.upgrade(req)) {
      return new Response("Upgrade failed :(", { status: 500 });
    }
  },
  // Chatter handles the websockets
  websocket: chatter.websocket,
});

console.log("Chatter server listening on port 3000");
```

### 3\. Call from the Client

Finally, create a client that connects to the server and calls the procedure.

```typescript
// src/client.ts
import { createClient } from "@manyducks.co/chatter";
import { GREET } from "./procedures";

const client = createClient({
  url: "ws://localhost:3000",
});

// Implement the client's version:
chatter.on(REPEAT, (data, connection) => {
  console.log(`REPEAT #${data.forwards}: ${data.message}`);

  setTimeout(() => {
    connection.call(REPEAT, {
      message: data.message,
      forwards: data.forwards + 1,
    });
  }, 1000);
});

client.onStateChange(async () => {
  if (client.isConnected) {
    // Once connected, call the server's procedure
    client.call(GREET, { message: "", forwards: 0 });
  }
});
```

---

[That's a lot of ducks.](https://www.manyducks.co)
