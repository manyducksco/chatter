# Chatter

A fast, two-way RPC system built on Bun WebSockets.

## How it Works

Chatter simplifies WebSockets by making it feel like you're calling local functions. You **define a procedure** in a shared file. This is like creating a function signature—it specifies the name, what data it takes, and what it returns. You can then **implement this procedure** on either the client, the server, or both. Chatter handles all the complex network communication for you behind the scenes. You can just call an async function. It runs the implementation on the other end of the line and returns a response.

Because this is a two-way system, both the client and the server can call procedures on the other. This allows you to build real-time apps where the server can push updates to the client, and the client can call functions on the server.

## Installation

```
bun install @manyducks.co/chatter
```

You will also need to install your preferred schema library. Chatter uses [Standard Schema](https://standardschema.dev/), meaning it's compatible with any validation library compatible with those types. We test and use Chatter with [Zod](https://zod.dev/), but [Valibot](https://valibot.dev/), [ArkType](https://arktype.io/), [Yup](https://github.com/jquense/yup), [Joi](https://github.com/hapijs/joi) and many others should work too.

```
bun install zod
bun install valibot
...
```

## Live Counter Example

This example shows how to set up a realtime counter. Clients can connect to the server and alter the counter's value. All connected users will see the number change in real time.

### 1. Define a Procedure

Create a shared file to define your procedures. By convention, procedures are named in `SCREAMING_SNAKE_CASE`.

```ts
// src/procedures.ts
import { createProc } from "@manyducks.co/chatter";
import { z } from "zod";

export const GET_COUNT = createProc({
  name: "get_count",
  returns: z.number(), // what the function returns
  // this proc doesn't take anything, so there is no 'takes' schema.
});

export const UPDATE_COUNT = createProc({
  name: "update_count",
  takes: z.number(), // what you pass to the function when calling it
  // this proc doesn't return anything, so there is no 'returns' schema.
});
```

### 2. Set up the Server

Create a Bun server and implement the three procedures.

```ts
// src/server.ts
import { createServer } from "@manyducks.co/chatter";
import { GET_VALUE, INCREMENT, DECREMENT } from "./procedures";

const chatter = createServer();

// We'll store the current value in memory on the server.
let currentValue = 0;

// GET_COUNT simply returns the current value to the caller.
// The first argument is the `takes` value, which is _ since we aren't taking anything.
// The second argument is a connection to the client who called this procedure.
chatter.on(GET_COUNT, (_, connection) => {
  return currentValue;
});

chatter.on(UPDATE_COUNT, (amount, connection) => {
  // Update the stored value.
  currentValue += amount;

  // Broadcast the same event to every other connected client to keep them in sync.
  // Client and server both implement the same procedure.
  connection.broadcast(UPDATE_COUNT, amount);
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

### 3. Call from the Client

Finally, create a client that connects to the server and calls the procedure.

```ts
// src/client.ts
import { createClient } from "@manyducks.co/chatter";
import { GET_COUNT, UPDATE_COUNT } from "./procedures";

const chatter = createClient({
  url: "ws://localhost:3000",
});

let currentValue = 0;

// The client implements UPDATE_COUNT so the server can broadcast changes by other users.
chatter.on(UPDATE_COUNT, (amount, connection) => {
  currentValue += amount;
});

// Load current value from server as soon as we connect.
chatter.onStateChange(async () => {
  if (chatter.isConnected) {
    currentValue = await chatter.call(GET_COUNT);
  }
});

// Implement some methods the UI will use to change the value.
// We simultaneously update our local state and let the server know so it can update other clients.
async function increment(amount = 1) {
  currentValue += amount;
  await chatter.call(UPDATE_COUNT, amount);
}

async function decrement(amount = 1) {
  currentValue -= amount;
  await chatter.call(UPDATE_COUNT, -amount);
}
```

## API

### `createProc(options)`

Creates a new remote procedure. This function defines the procedure's signature and name, but the actual implementation needs to be handled separately on the client and/or server using `chatter.on()`.

**Parameters:**

- `options`: An object with the following properties:
  - `name`: A string that uniquely identifies the procedure.
  - `takes` (optional): The schema for the data passed to the procedure. If not passed, `null` will be substituted.
  - `returns` (optional): The schema for the data returned from the procedure. If not passed, `null` will be substituted.

**Example:**

```ts
import { createProc } from "@manyducks.co/chatter";
import { z } from "zod";

export const ADD_NUMBERS = createProc({
  name: "add_numbers",
  takes: z.object({ a: z.number(), b: z.number() }),
  returns: z.number(),
});

export const GREET_USER = createProc({
  name: "greet_user",
  takes: z.object({ name: z.string() }),
  // `returns` is not needed if the function does not return a value
});
```

---

### Client API

#### `createClient(options)`

Initializes the client-side Chatter instance.

**Parameters:**

- `options`: An object with the following properties:
  - `url`: The Chatter server URL.
  - `verbose` (optional): Set to `true` to enable extra logging.
  - `pingInterval` (optional): The number of seconds to wait before sending a ping message. Pings are used to keep the connection alive. The default is 30 seconds.

**Example:**

```ts
import { createClient } from "@manyducks.co/chatter";

const client = createClient({
  url: "ws://localhost:3000",
  verbose: true, // Enable debug logging
  pingInterval: 15, // Send a ping every 15 seconds
});
```

**Returns:** A `ChatterClient` instance.

### Properties

#### `client.state`

The current connection state. This is an enum called `ConnectionState`. Possible values are `Disconnected`, `Connecting`, and `Connected`.

#### `client.isConnected`

`true` if the socket is open and ready. Shorthand for `client.state === ConnectionState.Connected`.

#### `client.clientId`

A persistent, unique UUID for the client, stored in local storage.

#### `client.sessionId`

An ephemeral UUID to identify this particular session. Stored in memory and regenerated if the page is reloaded.

### Methods

#### `client.onStateChange(callback)`

Registers a function to be called when the connection state changes. Returns a function to unsubscribe the callback.

**Example:**

```ts
client.onStateChange((state) => {
  if (state === ConnectionState.Connected) {
    console.log("Connected to the server\!");
  } else if (state === ConnectionState.Disconnected) {
    console.log("Disconnected from the server.");
  }
});
```

#### `client.on(proc, handler)`

Registers a handler to be called when a procedure is invoked on this side of the connection.

**Parameters:**

- `proc`: The procedure created with `createProc`.
- `handler`: A function that receives the incoming data and the connection object.

**Example:**

```ts
import { GREET_USER } from "./procedures";

client.on(GREET_USER, (name) => {
  console.log(`Hello, ${name}!`);
});
```

#### `client.call(proc, data)`

Calls a procedure on the server and returns its response.

**Parameters:**

- `proc`: The procedure created with `createProc`.
- `data`: The data to send, which must match the procedure's `takes` schema.

**Returns:** A `Promise` that resolves with the procedure's return value.

**Example:**

```ts
const sum = await client.call(ADD_NUMBERS, { a: 5, b: 10 });
console.log(`The sum is ${sum}`); // The sum is 15
```

---

### Server API

#### `createServer(options?)`

Initializes the server-side Chatter instance.

**Parameters:**

- `options` (optional): An object with the following properties:
  - `getConnectionData`: A function that runs after a client connects. The return value is added as the `data` field to the connection object.
  - `onOpen`: A function that runs after a connection is initialized, but before it starts receiving events.
  - `onClose`: A function that runs after a connection is closed.

**Example:**

```ts
import { createServer } from "@manyducks.co/chatter";

const server = createServer({
  onOpen: (connection) => {
    console.log(`Connection opened with client ${connection.clientId}`);
  },
  onClose: (connection, code, reason) => {
    console.log(`Connection closed with client ${connection.clientId}`);
  },
  getConnectionData: async (info) => {
    // This is where you would fetch data for the client, e.g., from a database.
    // The resulting data is stored on the connection's `data` object.
    const userData = {
      username: "user" + Math.floor(Math.random() * 100),
    };
    return userData;
  },
});
```

**Returns:** A `ChatterServer` instance.

### Methods

#### `server.on(proc, handler)`

Registers a handler to be called when a procedure is invoked on this side of the connection.

**Example:**

```ts
import { ADD_NUMBERS } from "./procedures";

server.on(ADD_NUMBERS, (data) => {
  return data.a + data.b;
});
```

#### `server.broadcast(topics, proc, input?, options?)`

Calls a procedure on all clients subscribed to a given topic or set of topics.

**Parameters:**

- `topics`: A string or iterable of strings representing the topics to broadcast to.
- `proc`: The procedure to call.
- `input` (optional): The data to send. Must match the procedure's `takes` schema.
- `options` (optional): An object that can specify a list of connections to exclude from the broadcast.

**Example:**

```ts
// Broadcast a welcome message to all clients in the "general" chat
server.broadcast("general", SEND_MESSAGE, { text: "Hello everyone!" });
```

#### `server.find(where)`

Finds the first connection that matches the given criteria.

**Parameters:**

- `where`: A function that takes a connection object and returns a truthy value for a match.

**Returns:** A `ServerConnection` instance or `undefined`.

**Example:**

```ts
const user = server.find((conn) => conn.data.username === "user123");

user.call(GREET_USER, "user123");
```

#### `server.filter(where)`

Finds all connections that match the given criteria.

**Parameters:**

- `where`: A function that takes a connection object and returns a truthy value for a match.

**Returns:** An array of `ServerConnection` instances.

**Example:**

```ts
const loggedInUsers = server.filter((conn) => conn.data.isLoggedIn);
console.log(`Found ${loggedInUsers.length} logged in users.`);
```

---

### Server Connection API

The `connection` object is the second argument passed to a procedure handler function. This object represents an open socket connection to a single client. This section details the methods and properties available on that object.

**Example:**

```ts
server.on(MY_PROCEDURE, (data, connection) => {
  // `connection` is the object with the methods listed below
  connection.subscribe("some-topic");
});
```

### Properties

#### `connection.data`

Custom data associated with the connection. This data is set in the `getConnectionData` function of the `createServer` options.

### Methods

#### `connection.call(proc, data)`

Calls a procedure on the client and returns its response.

**Parameters:**

- `proc`: The procedure created with `createProc`.
- `data`: The data to send, which must match the procedure's `takes` schema.

**Returns:** A `Promise` that resolves with the procedure's return value.

**Example:**

```ts
// Send a message to a client and wait for a response
const response = await connection.call(GREET_USER, "Bob");
console.log(response);
```

#### `connection.broadcast(topics, proc, input?, options?)`

Calls a procedure on all clients subscribed to a given topic or set of topics. By default, this connection is excluded.

**Parameters:**

- `topics`: A string or iterable of strings representing the topics to broadcast to.
- `proc`: The procedure to call.
- `input` (optional): The data to send.
- `options` (optional): An object that can specify if this connection should be included in the broadcast.

**Example:**

```ts
// Broadcast a message to all other clients subscribed to the same topic
connection.broadcast("chat-room", CHAT_MESSAGE, { text: "Hello!" });
```

#### `connection.subscribe(topic)`

Subscribes this connection to a topic.

**Parameters:**

- `topic`: The topic to subscribe to.

**Example:**

```ts
connection.subscribe("chat-room-1");
```

#### `connection.unsubscribe(topic)`

Unsubscribes this connection from a topic.

**Parameters:**

- `topic`: The topic to unsubscribe from.

**Example:**

```ts
connection.unsubscribe("chat-room-1");
```

#### `connection.isSubscribed(topic)`

Checks if the connection is subscribed to a topic.

**Parameters:**

- `topic`: The topic to check.

**Returns:** A boolean.

**Example:**

```ts
if (connection.isSubscribed("chat-room-1")) {
  // This user will get broadcasts for "chat-room-1"
}
```

---

[That's a lot of ducks.](https://www.manyducks.co)
