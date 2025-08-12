# Chatter

Chatter is a two-way RPC system built on Bun websockets. Define your remote procedures in a central location, implement them on either the client or the server, and call them from the other side with full TypeScript support.

Type inference and validation is based on [Standard Schema](https://standardschema.dev/), so your schemas can come from any library you prefer.

---

## Installation

First, install Chatter and your schema library of choice.

```bash
# With Zod (recommended)
npm install @manyducks.co/chatter zod

# Or with Valibot
npm install @manyducks.co/chatter valibot
```

---

## Quick Start

### 1\. Define a Procedure

Create a shared file to define your procedures. By convention, procedures are named in `SCREAMING_SNAKE_CASE`.

```typescript
// src/procedures.ts
import { createProc } from "@manyducks.co/chatter";
import { z } from "zod";

export const GREET = createProc({
  name: "greet", // A unique name
  takes: z.string(), // What you pass to the function when calling it
  returns: z.string(), // What the function returns
});
```

### 2\. Implement on the Server

Create a Bun server and implement the `GREET` procedure.

```typescript
// src/server.ts
import { createServer } from "@manyducks.co/chatter";
import { GREET } from "./procedures";

const chatter = createServer();

// Implement the GREET procedure
chatter.on(GREET, async (name) => {
  console.log(`Received greeting for: ${name}`);
  return `Hello ${name}. This message is from the server!`;
});

// Start the Bun server
Bun.serve({
  port: 3000,
  fetch(req, server) {
    if (server.upgrade(req)) {
      return; // Bun handles the response
    }
    return new Response("Upgrade failed :(", { status: 500 });
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
import { createClient, ConnectionState } from "@manyducks.co/chatter";
import { GREET } from "./procedures";

const client = createClient({
  url: "ws://localhost:3000",
});

client.onStateChange(async (state) => {
  if (state === ConnectionState.Online) {
    // Once connected, call the server's procedure
    const response = await client.call(GREET, "World");
    console.log("Server responded:", response);
    // -> Server responded: Hello World. This message is from the server!
  }
});
```

---

[That's a lot of ducks.](https://www.manyducks.co)
